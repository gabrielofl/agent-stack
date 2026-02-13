#!/usr/bin/env bash
set -euo pipefail

MODEL_PATH="${MODEL_PATH:-/models/Phi-3-mini-4k-instruct-q4.gguf}"
MODEL_URL="${MODEL_URL:-}"
CTX_SIZE="${CTX_SIZE:-2048}"

STATUS_FILE="${LLM_STATUS_FILE:-/tmp/llm_status.json}"
LOG_FILE="${LLM_BOOT_LOG_FILE:-/tmp/llm_boot.log}"

LLAMA_HOST="${LLAMA_HOST:-0.0.0.0}"
LLAMA_PORT="${LLAMA_PORT:-8080}"
LLAMA_BASE_INTERNAL="${LLAMA_BASE_INTERNAL:-http://localhost:${LLAMA_PORT}}"

POLL_INTERVAL_SEC="${POLL_INTERVAL_SEC:-5}"
READY_TIMEOUT_SEC="${READY_TIMEOUT_SEC:-900}"

NODE_PORT="${NODE_PORT:-4000}"

mkdir -p /models
mkdir -p "$(dirname "$STATUS_FILE")"

# Mirror all script output into a file while still printing to container logs
exec > >(tee -a "$LOG_FILE") 2>&1

now_ms() {
  date +%s%3N 2>/dev/null || python - <<'PY'
import time; print(int(time.time()*1000))
PY
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\r/\\r/g; s/\n/\\n/g'
}

write_status() {
  local phase="$1"
  local message="$2"
  local extra="${3:-}"
  local ts
  ts="$(now_ms)"

  local tmp="${STATUS_FILE}.tmp"
  cat > "$tmp" <<EOF
{
  "ok": $( [[ "$phase" == "ready" ]] && echo "true" || echo "false" ),
  "phase": "$(json_escape "$phase")",
  "message": "$(json_escape "$message")",
  "ts": $ts,
  "modelPath": "$(json_escape "$MODEL_PATH")",
  "ctxSize": $CTX_SIZE,
  "llamaBaseInternal": "$(json_escape "$LLAMA_BASE_INTERNAL")",
  "llamaHost": "$(json_escape "$LLAMA_HOST")",
  "llamaPort": $LLAMA_PORT
  ${extra:+, $extra}
}
EOF
  mv "$tmp" "$STATUS_FILE"
}

log_banner() {
  echo "============================================================"
  echo "$@"
  echo "============================================================"
}

write_status "boot" "container booting"

log_banner "BOOT"
echo "MODEL_PATH=$MODEL_PATH"
echo "MODEL_URL=${MODEL_URL:+(set)}"
echo "CTX_SIZE=$CTX_SIZE"
echo "STATUS_FILE=$STATUS_FILE"
echo "LOG_FILE=$LOG_FILE"
echo "LLAMA_BASE_INTERNAL=$LLAMA_BASE_INTERNAL"
echo "POLL_INTERVAL_SEC=$POLL_INTERVAL_SEC"
echo "READY_TIMEOUT_SEC=$READY_TIMEOUT_SEC"
ls -lh /models || true

# -----------------------
# Start worker API (Node) IMMEDIATELY
# -----------------------
log_banner "STARTING WORKER API (IMMEDIATE)"
write_status "starting_api" "starting Node worker API (llama may still be loading)" "\"nodePort\":$NODE_PORT"
node src/index.js &
NODE_PID=$!
echo "node pid=$NODE_PID"

# -----------------------
# Ensure model is present
# -----------------------
if [ ! -f "$MODEL_PATH" ]; then
  if [ -z "$MODEL_URL" ]; then
    write_status "error" "model missing and MODEL_URL not set" "\"error\":\"model_missing\""
    echo "ERROR: Model not found at $MODEL_PATH and MODEL_URL not set."
    # stop node too
    kill "$NODE_PID" 2>/dev/null || true
    exit 1
  fi

  write_status "downloading" "downloading model" "\"modelUrlSet\":true"
  log_banner "DOWNLOADING MODEL"
  echo "Downloading model to $MODEL_PATH ..."
  curl -L "$MODEL_URL" -o "$MODEL_PATH"
fi

MODEL_BYTES="$(stat -c%s "$MODEL_PATH" 2>/dev/null || wc -c < "$MODEL_PATH" || echo 0)"
write_status "model_ok" "model present" "\"modelBytes\":$MODEL_BYTES"
echo "Model present: bytes=$MODEL_BYTES"

# -----------------------
# Start llama-server
# -----------------------
log_banner "STARTING LLAMA-SERVER"
write_status "starting_llama" "starting llama-server" "\"llamaPort\":$LLAMA_PORT"

# Run llama; logs go to stdout (tee'd already)
#/app/llama-server -m "$MODEL_PATH" --host "$LLAMA_HOST" --port "$LLAMA_PORT" --ctx-size "$CTX_SIZE" --no-repack &
/app/llama-server -m "$MODEL_PATH" --host "$LLAMA_HOST" --port "$LLAMA_PORT" --ctx-size "$CTX_SIZE" &
MODEL_PID=$!

sleep 1
if ! kill -0 "$MODEL_PID" 2>/dev/null; then
  write_status "error" "llama-server crashed immediately" "\"error\":\"llama_crash_immediate\""
  echo "ERROR: llama-server crashed immediately."
  kill "$NODE_PID" 2>/dev/null || true
  exit 1
fi

write_status "llama_started" "llama-server process started" "\"llamaPid\":$MODEL_PID"
echo "llama-server pid=$MODEL_PID"

