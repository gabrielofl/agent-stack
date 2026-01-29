#!/usr/bin/env bash
set -euo pipefail

MODEL_PATH="${MODEL_PATH:-/models/tinyllama-1.1b-chat-v1.0.Q2_K.gguf}"
MODEL_URL="${MODEL_URL:-}"
CTX_SIZE="${CTX_SIZE:-1024}"

mkdir -p /models

if [ ! -f "$MODEL_PATH" ]; then
  if [ -z "$MODEL_URL" ]; then
    echo "Model not found at $MODEL_PATH and MODEL_URL not set."
    echo "Upload the GGUF into the Azure Files share mounted at /models, or set MODEL_URL to download it."
    exit 1
  fi
  echo "Downloading model to $MODEL_PATH ..."
  curl -L "$MODEL_URL" -o "$MODEL_PATH"
fi

echo "Starting llama-server..."
# IMPORTANT: On ghcr.io/ggml-org/llama.cpp:server, runtime + backend libs live in /app
/app/llama-server -m "$MODEL_PATH" --host 0.0.0.0 --port 8080 --ctx-size "$CTX_SIZE" &
LLAMA_PID=$!

# If llama-server dies immediately, don't continue
sleep 1
if ! kill -0 "$LLAMA_PID" 2>/dev/null; then
  echo "llama-server crashed immediately. Exiting."
  exit 1
fi

echo "Waiting for llama-server to be ready..."
READY=0
for i in {1..20}; do
  if curl -sf "http://127.0.0.1:8080/health" >/dev/null 2>&1; then
    READY=1
    echo "llama-server is up."
    break
  fi
  sleep 1
done

if [ "$READY" -ne 1 ]; then
  echo "llama-server did not become ready in time. Exiting."
  exit 1
fi

cleanup() {
  echo "Stopping llama-server (pid=$LLAMA_PID)..."
  kill "$LLAMA_PID" 2>/dev/null || true
  wait "$LLAMA_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Starting worker API..."
exec node src/index.js
