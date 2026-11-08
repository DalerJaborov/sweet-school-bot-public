# Administrator access

Supersedes the Cloudflare-only description (same file); not linked from code. Owner decision (08.11.2026): «полностью удали Cloudflare и сделай по старинке» — the panel opens the old way, no Cloudflare in front of it.

## Mode 0 (default, `SCHOOL_ACCESS_REQUIRED=0`)

- **Telegram mini-app** (`/panel/` opened from the bot button): `POST /admin/telegram-login`
  verifies the Telegram `initData` HMAC (key derived from the bot token, constant-time compare,
  `auth_date` not older than 24 h and not in the future) and lets in only the chat ids stored in the
  settings `telegramOwnerChatId` and `telegramReportChatId`. It returns a 30-day admin JWT (`role: admin`).
- **Browser**: password login `POST /admin/login` (`ADMIN_PASSWORD`, constant-time compare).
- **Brute-force protection** (HTTP 429, in memory): password login 8 attempts per IP and 40 overall
  per 15 minutes; Telegram login 20 per IP and 100 overall per 15 minutes.
- `ADMIN_PASSWORD` must be long and random (16+ characters). Student course tokens use a different
  secret and are never accepted by the panel (role check in `admin.ts`).
- In production the mode must be explicit: `SCHOOL_ACCESS_REQUIRED` unset fails startup.

## Mode 1 (`SCHOOL_ACCESS_REQUIRED=1`, optional)

Only a Cloudflare Access assertion (RS256, issuer/AUD/email checked) is accepted; password and
Telegram login return 403; exact `Origin` required on writes; logout revokes the assertion.
Needs `SCHOOL_ACCESS_TEAM_DOMAIN`, `SCHOOL_ACCESS_AUDIENCE`, `SCHOOL_ADMIN_EMAIL`,
`SCHOOL_ADMIN_ORIGINS` and an Access application on `/admin*` and `/panel*`.
In mode 0 that Access application must NOT cover those paths, otherwise Cloudflare blocks the mini-app.
