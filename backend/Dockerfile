FROM budtmo/docker-android:latest

ENV DEBIAN_FRONTEND=noninteractive

# Install necessary tools and dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    wget \
    unzip \
    xvfb \
    fluxbox \
    xauth \
    firefox \
    && rm -rf /var/lib/apt/lists/*

# Download and install Cloudflare Warp
RUN apt-get update && apt-get install -y curl gnupg
RUN curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg | gpg --dearmor -o /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg
RUN echo "deb [arch=amd64 signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ jammy main" > /etc/apt/sources.list.d/cloudflare-warp.list
RUN apt-get update && apt-get install -y cloudflare-warp

# Automate registration (CAUTION: This automatically accepts the TOS)
RUN warp-cli register --accept-tos

RUN warp-cli connect

# Set up display and start fluxbox
RUN echo "DISPLAY=:99" >> /root/.profile
RUN start-stop-daemon --start --quiet --pidfile /tmp/custom_xvfb_99.pid --make-pidfile --background --exec /usr/bin/Xvfb -- :99 -screen 0 1280x720x24
RUN fluxbox &

# Start Firefox
CMD ["bash", "-c", "warp-cli connect && DISPLAY=:99 firefox"]
