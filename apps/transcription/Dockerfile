FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY apps/transcription/package.json ./apps/transcription/package.json

RUN npm ci --include=dev && npm cache clean --force

COPY apps/transcription ./apps/transcription

ENV NODE_ENV=production
ENV PORT=6666
ENV HOST=0.0.0.0

EXPOSE 6666

CMD ["npm", "run", "start", "-w", "@meetingbot/transcription"]
