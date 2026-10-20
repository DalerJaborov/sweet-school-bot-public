# Public source migration — 21.10.2026

Use DalerJaborov/sweet-school-bot-public, branch from current origin/main. Historical private checkouts and incident evidence remain archived. Do not merge or push their history into this repository; port reviewed source/test diffs only. Keep runtime configuration, databases, private reports and deploy artifacts outside Git. Configure local hooks with `git config core.hooksPath .githooks`. Cloud checks and a protected-main PR are required before release.

The existing production checkout now tracks this public main. Verify production health separately from GitHub checks. Preserve persistent Docker volumes and server configuration.

The Android APK is retained as a separate server artifact; copy the operator-provided APK to apps/web/public/app/shirin-sweets.apk before a production web build. The Git source and cloud tests intentionally exclude this binary.

