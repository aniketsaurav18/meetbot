FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends dumb-init && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY apps/backend/package.json ./apps/backend/package.json
COPY packages/shared/package.json ./packages/shared/package.json

RUN npm ci --include=dev && npm cache clean --force

COPY apps/backend ./apps/backend
COPY packages/shared ./packages/shared

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

EXPOSE 3000

CMD ["dumb-init", "--", "npm", "run", "start", "-w", "@meetingbot/backend"]
