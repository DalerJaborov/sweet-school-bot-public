# Панель управления: собираем статику и отдаём её nginx.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
RUN npm ci --workspace=apps/web --include-workspace-root
COPY apps/web apps/web
RUN npm run build --workspace=apps/web

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
