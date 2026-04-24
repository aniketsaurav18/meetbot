FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/frontend/package.json apps/frontend/
COPY packages/shared/package.json packages/shared/
RUN npm ci --workspace=@meetingbot/frontend --include-workspace-root
COPY packages/ packages/
COPY apps/frontend/ apps/frontend/
ARG VITE_API_BASE=""
ENV VITE_API_BASE=${VITE_API_BASE}
RUN npm run build -w @meetingbot/frontend

FROM nginx:alpine
COPY --from=build /app/apps/frontend/dist /usr/share/nginx/html
COPY apps/frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