cleanup() {
  echo "Stopping processes..."
  write_status "stopping" "stopping services" "\"llamaPid\":${MODEL_PID:-0},\"nodePid\":${NODE_PID:-0}"
  kill "$NODE_PID" 2>/dev/null || true
  kill "$MODEL_PID" 2>/dev/null || true
  wait "$NODE_PID" 2>/dev/null || true
  wait "$MODEL_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

probe_once() {
  local base="$LLAMA_BASE_INTERNAL"
  local out code

  code="$(curl -sS -o /dev/null -w "%{http_code}" --connect-timeout 2 --max-time 4 "$base/v1/models" 2>/dev/null || echo "curl_fail")"
  if [ "$code" != "curl_fail" ] && [ "$code" != "000" ]; then
    if [ "$code" = "200" ]; then echo "ok|200|/v1/models"; return 0; fi
    echo "err|$code|/v1/models"; return 0
  fi

  code="$(curl -sS -o /dev/null -w "%{http_code}" --connect-timeout 2 --max-time 4 "$base/health" 2>/dev/null || echo "curl_fail")"
  if [ "$code" != "curl_fail" ] && [ "$code" != "000" ]; then
    if [ "$code" = "200" ]; then echo "ok|200|/health"; return 0; fi
    echo "err|$code|/health"; return 0
  fi

  code="$(curl -sS -o /dev/null -w "%{http_code}" --connect-timeout 2 --max-time 4 "$base/" 2>/dev/null || echo "curl_fail")"
  if [ "$code" != "curl_fail" ] && [ "$code" != "000" ]; then
    if [ "$code" = "200" ]; then echo "ok|200|/"; return 0; fi
    echo "err|$code|/"; return 0
  fi

  out="$(curl -sS --connect-timeout 2 --max-time 4 "$base/v1/models" 2>&1 || true)"
  out="$(printf '%s' "$out" | head -c 240)"
  echo "err|curl|$(printf '%s' "$out")"
}

wait_for_llama_ready() {
  log_banner "WAITING FOR LLAMA READY (BACKGROUND)"
  write_status "waiting_ready" "waiting for llama-server readiness" "\"attempt\":0,\"elapsedSec\":0"

  local start_s attempt
  start_s="$(date +%s 2>/dev/null || python - <<'PY'
import time; print(int(time.time()))
PY
)"
  attempt=0

  while true; do
    attempt=$((attempt + 1))

    if ! kill -0 "$MODEL_PID" 2>/dev/null; then
      write_status "error" "llama-server died while waiting for readiness" "\"error\":\"llama_died_during_ready\",\"attempt\":$attempt"
      echo "ERROR: llama-server died while waiting for readiness"
      return 1
    fi

    local now_s elapsed
    now_s="$(date +%s 2>/dev/null || python - <<'PY'
import time; print(int(time.time()))
PY
)"
    elapsed=$((now_s - start_s))

    if [ "$READY_TIMEOUT_SEC" -gt 0 ] && [ "$elapsed" -ge "$READY_TIMEOUT_SEC" ]; then
      write_status "error" "llama-server readiness timeout" "\"error\":\"ready_timeout\",\"timeoutSec\":$READY_TIMEOUT_SEC,\"attempt\":$attempt,\"elapsedSec\":$elapsed"
      echo "ERROR: llama-server did not become ready in time (timeout=${READY_TIMEOUT_SEC}s)"
      kill "$MODEL_PID" 2>/dev/null || true
      return 1
    fi

    local res kind a b
    res="$(probe_once)"
    kind="$(printf '%s' "$res" | cut -d'|' -f1)"
    a="$(printf '%s' "$res" | cut -d'|' -f2)"
    b="$(printf '%s' "$res" | cut -d'|' -f3)"

    if [ "$kind" = "ok" ]; then
      echo "[READY] llama is up via $b (http $a) elapsed=${elapsed}s attempts=$attempt"
      write_status "ready" "llama-server is healthy" "\"baseUrl\":\"$LLAMA_BASE_INTERNAL\",\"attempt\":$attempt,\"elapsedSec\":$elapsed,\"readyEndpoint\":\"$(json_escape "$b")\",\"readyHttp\":$a,\"llamaPid\":$MODEL_PID"
      return 0
    fi

    if [[ "$a" =~ ^[0-9]+$ ]] && [ "$a" = "503" ]; then
      echo "[WAIT] llama responded 503 on $b (likely loading model) elapsed=${elapsed}s attempt=$attempt"
      write_status "waiting_ready" "llama loading (HTTP 503)" "\"attempt\":$attempt,\"elapsedSec\":$elapsed,\"lastHttp\":503,\"lastEndpoint\":\"$(json_escape "$b")\",\"llamaPid\":$MODEL_PID"
    elif [ "$a" = "curl" ]; then
      echo "[WAIT] llama not reachable yet (curl) err='${b}' elapsed=${elapsed}s attempt=$attempt"
      write_status "waiting_ready" "llama not reachable yet" "\"attempt\":$attempt,\"elapsedSec\":$elapsed,\"lastError\":\"$(json_escape "$b")\",\"llamaPid\":$MODEL_PID"
    else
      echo "[WAIT] llama responded http=$a on $b elapsed=${elapsed}s attempt=$attempt"
      write_status "waiting_ready" "llama not ready yet" "\"attempt\":$attempt,\"elapsedSec\":$elapsed,\"lastHttp\":$a,\"lastEndpoint\":\"$(json_escape "$b")\",\"llamaPid\":$MODEL_PID"
    fi

    sleep "$POLL_INTERVAL_SEC"
  done
}

# Run readiness watcher in background so Node serves immediately
wait_for_llama_ready &
READY_WATCHER_PID=$!

# Keep container alive by waiting on Node (PID 1 is bash)
wait "$NODE_PID"
