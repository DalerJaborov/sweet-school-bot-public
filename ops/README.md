# Эксплуатация

## Публичный исходный код — 21.10.2026

Серверный каталог сохраняется: `/opt/sweet-school-bot`, origin теперь
`DalerJaborov/sweet-school-bot-public`, ветка `main`. Приватная история и
конфигурация сохранены отдельно. Базы и загрузки остаются в прежних томах.

APK приложения хранится вне Git. Перед производственной сборкой веба:

```bash
test -s /opt/royalhome-private-assets/school/shirin-sweets.apk
mkdir -p apps/web/public/app
cp /opt/royalhome-private-assets/school/shirin-sweets.apk apps/web/public/app/shirin-sweets.apk
```

Не добавлять APK в коммит. После релиза проверить `/health` и доступность
`/app/shirin-sweets.apk`; зелёный CI сам по себе не подтверждает выкат.

## Что где лежит на сервере

Сервер `rh-vps` (85.198.70.182), доступ по ключу `~/.ssh/royalhome_ops`.
Проект: `/opt/sweet-school-bot`, запускается через `docker compose`.

| Что | Где | Когда |
|---|---|---|
| Бэкап базы и загрузок | `ops/backup.sh` → `/backups/school` | cron, 03:15 |
| Сторож здоровья | `/opt/health-watchdog.sh` (копия здесь: `ops/health-watchdog.sh`) | cron, каждые 3 минуты |
| Внешняя копия бэкапов | `/opt/offsite-backup.sh` | cron, 04:00 |

## Обновление

```bash
ssh rh-vps
cd /opt/sweet-school-bot
git pull --ff-only origin main
docker compose build
docker compose up -d
```

Миграции базы накатываются сами при старте, копия базы снимается перед ними
автоматически (`scripts/backup-db.ts`, вызывается из `Dockerfile` CMD).

После обновления обязательно посмотреть:

```bash
docker compose logs api --since 5m | grep ERROR
```

Две из трёх ошибок при выкладке 03.09.2026 не проявлялись ни в тестах, ни в
типах — только в логе первого реального запуска.

## Сторож здоровья

`/opt/health-watchdog.sh` проверяет сайт, CRM и школу каждые три минуты. Для
школы дёргается `/health`, а не главная страница: панель продолжает
открываться, даже когда база заблокирована, кончился диск или встали фоновые
задачи, — то есть по главной такую поломку не увидеть вовсе.

Упало — сторож делает одну попытку перезапустить контейнеры и пишет владельцу
в Telegram. Сообщения шлются только на ПЕРЕХОДАХ (упало / поднялось), поэтому
он не превращается в шум.

Копия скрипта лежит здесь на случай переустановки сервера: сам он живёт вне
репозитория, в `/opt`, и общий для трёх проектов.

## Чего этот сторож НЕ ловит

Он крутится на том же сервере. Если сервер умрёт целиком или пропадёт сеть,
тревоги не будет — слать её будет некому. Для этого стоит внешний наблюдатель
UptimeRobot (аккаунт владельца, jabbarovdaler@gmail.com): раз в 5 минут дёргает
`https://sweetbot.royalhome.tj/health` (старый домен работает как технический;
основной сайт — `https://shirinsweets.online`) и пишет, когда ответа нет.

## Бэкапы и восстановление (репетиция 05.09.2026 — прошла)

Три слоя:

| Слой | Что | Где | Хранение |
|---|---|---|---|
| Перед каждым стартом контейнера | `VACUUM INTO` копия базы (`scripts/backup-db.ts`) | `/data/backup/bot-<дата>.db` (том контейнера) | по имени, старые ротируются |
| Ночью, 03:15 | база + архив загрузок (`ops/backup.sh`) | `/backups/school` на хосте | 7 дней (`SCHOOL_BACKUP_KEEP_DAYS`) |
| Ночью, 04:00 | зеркало `/backups` в Cloudflare R2 (`ops/offsite-backup.sh`, rclone remote `r2`, бакет `royalhome-backups`) | облако | 180 дней |

Видео уроков (HLS, исходники `sources/`, обложки) живут ТОЛЬКО в бакете R2
`sweet-school` — это единственная копия. Экспорт Telegram после импорта
удаляется, поэтому владельцу нужно хранить оригиналы видео у себя (диск).

### Как восстановить базу (10 минут)

```bash
ssh rh-vps
cd /opt/sweet-school-bot
# 1. Выбрать копию: свежее всего — в контейнере, /data/backup; ночные — /backups/school
docker compose exec api ls -t /data/backup | head
# 2. Проверить копию ДО подмены (целостность + счётчики), не трогая прод:
docker compose exec api sh -c 'cp /data/backup/bot-<ДАТА>.db /tmp/r.db && node -e "
const {PrismaClient}=require(\"@prisma/client\");const p=new PrismaClient({datasources:{db:{url:\"file:/tmp/r.db\"}}});
(async()=>{console.log(await p.\$queryRawUnsafe(\"PRAGMA integrity_check\"),await p.contact.count(),await p.purchase.count(),await p.lesson.count());await p.\$disconnect();})()"'
# 3. Подменить: остановить api, положить копию на место рабочей базы, убрать WAL/SHM, запустить
docker compose stop api
docker compose run --rm --no-deps api sh -c 'cp /data/backup/bot-<ДАТА>.db /data/bot.db && rm -f /data/bot.db-wal /data/bot.db-shm'
docker compose up -d api
curl -s https://shirinsweets.online/health
```

Путь к рабочей базе — из `DATABASE_URL` в `.env` (`file:/data/bot.db`); если он
другой, подставить его в шаге 3. Копия из `/backups/school/*.db.gz` — сначала
`gunzip`, затем те же шаги. Из R2: `rclone copy r2:royalhome-backups/school/<файл> /backups/school/`.

Репетиция 05.09.2026: копия `bot-2026-09-05T07-14-34.db` открылась,
`integrity_check = ok`, 392 контакта, 49 покупок, 31 урок, 51 чек.
