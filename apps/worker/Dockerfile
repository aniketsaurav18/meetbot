FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  docker.io \
  dumb-init \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY apps/worker/package.json ./apps/worker/package.json
COPY apps/bot/package.json ./apps/bot/package.json
COPY packages/shared/package.json ./packages/shared/package.json

RUN npm ci --include=dev && npm cache clean --force

COPY apps/worker ./apps/worker
COPY apps/bot ./apps/bot
COPY packages/shared ./packages/shared

ENV NODE_ENV=production

CMD ["dumb-init", "--", "npm", "run", "start", "-w", "@meetingbot/worker"]
