FROM ghcr.io/ggml-org/llama.cpp:server

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates gnupg \
  && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && node -v \
  && npm -v \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src
COPY start.sh ./start.sh
RUN chmod +x ./start.sh

VOLUME ["/models"]
ENV MODEL_PATH=/models/Phi-3-mini-4k-instruct-q4.gguf
ENV CTX_SIZE=2048

EXPOSE 4000
ENTRYPOINT ["/app/start.sh"]
