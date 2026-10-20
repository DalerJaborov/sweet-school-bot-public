#!/usr/bin/env bash
# Ежедневный бэкап бота кондитерской школы: база SQLite + загруженные файлы.
#
# ЗАЧЕМ ЗАВЕДЁН (22.08.2026). Бэкапы были у CRM и у сайта, а школьный бот не
# сохранялся ВООБЩЕ — ни локально, ни в облако. При этом в его базе лежат продажи,
# выданные доступы к курсам и контакты учениц: потеряв диск, восстановить, кто и за
# что заплатил, было бы неоткуда. Дыру нашли, когда проверяли, есть ли бэкапы вообще.
#
# Запуск на VPS:
#   crontab -e  →  15 3 * * * /opt/sweet-school-bot/ops/backup.sh >> /var/log/school-backup.log 2>&1
#
# Время 03:15 — между CRM (03:00) и сайтом (03:30), чтобы три дампа не сходились в
# одну минуту на одном диске. Внешнюю копию делает /opt/offsite-backup.sh в 04:00:
# он копирует /backups целиком, поэтому отдельной настройки для школы не нужно —
# достаточно, чтобы файлы лежали в /backups/school.
#
# Telegram-алерт при сбое — тот же /opt/watchdog.env, что у остальных.
set -u -o pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="docker compose -f $REPO_DIR/docker-compose.yml"
BACKUP_DIR="${SCHOOL_BACKUP_DIR:-/backups/school}"
KEEP_DAYS="${SCHOOL_BACKUP_KEEP_DAYS:-30}"
# Архив загруженных файлов держим ОТДЕЛЬНО и заметно меньше.
#
# ПОЧЕМУ (найдено 03.09.2026). Скрипт складывал ПОЛНУЮ копию /data/uploads
# каждый день и хранил её 30 дней. Файлы там почти не меняются — это чеки и
# голосовые, которые только добавляются, — то есть на диске лежало тридцать
# почти одинаковых архивов по полтора гигабайта. На момент находки: 11 ГБ и
# рост на 1,4 ГБ в сутки при 25 ГБ свободного места, то есть меньше трёх
# недель до переполнения. А переполненный диск означает, что SQLite перестаёт
# писать и бот молча замолкает для всех.
#
# Теперь: полный архив раз в неделю, храним четыре штуки. Это те же четыре
# недели глубины, но около 6 ГБ вместо сорока, и объём перестаёт расти.
UPLOADS_KEEP="${SCHOOL_UPLOADS_KEEP:-4}"
UPLOADS_EVERY_DAYS="${SCHOOL_UPLOADS_EVERY_DAYS:-7}"
# Ниже этого порога свободного места архив загрузок не делаем вовсе: он сам
# весит гигабайты и добьёт диск ровно тогда, когда на нём уже тесно. База
# при этом сохраняется всегда — она маленькая и она важнее.
MIN_FREE_PCT="${SCHOOL_MIN_FREE_PCT:-15}"
STAMP="$(date +%F)"

mkdir -p "$BACKUP_DIR"

alert() {
  echo "[backup][ERROR] $1" >&2
  if [ -f /opt/watchdog.env ]; then
    # shellcheck disable=SC1091
    . /opt/watchdog.env
    if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
      curl -s -o /dev/null --max-time 10 \
        "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        -d chat_id="${TELEGRAM_CHAT_ID}" \
        -d text="⚠️ School bot backup failed on $(hostname): $1"
    fi
  fi
  exit 1
}

# 1. База. SQLite нельзя просто скопировать на ходу: в момент записи файл может
#    оказаться несогласованным, и восстановленная копия будет битой. `VACUUM INTO` —
#    родная команда SQLite: делает согласованный снимок под блокировкой, попутно
#    сжимая базу. Консольного sqlite3 в образе нет, поэтому команду выполняем через
#    Prisma, который в приложении и так есть.
docker cp "$REPO_DIR/ops/sqlite-snapshot.mjs" sweet-school-bot-api-1:/tmp/sqlite-snapshot.mjs   || alert "не удалось положить скрипт снимка в контейнер"
docker exec sweet-school-bot-api-1 node /tmp/sqlite-snapshot.mjs || alert "sqlite snapshot failed"

docker exec sweet-school-bot-api-1 sh -c 'gzip -c /data/bot.backup.tmp'   > "$BACKUP_DIR/school-db-$STAMP.db.gz"   || alert "sqlite archive failed"
docker exec sweet-school-bot-api-1 rm -f /data/bot.backup.tmp /tmp/sqlite-snapshot.mjs || true
[ -s "$BACKUP_DIR/school-db-$STAMP.db.gz" ] || alert "db dump is empty"

# 2. Загруженные файлы (чеки об оплате, голосовые, фото меню) — раз в неделю.
#    Ежедневная полная копия почти неизменной папки съедала диск (см. выше).
FREE_PCT="$(df --output=pcent "$BACKUP_DIR" | tail -1 | tr -dc '0-9')"
FREE_PCT=$((100 - FREE_PCT))
RECENT_UPLOADS="$(find "$BACKUP_DIR" -name 'school-uploads-*.tar.gz' -mtime "-$UPLOADS_EVERY_DAYS" | head -1)"

if [ "$FREE_PCT" -lt "$MIN_FREE_PCT" ]; then
  # Не alert: это не сбой бэкапа, а осознанный пропуск. Но владелец должен
  # узнать — свободное место кончается, и это чинится только руками.
  echo "[backup][WARN] свободно ${FREE_PCT}% — архив загрузок пропущен, чтобы не добить диск" >&2
  if [ -f /opt/watchdog.env ]; then
    # shellcheck disable=SC1091
    . /opt/watchdog.env
    if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
      curl -s -o /dev/null --max-time 10 \
        "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        -d chat_id="${TELEGRAM_CHAT_ID}" \
        -d text="🟠 Диск школы: свободно ${FREE_PCT}%. Архив загрузок пропущен. База сохранена. Нужно освободить место."
    fi
  fi
elif [ -n "$RECENT_UPLOADS" ]; then
  echo "[backup] архив загрузок свежий ($RECENT_UPLOADS) — пропускаю"
else
  docker exec sweet-school-bot-api-1 tar czf - -C /data uploads \
    > "$BACKUP_DIR/school-uploads-$STAMP.tar.gz" \
    || alert "uploads archive failed"
fi

# 3. Ротация. База — по возрасту, архивы загрузок — по количеству: они крупные,
#    и считать их штуками надёжнее, чем днями.
find "$BACKUP_DIR" -name "school-db-*.gz" -mtime "+$KEEP_DAYS" -delete
ls -1t "$BACKUP_DIR"/school-uploads-*.tar.gz 2>/dev/null | tail -n +$((UPLOADS_KEEP + 1)) | while read -r old; do
  echo "[backup] удаляю старый архив загрузок: $old"
  rm -f "$old"
done

echo "[backup] OK $STAMP: $(du -sh "$BACKUP_DIR" | cut -f1) total in $BACKUP_DIR"
