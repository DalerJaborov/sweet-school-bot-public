#!/usr/bin/env bash
# Офсайт-копия бэкапов в облако (Cloudflare R2): зеркалит /backups в bucket.
# Требует настроенного rclone-remote с именем r2:
#   rclone config create r2 s3 provider=Cloudflare access_key_id=XXX secret_access_key=YYY endpoint=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
# Пока remote не настроен — тихо выходит (не спамит лог ошибками).
set -u -o pipefail
if ! rclone listremotes 2>/dev/null | grep -q '^r2:'; then
  echo "[offsite] rclone remote 'r2' не настроен — пропуск"
  exit 0
fi
# copy, не sync: удаление локального файла (ротация 30 дней) НЕ удаляет копию в
# облаке — там держим 180 дней своей ротацией ниже.
rclone copy /backups r2:royalhome-backups --transfers 4 --max-age 3d 2>&1
rclone delete r2:royalhome-backups --min-age 180d 2>&1
echo "[offsite] done $(date -Is)"
