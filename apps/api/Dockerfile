# Сборка и запуск API бота. База — SQLite-файл в томе /data, поэтому
# отдельный контейнер с СУБД не нужен.
FROM node:24-slim AS build
WORKDIR /app
ARG DEBIAN_MIRROR=deb.debian.org
# Prisma определяет нужный движок по openssl в системе — без него на этапе
# сборки она выберет чужую сборку движка.
RUN sed -i "s|http://deb.debian.org|http://${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
 && apt-get update && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*

# Prisma тянет схему на этапе установки — копируем её вместе с манифестами,
# чтобы слой зависимостей кешировался отдельно от исходников.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/api/prisma apps/api/prisma
RUN npm ci --workspace=apps/api --include-workspace-root

COPY apps/api apps/api
RUN npm run prisma:generate --workspace=apps/api \
 && npm run build --workspace=apps/api

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ARG DEBIAN_MIRROR=deb.debian.org
# Prisma для SQLite нужен OpenSSL; в slim-образе его нет.
# ffmpeg/ffprobe — транскодинг уроков в HLS (src/storage/videoPipeline.ts):
# без них загруженное видео навсегда остаётся в статусе FAILED.
RUN sed -i "s|http://deb.debian.org|http://${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
 && apt-get update && apt-get install -y --no-install-recommends openssl ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# Workspaces складывают зависимости (и сгенерированный Prisma-клиент) в корень.
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/prisma apps/api/prisma
COPY --from=build /app/apps/api/package.json apps/api/package.json
# Служебные скрипты (бэкап перед миграцией, backfill каталога курсов) — они на
# TypeScript и запускаются через tsx, в dist их нет.
COPY --from=build /app/apps/api/scripts apps/api/scripts
# Шрифт для карточек-отзывов (Фаза 3, ai/testimonialCard.ts) — tsc копирует
# только .ts, статика в dist не попадает, приходится тащить отдельно.
COPY --from=build /app/apps/api/assets apps/api/assets

WORKDIR /app/apps/api
EXPOSE 4100
# Миграции накатываются при старте: схема маленькая, а забытая миграция
# на проде дороже лишней секунды запуска.
#
# ПЕРЕД миграцией снимается копия базы. SQLite не умеет ALTER TABLE с
# ограничениями, поэтому Prisma при изменении связей пересоздаёт таблицу
# целиком (CREATE new -> INSERT SELECT -> DROP -> RENAME) — так делает,
# например, миграция платформы курсов. Прерваться на этом месте без копии
# означало бы потерять таблицу продаж. Сбой самого бэкапа старт не блокирует.
CMD ["sh", "-c", "npx tsx scripts/backup-db.ts; npx prisma migrate deploy && node dist/index.js"]
