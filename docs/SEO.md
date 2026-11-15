# SEO: Google и Яндекс, русский и таджикский

Статус на 2026-11-15 (SCH-04; первая версия — 2026-11-08). Метки: ФАКТ (замер `curl` по проду и локальной сборке), ОЦЕНКА, НЕТ ДАННЫХ.

## Диагноз

ФАКТ: публичный сайт уже отдаёт готовый HTML (генератор `apps/web/scripts/build-site-pages.mjs`, 9 страниц × ru/tg),
у каждой страницы свои title/description, один h1, canonical на себя, hreflang ru/tg/x-default, Open Graph,
JSON-LD (Organization, WebSite, Course, BreadcrumbList, FAQPage), есть `sitemap.xml` и `robots.txt`;
http→https, www→без www, `.html`→чистый адрес работают; Googlebot/YandexBot по User-Agent получают 200
(с IP Google и Яндекса не проверялось, НЕТ ДАННЫХ). Приватное закрыто: `/course`, `/l/…`, `/panel` — noindex (мета-тег в самом HTML плюс заголовок `X-Robots-Tag` в nginx), `/panel` — ещё и Cloudflare Access.

Вывод (ОЦЕНКА): код не причина. Нет подтверждения сайта в Search Console и Вебмастере, нет Метрики,
домен новый, внешних ссылок почти нет. Позиции и трафик — НЕТ ДАННЫХ (кабинетов нет).

Слабые места (на 2026-11-15): `/favicon.ico` уже отдаётся (200, добавлен в main отдельно); `/l/…` не запрещён в robots (закрываем здесь); заголовок `X-Robots-Tag` на проде пока не виден (приедет с выкаткой этой ветки);
короткие страницы `/otzyvy` и `/sertifikat` (265–336 слов вместе с меню и подвалом); отзывов на сайте нет;
имя «Shirin» совпадает с кондитерской фабрикой «Ширин» — продвигать связку «Shirin Sweets» + «Душанбе».

## Подтверждение в Google и Яндексе — уже есть, коды в `site.json` не нужны

ФАКТ (замер 2026-11-15, `nslookup -type=TXT shirinsweets.online`, публичный DNS 1.1.1.1): на домене есть обе TXT-записи —
`google-site-verification=…` и `yandex-verification: …` (значения здесь не приводим; они лежат в DNS Cloudflare).
Подтверждение через DNS действует на весь домен, поэтому мета-теги в HTML не требуются: поля
`verification.google` и `verification.yandex` в `site-content/site.json` остаются **пустыми**, тегов на сайте нет
(проверено: на главной `shirinsweets.online` меток `google-site-verification` / `yandex-verification` нет).
Поля — запасной путь: если запись из DNS когда-нибудь пропадёт, код из кабинета вставляется в них (тест
`tests/site/pages.test.ts`). НЕТ ДАННЫХ: что сайт именно «подтверждён» в самих кабинетах — это видно только в
Search Console и Вебмастере (в них я не входил); наличие TXT — необходимое условие, но не доказательство.

Из пункта 1 и 2 ниже («Что должен сделать владелец») поэтому остаются только отправка sitemap и запрос индексирования.

## Что сделано в коде (всё безвредно по умолчанию)

- `robots.txt`: `Disallow: /l/` (персональные ссылки доступа). `/course` и `/panel` в robots **не** упоминаются и остаются
  доступны роботу, чтобы он прочитал noindex; адрес панели нигде не светим.
- `nginx.conf`: `X-Robots-Tag: noindex, nofollow` ровно на `/course`, `/course/`, `/l/`, `/panel`, `/panel/`
  (вторая защита рядом с `<meta name="robots">` в `course.html` и `index.html`). На главную и публичные страницы заголовок
  не ставится; в `nginx.conf` нет `add_header X-Robots-Tag` вне этих location, поэтому один сломанный блок не закроет весь сайт.
- `site-content/site.json` → `verification.*`: запасные места под коды подтверждения (сейчас пусто, см. выше).
- Тесты (`apps/web/tests/site/pages.test.ts`): список noindex-путей в nginx сверяется с эталоном, на публичных страницах
  нет noindex ни в мета-теге, ни в nginx; приватные приложения несут noindex в HTML.

## Таблица проверенных страниц (локальная сборка)

