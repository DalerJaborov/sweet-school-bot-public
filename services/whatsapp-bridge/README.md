# School WhatsApp linked-device bridge

Internal transport adapter, not a separate AI. Pinned `whatsapp-web.js` 1.34.7,
verified against npm at implementation. The school API owns business rules,
knowledge, purchase verification and conversation processing.

Puppeteer is overridden to 25.16.0 and optional RemoteAuth dependencies are
omitted (this service uses LocalAuth). The locked production install passes
dependency audit and isolated Node 22/Chromium launch tests. A real paired
session remains a separate acceptance check after deployment.

## Runtime

- Build context: this directory; `Dockerfile` runs Node 22 + system Chromium as
  non-root, with `tini` for signal handling. Do not expose port 4200 publicly.
- Required: `SCHOOL_WHATSAPP_TOKEN` (at least 32 random characters), shared only
  with the school API. All HTTP endpoints require `Authorization: Bearer …`.
- Persistent writable volume `/data`; Chromium session `/data/auth`, bridge state
  `/data/state/state.json`. Keep this volume private, backed up and out of Git.
- `SCHOOL_WHATSAPP_MEDIA_HOSTS`: comma-separated exact HTTPS host allowlist for
  outbound school media. Redirects and unapproved hosts are rejected. Empty list
  disables outbound media URLs. Never add untrusted/internal hosts.
- Optional `PORT` (4200), `CHROMIUM_PATH`, `SCHOOL_WHATSAPP_AUTH_DIR`,
  `SCHOOL_WHATSAPP_STATE_DIR`. Session startup reconnects automatically, but a new
  account remains paused until explicit `/resume` after contact synchronization.
- Run `npm ci --ignore-scripts`, `npm test`. No credentials or real messaging are
  used by tests. Local startup additionally requires Chromium.

## HTTP contract

`GET /status` returns `{state, qrDataUrl, accountId, accountMasked, contactsReady,
blockedCount, enabled, lastError}`. QR data is transient and never logged.
`accountId` is a stable serialized WhatsApp ID, not the masked UI representation.

`POST /start`, `/pause`, `/resume`, `/logout` return status. Pause does not unlink
the phone. Logout does. `/resume` refuses a missing or unavailable contact list.

`GET /events` returns `{events:[{id,messageId,accountId,type,chatId,timestamp,text,
media?,mediaUnavailable?,takenOver?}]}`; type is `incoming` or `human`, timestamp
is Unix milliseconds, media is `{data:<base64>,mimeType,filename?}`. ID equals the
WhatsApp serialized message ID. Maximum 10 events and approximately 12 MiB per
response, at most 8 MiB binary per media. Only images/audio with known bounded
size are downloaded. Missing size or unsupported media is explicitly marked.
`POST /events/:urlEncodedId/ack` marks acknowledgement, strips stored media but
retains the original incoming event as reply authorization for seven days.
The API must durably store an event **before** acknowledgement.

`POST /send` accepts `{operationId,chatId,replyToId,text?,mediaUrl?,mediaType?,
purpose}` and returns `{operationId,messageId,status:'sent'}`. `replyToId` must
identify an observed incoming message for that exact account/chat no older than
24 hours. `purpose` is `reply` or `verified_receipt_access`. The latter bypasses
only permanent human takeover, never saved-contact blocks, pause or freshness.
The API is responsible for attesting a verified purchase and issuing that narrow
purpose only for the corresponding course-access delivery. Never expose this
internal endpoint to browsers or customer input.

Stable operation IDs are mandatory across retries. Same ID/same payload returns
the original receipt. Changed payload, an interrupted send or a transport error
returns 409: outcome may be uncertain, so **do not automatically send again with
a new operation ID**. Reconcile/operator-review uncertain sends. Exactly-once
delivery across a remote connection failure cannot be guaranteed.

`GET /contact-status?chatId=…` returns fresh `{blocked,isMyContact,aliases,
takenOver,identityResolved}`. Failure to resolve identity/contact status denies
automation. `POST /contacts/block {chatId}` permanently excludes the contact from
the assistant without blocking them in WhatsApp. `POST /takeover/reset {chatId}`
clears human takeover only; it never clears saved-contact exclusions.

## Personal-number protection

Saved contacts are remembered as permanent exclusions, including known LID/phone
aliases. They are not imported as conversation events. Every inbound and outgoing
message rechecks current contact state; contacts also rescan every 60 seconds.
Removal from a later contact snapshot never removes an existing exclusion.
Groups, broadcasts, status, system messages and history predating the current
connection are ignored. Newly observed phone replies permanently stop normal
automation; their text is retained only for non-excluded customer chats.
Own-send echoes are matched to reserved operations, including early echo races.
Account changes isolate all queues, preferences and exclusions by account ID.

**Limit:** the library's `getContacts()` returns current WhatsApp contact instances,
not a certified complete phone address-book export. `ready` alone does not prove
completeness. Empty/error contact snapshots and unknown contact/identity facts
fail closed; fresh checks reduce but cannot mathematically eliminate incomplete
phone synchronization. Do not advertise a guarantee that every phone contact
has been discovered. `contact_changed` is a number-change event, not a universal
saved-contact event. No contact `block()`/`unblock()` calls are used.

Linked-device automation is unofficial. Persistent sessions, small traffic and
reply-only operation do not guarantee against unlinking or account restrictions.
The implementation does not spoof human identity or claim anti-ban protection.

References: [Client API](https://docs.wwebjs.dev/Client.html),
[Contact API](https://docs.wwebjs.dev/Contact.html),
[LocalAuth](https://docs.wwebjs.dev/LocalAuth.html).
