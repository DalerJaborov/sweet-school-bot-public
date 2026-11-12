# Meta keys: instant dead-key alert and Instagram via the Page

A password change killed the personal Instagram Login key of a sibling bot (Royal Home CRM, 12.11.2026) and it stayed silent for a day. The school bot used the same kind of keys: a Page key issued from a personal profile (data access until 19.11.2026) and a personal Instagram Login key, checked only on the weekly refresh.

Changes:
- `metaTokenAlarm.ts`: any Meta send answered with HTTP 401 / code 190 alerts the owner immediately (3-hour cooldown per key).
- `igTokenWatch.ts`: a cheap `/me` probe every 6-hour run between refreshes; no owner alert when Instagram already goes via the Page.
- `fbTokenWatch.ts`: renewal text points to the `shirin-bot` system user; red alert when Instagram-via-Page is on but the Page key lacks `instagram_manage_messages`; the log notes a personal Page key.
- Setting `igSendVia` ("instagram" default, "page") with a radio in Settings: Instagram replies, reactions, comment replies/deletes, permalinks and profiles go through graph.facebook.com with the Page key.

Inventory and the owner's Meta Business steps: `docs/meta-tokens.md`.

Verified: typecheck, lint (0 errors), API 1884 tests, web 456 tests; new `instagramViaPage.test.ts` and extended watch tests. Production was only read (debug_token metadata, no values printed). Not verified: identical Instagram-scoped IDs between the two webhook paths; the switch must be tested with one real DM after the system-user key is in place.
