# HANDOFF 16.11.2026 — плеер уроков школы

## Контекст
Ученицы получили ссылки на уроки (shirinsweets.online), видео вечно грузилось на Android, ушли в Telegram.

## Сделано (PR DalerJaborov/sweet-school-bot-public#100, ветка `fix/player-segment-credentials-16-11`, НЕ влит)
1. hls.js слал куки на сегменты R2 → CORS-отказ (замер: с куками — error, без — 200). Куки только своему origin (`apps/web/src/course/sameOrigin.ts`).
2. Подпись сегментов 5 мин → 6 ч (`apps/api/src/course/manifest.ts`); повтор перечитывает манифест с той же секунды и продолжает игру (`reloadSource` в `useHls.ts`, замер в Chromium).
3. `import("hls.js")` без catch → оверлей «Попробовать снова».
4. Убран двойной запрос манифеста.
Проверено: web 486/486, api manifest-тесты 94/94, tsc.

## В работе
Агент: ветка `feat/backfill-low-renditions-16-11` — ступени 360p + 240p для новых уроков и скрипт дозаливки 31 старого урока тем же ключом/IV (сейчас у всех только 720p 3,4 Мбит и 480p 1,4 Мбит). PR в ветку #100.

## Ждёт владельца
- Кнопка Squash and merge на #100 (`gh pr merge` чату запрещён настройками).
- Выкат: rh-vps `/opt/sweet-school-bot`: `git pull --ff-only origin main && docker compose build api web && docker compose up -d api && docker compose up -d --force-recreate web`.
- Отдельное «да» на дозаливку рендишенов на проде.

## Следующая задача (вопрос владельца 16.11)
Аудит плеера со всех сторон: удобство, вес, скорость старта, вертикальное видео 720×1280 в горизонтальной рамке, полный экран, управление, тёмная тема, телефон/ПК. Код: `apps/web/src/course/player/*`. Не трогать `videoPipeline.ts` (ветка backfill).
