# Production administrator access

Production requires Cloudflare Access. There is no password or Telegram fallback;
old application JWTs cannot authorize requests. Development/test environments retain
the legacy login for local fixtures only. `NODE_ENV=production` fails closed when
Access is disabled or incomplete.

Configure these server environment variables before deploying:

- `SCHOOL_ACCESS_TEAM_DOMAIN`: the team's `*.cloudflareaccess.com` hostname.
- `SCHOOL_ACCESS_AUDIENCE`: the unique 64-character school application AUD tag.
- `SCHOOL_ADMIN_EMAIL`: the single authorized owner address.
- `SCHOOL_ADMIN_ORIGINS`: comma-separated exact HTTPS origins, without trailing slashes.

The production compose file enforces `SCHOOL_ACCESS_REQUIRED=1`. Protect `/admin*`
and `/panel*` on every school hostname in the Access application. Keep public site,
student course, media and webhook routes outside this application. Configure the
owner-only Allow policy, required MFA, **1 hour** application and MFA sessions,
HttpOnly, a binding cookie and SameSite=Lax. Do not add bypass/service-auth policies.
The application assertion must be RS256-signed by the configured team, for this
application, with the authorized email and at most a one-hour lifetime.

The server guard runs before every router, JSON body parsing and CORS. It rejects
legacy login and form-setting endpoints and enforces an exact Origin on all writes.
The frontend uses the Access HttpOnly cookie, removes its old localStorage token,
and never receives or persists the assertion. Logout first persists a SHA-256
fingerprint of the current assertion in `AdminSessionRevocation`, then navigates to
the Access logout endpoint. Revoked assertions remain rejected after process restart.
Other devices/sessions are separate; revoke them through the Access dashboard.

Before release: back up the SQLite database, preserve the APK and runtime .env,
apply the additive migration, run source/cloud checks and verify public/student
routes, denied anonymous admin calls, valid owner MFA login and logout. Keep the
Access policies active if reverting code; do not reopen legacy external access.
