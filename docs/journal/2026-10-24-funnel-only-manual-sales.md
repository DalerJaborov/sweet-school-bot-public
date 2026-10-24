# Funnel-only automation and manual course sales

The storefront previously opened a sales chatbot even while customer AI replies were disabled. Receipt intake and selected background paths also bypassed the funnel-only pause.

Customer automation now checks the pause at intake, processing and outbound transport boundaries. Existing funnel steps retain a narrowly scoped send permission; authenticated owner actions remain explicit. Retry queues preserve their pending work while paused.

Course cards open a human WhatsApp order with current catalogue prices. A protected manual enrollment form records an owner's verified payment and returns a personal course link without sending messages or creating receipts. The transaction preserves existing purchases and links on retries, checks course readiness and refuses to silently restore revoked access.

Additional fixes cover RU/TG content and explicit locale URLs, real lesson lists, canonical aliases, sitemap accuracy, private-page noindex, page-specific image preloads, phone validation, iPhone watermarks, HTTP caching of student data and offline access expiry. Demonstration review quotes were removed. Dependency versions were updated for known registry advisories, including the Vite/Vitest toolchain with the previous browser coverage retained.

No production student, receipt, purchase or outbound message was created for verification. Source tests and cloud checks are separate from deployment and real-device/payment acceptance.
