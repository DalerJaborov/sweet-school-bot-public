#!/usr/bin/env bash
# ============================================================================
# ROYAL HOME — «Доктор ИИ» (lite): сторож здоровья сервера
# ----------------------------------------------------------------------------
# Крутится на VPS по cron. НИЧЕГО НЕ СТОИТ: никаких вызовов ИИ, только проверки
# (curl + docker). Раз в несколько минут проверяет, что сайт и CRM отвечают
# HTTP 200 и их Docker-контейнеры живы. Если что-то упало — делает ОДНУ
# автоматическую попытку перезапустить контейнеры и шлёт тебе сообщение в
# Telegram ТОЛЬКО когда состояние реально изменилось (упало / поднялось).
# Никаких отчётов «просто так».
#
# УСТАНОВКА (один раз), на сервере под root:
#   1) Скопировать скрипт и сделать исполняемым:
#        cp ops/health-watchdog.sh /opt/health-watchdog.sh
#        chmod +x /opt/health-watchdog.sh
#   2) (Рекомендуется) вписать Telegram-данные в /opt/watchdog.env:
#        TELEGRAM_BOT_TOKEN=123456789:AA...    # токен бота от @BotFather
#        TELEGRAM_CHAT_ID=123456789            # твой chat id (узнать у @userinfobot)
#      Без них сторож всё равно работает (перезапускает, пишет в лог),
#      просто не шлёт уведомления.
#   3) Добавить в crontab root (проверка каждые 3 минуты):
#        crontab -e
#        */3 * * * * /opt/health-watchdog.sh >> /var/log/royalhome-watchdog.log 2>&1
#
# Проверить вручную:  /opt/health-watchdog.sh ; echo "exit=$?"
# ============================================================================
set -uo pipefail

# ---- Подхватываем настройки (не обязателен) --------------------------------
[ -f /opt/watchdog.env ] && . /opt/watchdog.env

# ---- Что проверяем (можно переопределить в /opt/watchdog.env) --------------
# Сайт слушает Caddy на :80. CRM ходит через тот же Caddy по Host-заголовку.
SITE_URL="${SITE_URL:-http://127.0.0.1/}"
SITE_HOST_HEADER="${SITE_HOST_HEADER:-}"                     # напр. royalhome.tj
CRM_URL="${CRM_URL:-http://127.0.0.1/}"
CRM_HOST_HEADER="${CRM_HOST_HEADER:-crm.royalhome.tj}"       # Caddy маршрутит по нему

# Бот кондитерской школы (добавлен 03.09.2026). Проверяем НЕ главную страницу, а
# /health: он отвечает 503, когда база заблокирована, кончился диск или встали
# фоновые задачи. Панель при этом продолжает открываться — то есть по главной
# странице такую поломку не увидеть вовсе, а для школы это значит, что бот
# молча перестал отвечать клиенткам.
SCHOOL_URL="${SCHOOL_URL:-http://127.0.0.1/health}"
SCHOOL_HOST_HEADER="${SCHOOL_HOST_HEADER:-sweetbot.royalhome.tj}"

SITE_DIR="${SITE_DIR:-/opt/royalhome-site}"
CRM_DIR="${CRM_DIR:-/opt/royalhome-crm}"
SCHOOL_DIR="${SCHOOL_DIR:-/opt/sweet-school-bot}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
# У школы файл называется иначе, чем у сайта и CRM.
SCHOOL_COMPOSE_FILE="${SCHOOL_COMPOSE_FILE:-docker-compose.yml}"

STATE_DIR="${STATE_DIR:-/var/lib/royalhome-watchdog}"
HTTP_TIMEOUT="${HTTP_TIMEOUT:-10}"
mkdir -p "$STATE_DIR"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*"; }

# ---- Telegram: шлём ТОЛЬКО при смене состояния -----------------------------
notify() {
  local text="$1"
  log "NOTIFY: $text"
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
    curl -fsS --max-time 10 \
      "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d chat_id="${TELEGRAM_CHAT_ID}" \
      -d parse_mode="HTML" \
      --data-urlencode text="$text" >/dev/null 2>&1 \
      || log "WARN: Telegram send failed"
  fi
}

