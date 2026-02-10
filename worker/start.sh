#!/usr/bin/env bash
set -euo pipefail

MODEL_PATH="${MODEL_PATH:-/models/Phi-3-mini-4k-instruct-q4.gguf}"
MODEL_URL="${MODEL_URL:-}"
CTX_SIZE="${CTX_SIZE:-2048}"

mkdir -p /models

if [ ! -f "$MODEL_PATH" ]; then
  if [ -z "$MODEL_URL" ]; then
    echo "Model not found at $MODEL_PATH and MODEL_URL not set."
    exit 1
  fi
  echo "Downloading model to $MODEL_PATH ..."
  curl -L "$MODEL_URL" -o "$MODEL_PATH"
fi

echo "MODEL_PATH=$MODEL_PATH"
ls -lh /models
echo "CTX_SIZE=$CTX_SIZE"

echo "Starting llama-server..."
/app/llama-server -m "$MODEL_PATH" --host 0.0.0.0 --port 8080 --ctx-size "$CTX_SIZE" &
MODEL_PID=$!

# fail fast if llama dies immediately
sleep 1
if ! kill -0 "$MODEL_PID" 2>/dev/null; then
  echo "llama-server crashed immediately."
  exit 1
fi

cleanup() {
  echo "Stopping llama-server (pid=$MODEL_PID)..."
  kill "$MODEL_PID" 2>/dev/null || true
  wait "$MODEL_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Background readiness check (does not block Node startup)
(
  echo "Waiting for llama-server to be ready..."
  for i in {1..300}; do
    if curl -sf "http://127.0.0.1:8080/health" >/dev/null 2>&1; then
      echo "llama-server is up."
      exit 0
    fi
    sleep 1
  done
  echo "llama-server did not become ready in time."
  kill "$MODEL_PID" 2>/dev/null || true
  exit 1
) &

echo "Starting worker API..."
exec node src/index.js
