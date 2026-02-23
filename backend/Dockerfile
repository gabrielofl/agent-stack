FROM mcr.microsoft.com/playwright:v1.58.0-jammy

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ✅ Add a virtual display server (Xvfb) + helpers
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    xauth \
    fluxbox \
  && rm -rf /var/lib/apt/lists/*

COPY . .

ENV PORT=3000
EXPOSE 3000

# ✅ Run your app under Xvfb so Chromium has a display
CMD ["bash","-lc","set -euxo pipefail; which xvfb-run; xvfb-run -a -s \"-screen 0 1280x720x24\" npm run start"]