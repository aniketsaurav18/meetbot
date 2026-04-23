FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
  ffmpeg \
  pulseaudio \
  pulseaudio-utils \
  alsa-utils \
  libnss3 \
  libxss1 \
  libasound2 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libcups2 \
  libxkbcommon-x11-0 \
  libgbm1 \
  libgbm-dev \
  libgl1-mesa-dri \
  libgl1-mesa-glx \
  mesa-utils \
  xvfb \
  xauth \
  dumb-init \
  wget \
  gnupg \
  xorg \
  xserver-xorg \
  libx11-dev \
  libxext-dev \
  dos2unix \
  procps \
  ca-certificates \
  fonts-liberation \
  libcairo2 \
  libdbus-1-3 \
  libdrm2 \
  libexpat1 \
  libglib2.0-0 \
  libgtk-3-0 \
  libnspr4 \
  libpango-1.0-0 \
  libx11-6 \
  libx11-xcb1 \
  libxcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxfixes3 \
  libxrandr2 \
  xdg-utils \
  && rm -rf /var/lib/apt/lists/*

RUN wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-linux-signing-key.gpg && \
  arch="$(dpkg --print-architecture)" && \
  if [ "$arch" = "amd64" ]; then \
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-linux-signing-key.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list; \
  elif [ "$arch" = "arm64" ]; then \
    echo "deb [arch=arm64 signed-by=/usr/share/keyrings/google-linux-signing-key.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list; \
  else \
    echo "deb [signed-by=/usr/share/keyrings/google-linux-signing-key.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list; \
  fi && \
  apt-get update && \
  (apt-get install -y google-chrome-stable || apt-get install -y chromium) && \
  rm -rf /var/lib/apt/lists/*

RUN if [ -x /usr/bin/google-chrome-stable ] && [ ! -e /usr/bin/google-chrome ]; then ln -sf /usr/bin/google-chrome-stable /usr/bin/google-chrome; fi && \
  if [ -x /usr/bin/chromium ] && [ ! -e /usr/bin/google-chrome ]; then ln -sf /usr/bin/chromium /usr/bin/google-chrome; fi

RUN groupadd -g 1001 nodejs && \
  useradd -m -d /home/nodejs -r -u 1001 -g nodejs nodejs

COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY apps/bot/package.json ./apps/bot/package.json
COPY packages/shared/package.json ./packages/shared/package.json

RUN npm ci --include=dev && npm cache clean --force

COPY apps/bot ./apps/bot
COPY packages/shared ./packages/shared

ENV NODE_ENV=production
ENV BROWSER_EXECUTABLE_PATH=/usr/bin/google-chrome
ENV HEADLESS=false
ENV DEBUG_SCREENSHOT_ROOT=/tmp/meetingbot/debug-screenshots
ENV DEBUG_VIDEO_ROOT=/tmp/meetingbot/debug-videos

RUN dos2unix /app/apps/bot/docker-entrypoint.sh && \
  chmod +x /app/apps/bot/docker-entrypoint.sh

RUN mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix && \
  mkdir -p /tmp/meetingbot/debug-screenshots /tmp/meetingbot/debug-videos && chmod -R 777 /tmp/meetingbot && \
  mkdir -p /run/user/1001 && chown -R nodejs:nodejs /run/user/1001 && chmod 700 /run/user/1001 && \
  mkdir -p /home/nodejs/.config/pulse && chown -R nodejs:nodejs /home/nodejs/.config && \
  chown -R nodejs:nodejs /app

USER nodejs

ENTRYPOINT ["dumb-init", "--", "/app/apps/bot/docker-entrypoint.sh"]