# Меняет запомненное состояние сервиса и уведомляет только на переходах:
#   was up   -> now down : «упал»
#   was down -> now up   : «восстановился»
# $1 = имя сервиса (site/crm), $2 = ok|fail, $3 = деталь для сообщения
transition() {
  local name="$1" now="$2" detail="${3:-}"
  local f="$STATE_DIR/$name.state"
  local prev; prev="$(cat "$f" 2>/dev/null || echo ok)"
  echo "$now" > "$f"
  if [ "$prev" = "ok" ] && [ "$now" = "fail" ]; then
    notify "🔴 <b>ROYAL HOME</b>: <b>$name</b> недоступен.%0A$detail%0AПробую перезапустить…"
    return 1   # сигнал вызывающему: нужно чинить
  elif [ "$prev" = "fail" ] && [ "$now" = "ok" ]; then
    notify "🟢 <b>ROYAL HOME</b>: <b>$name</b> снова работает."
  fi
  return 0
}

# ---- Проверка одного HTTP-эндпоинта ----------------------------------------
http_code() {
  local url="$1" host="$2"
  if [ -n "$host" ]; then
    curl -s -o /dev/null -w '%{http_code}' --max-time "$HTTP_TIMEOUT" -H "Host: $host" "$url" 2>/dev/null || echo 000
  else
    curl -s -o /dev/null -w '%{http_code}' --max-time "$HTTP_TIMEOUT" "$url" 2>/dev/null || echo 000
  fi
}

http_ok() {
  local code; code="$(http_code "$1" "$2")"
  # 2xx/3xx считаем живым (редиректы на https — норма)
  [ "$code" -ge 200 ] && [ "$code" -lt 400 ]
}

# 503 — приложение ЖИВО и само честно говорит, что ему плохо (у школы /health
# отдаёт 503 при тишине входящих, зависшей задаче, полном диске). Перезапуск
# такое не лечит, а буферы ответов клиенткам теряет; раньше сторож дёргал
# контейнер каждые три минуты и молчал об этом после первого сообщения.
# Здесь: не перезапускаем, а напоминаем раз в час, пока не пройдёт.
SICK_COOLDOWN_SEC=3600
sick_notify() {
  local name="$1" detail="$2" f="$STATE_DIR/$name.sick"
  local last; last="$(cat "$f" 2>/dev/null || echo 0)"
  local now; now="$(date +%s)"
  if [ $((now - last)) -ge "$SICK_COOLDOWN_SEC" ]; then
    echo "$now" > "$f"
    notify "🟠 <b>ROYAL HOME</b>: <b>$name</b> отвечает 503 — приложение живо, но сообщает о проблеме.%0A$detail%0AПерезапуск не поможет: смотрите /health и панель."
  fi
}

# ---- Перезапуск docker-compose проекта -------------------------------------
compose_restart() {
  local dir="$1" file="${2:-$COMPOSE_FILE}"
  [ -d "$dir" ] || { log "WARN: нет каталога $dir"; return 1; }
  ( cd "$dir" && (docker compose -f "$file" restart || docker-compose -f "$file" restart) ) >/dev/null 2>&1
}

# ---- Проверяем один сервис: HTTP → при падении перезапуск → повтор ----------
check_service() {
  local name="$1" url="$2" host="$3" dir="$4" file="${5:-$COMPOSE_FILE}"

  if http_ok "$url" "$host"; then
    transition "$name" ok
    rm -f "$STATE_DIR/$name.sick"
    return 0
  fi

  if [ "$(http_code "$url" "$host")" = "503" ]; then
    local body; body="$(curl -s --max-time "$HTTP_TIMEOUT" ${host:+-H "Host: $host"} "$url" 2>/dev/null | head -c 300)"
    log "$name SICK (503): $body"
    sick_notify "$name" "$body"
    return 1
  fi

  # Первое падение этого цикла — уведомляем (если это переход) и чиним.
  transition "$name" fail "URL: $url" || true
  log "$name DOWN → restart $dir"
  compose_restart "$dir" "$file"

  # Даём контейнерам подняться и проверяем ещё раз.
  sleep 15
  if http_ok "$url" "$host"; then
    transition "$name" ok
    log "$name recovered after restart"
    return 0
  fi

  log "$name STILL DOWN after restart"
  # состояние остаётся fail; следующий запуск снова попробует и, если так и не
  # поднимется, тревога уже отправлена — спамить не будем.
  return 1
}

log "watchdog run start"
rc=0
check_service "site"   "$SITE_URL"   "$SITE_HOST_HEADER"   "$SITE_DIR"   || rc=1
check_service "crm"    "$CRM_URL"    "$CRM_HOST_HEADER"    "$CRM_DIR"    || rc=1
check_service "школа"  "$SCHOOL_URL" "$SCHOOL_HOST_HEADER" "$SCHOOL_DIR" "$SCHOOL_COMPOSE_FILE" || rc=1
log "watchdog run done (rc=$rc)"
exit "$rc"