| Страница | title | description | Разметка | Слов (с меню) |
|---|---|---|---|---|
| / | 56 | 150 | Organization, WebSite, FAQPage | 818 |
| /online-kurs | 56 | 153 | Organization, BreadcrumbList, Course, FAQPage | 652 |
| /art-desserty | 53 | 147 | Organization, BreadcrumbList, Course, FAQPage | 630 |
| /kursy-konditera-dushanbe | 57 | 144 | Organization, BreadcrumbList, Course, FAQPage | 546 |
| /sertifikat | 54 | 144 | Organization, BreadcrumbList | 304 |
| /otzyvy | 44 | 141 | Organization, BreadcrumbList | 265 |
| /faq | 51 | 149 | Organization, BreadcrumbList, FAQPage | 431 |
| /o-shirin | 55 | 156 | Organization, BreadcrumbList | 355 |
| /politika-konfidentsialnosti | 43 | 142 | Organization, BreadcrumbList | 761 |
| /tg/ | 54 | 151 | Organization, WebSite, FAQPage | 880 |
| /tg/online-kurs | 57 | 143 | Organization, BreadcrumbList, Course, FAQPage | 711 |
| /tg/art-desserty | 53 | 141 | Organization, BreadcrumbList, Course, FAQPage | 688 |
| /tg/kursy-konditera-dushanbe | 55 | 151 | Organization, BreadcrumbList, Course, FAQPage | 601 |
| /tg/sertifikat | 52 | 136 | Organization, BreadcrumbList | 336 |
| /tg/otzyvy | 51 | 137 | Organization, BreadcrumbList | 286 |
| /tg/faq | 55 | 117 | Organization, BreadcrumbList, FAQPage | 484 |
| /tg/o-shirin | 56 | 122 | Organization, BreadcrumbList | 383 |
| /tg/politika-konfidentsialnosti | 31 | 141 | Organization, BreadcrumbList | 825 |

Все 18 страниц: canonical на себя, hreflang ru/tg/x-default, `lang` ru или tg, в sitemap.

## Что должен сделать владелец (я в его аккаунты не вхожу)

1. **Google Search Console**: ресурс уже подтверждается через DNS (см. выше); если в кабинете его нет — добавь ресурс «Домен» `shirinsweets.online`. Затем «Файлы Sitemap» → введи `sitemap.xml` → «Отправить». Затем «Проверка URL» → вставь главную → «Запросить индексирование» (так же для `/tg/`, `/online-kurs`, `/kursy-konditera-dushanbe`).
2. **Яндекс.Вебмастер**: подтверждение через DNS уже есть (см. выше); если сайта в кабинете нет — добавь `https://shirinsweets.online` и нажми «Проверить». Затем «Индексирование» → «Файлы Sitemap» → добавь `https://shirinsweets.online/sitemap.xml`. «Региональность» → Душанбе (или Таджикистан, если предложат).
3. **Яндекс.Метрика** и **Яндекс Бизнес**: завести счётчик и карточку организации (адрес, телефон, часы — как в `site.json`). Счётчик вставлю после твоего номера и «да» (нужна правка CSP и баннер согласия).
4. **Google Business Profile**: business.google.com → «Добавить компанию» → адрес в Душанбе, телефон, сайт. Подтверждение приходит им самим (звонок/код).
5. **Ссылки на сайт**: в описании Instagram, TikTok, Telegram, Facebook поставить `https://shirinsweets.online/` (для таджикской аудитории — `/tg/`). Это первые внешние ссылки.
6. После выкатки: через 3–7 дней проверить в обоих кабинетах «Страницы в поиске»; присылай скриншоты — разберу.

## Что ещё предлагаю (в код не внёс, нужен текст или «да»)

- **Отзывы**: реальные отзывы выпускниц с их согласием (и отметка Review в разметке только на настоящие). Сейчас страница отсылает в Instagram.
- **Углубить короткие страницы** (`/otzyvy`, `/sertifikat`) фактами из проекта: что в сертификате, как получить. Не выдумывать.
- **Предложения заголовков** (русский, для вычитки; таджикский — только через носителя):
  `/kursy-konditera-dushanbe` — «Курсы кондитера в Душанбе: 8 дней, 20 десертов» (уже близко);
  `/online-kurs` — «Онлайн-курс кондитера на таджикском языке»; `/art-desserty` — оставить как есть.
- **Яндекс и таджикский**: Яндекс слабо различает таджикский, поэтому русские страницы продвигаем по запросам «курсы кондитера Душанбе», «онлайн курсы кондитера Таджикистан»; таджикские — по «курсҳои қаннодӣ», «омӯзиши қаннодӣ».
- **lastmod в sitemap**: добавлять только с настоящей датой правки текста (сейчас сознательно нет).
- **Скорость** (Core Web Vitals) — отдельная сессия.
