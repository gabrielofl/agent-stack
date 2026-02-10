#!/usr/bin/env bash
set -euo pipefail

MODEL_PATH="${MODEL_PATH:-/models/Phi-3-mini-4k-instruct-q4.gguf}"
MODEL_URL="${MODEL_URL:-}"
CTX_SIZE="${CTX_SIZE:-2048}"

STATUS_FILE="${LLM_STATUS_FILE:-/tmp/llm_status.json}"
LOG_FILE="${LLM_BOOT_LOG_FILE:-/tmp/llm_boot.log}"

mkdir -p /models
mkdir -p "$(dirname "$STATUS_FILE")"

# Mirror all script output into a file while still printing to container logs
exec > >(tee -a "$LOG_FILE") 2>&1

now_ms() { date +%s%3N 2>/dev/null || python - <<'PY'
import time; print(int(time.time()*1000))
PY
}

write_status() {
  local phase="$1"
  local message="$2"
  local extra="${3:-}"
  local ts
  ts="$(now_ms)"

  # write temp then mv for atomic update
  local tmp="${STATUS_FILE}.tmp"
  cat > "$tmp" <<EOF
{
  "ok": $( [[ "$phase" == "ready" ]] && echo "true" || echo "false" ),
  "phase": "$(printf '%s' "$phase" | sed 's/"/\\"/g')",
  "message": "$(printf '%s' "$message" | sed 's/"/\\"/g')",
  "ts": $ts,
  "modelPath": "$(printf '%s' "$MODEL_PATH" | sed 's/"/\\"/g')",
  "ctxSize": $CTX_SIZE
  ${extra:+, $extra}
}
EOF
  mv "$tmp" "$STATUS_FILE"
}

write_status "boot" "container booting"

echo "MODEL_PATH=$MODEL_PATH"
echo "CTX_SIZE=$CTX_SIZE"
ls -lh /models || true

if [ ! -f "$MODEL_PATH" ]; then
  if [ -z "$MODEL_URL" ]; then
    write_status "error" "model missing and MODEL_URL not set" "\"error\":\"model_missing\""
    echo "Model not found at $MODEL_PATH and MODEL_URL not set."
    exit 1
  fi
  write_status "downloading" "downloading model" "\"modelUrlSet\":true"
  echo "Downloading model to $MODEL_PATH ..."
  curl -L "$MODEL_URL" -o "$MODEL_PATH"
fi

# quick sanity: size
MODEL_BYTES="$(stat -c%s "$MODEL_PATH" 2>/dev/null || wc -c < "$MODEL_PATH" || echo 0)"
write_status "model_ok" "model present" "\"modelBytes\":$MODEL_BYTES"

echo "Starting llama-server..."
write_status "starting_llama" "starting llama-server" "\"llamaPort\":8080"

# run llama; keep logs in container output (already tee'd)
# if you later want llama logs separately, redirect just llama output to another file
/app/llama-server -m "$MODEL_PATH" --host 0.0.0.0 --port 8080 --ctx-size "$CTX_SIZE" &
MODEL_PID=$!

sleep 1
if ! kill -0 "$MODEL_PID" 2>/dev/null; then
  write_status "error" "llama-server crashed immediately" "\"error\":\"llama_crash_immediate\""
  echo "llama-server crashed immediately."
  exit 1
fi

write_status "llama_started" "llama-server process started" "\"llamaPid\":$MODEL_PID"

cleanup() {
  echo "Stopping llama-server (pid=$MODEL_PID)..."
  write_status "stopping" "stopping llama-server" "\"llamaPid\":$MODEL_PID"
  kill "$MODEL_PID" 2>/dev/null || true
  wait "$MODEL_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

(
  echo "Waiting for llama-server to be ready..."
  write_status "waiting_ready" "waiting for /health"

  for i in {1..300}; do
    if curl -sf "http://127.0.0.1:8080/health" >/dev/null 2>&1; then
      echo "llama-server is up."
      write_status "ready" "llama-server is healthy" "\"healthUrl\":\"http://127.0.0.1:8080/health\""
      exit 0
    fi
    if ! kill -0 "$MODEL_PID" 2>/dev/null; then
      write_status "error" "llama-server died while waiting for readiness" "\"error\":\"llama_died_during_ready\""
      exit 1
    fi
    sleep 1
  done

  echo "llama-server did not become ready in time."
  write_status "error" "llama-server readiness timeout" "\"error\":\"ready_timeout\",\"timeoutSec\":300"
  kill "$MODEL_PID" 2>/dev/null || true
  exit 1
) &

echo "Starting worker API..."
write_status "starting_api" "starting Node worker API"
exec node src/index.js
