/**
 * ТЕКСТЫ БОТА ШКОЛЫ — ВЫКАТКА 11.11.2026 (ветка fix/bot-human-sales).
 *
 * Что меняет в базе (только это):
 *  1) Setting aiPrompt — новый короткий промпт «как живая Ширин» (старый → aiPromptBackup20261111);
 *  2) Setting objectionLibrary — убраны «бе телеграм намешад» / «факат да телеграм» и старая
 *     карточка офлайна «15 сентябр, Рудаки 156» (старая → objectionLibraryBackup20261111);
 *  3) FunnelStep: директ-воронка, шаг 20 — без второго «Ассалому алейкум»; обе воронки,
 *     шаг 20 — «дарсхо дар Telegram ё дар сайти мо»; обе воронки, шаг 30 (офлайн) — адрес
 *     «Рудаки 177, назди Воданасос» и число видов через подстановки {адрес} {десерты}
 *     {дата} {время} + фото «МЕНЮ КУРСА» офлайна (старые тексты → Setting funnelStepsBackup20261111);
 *  4) Setting menuMediaUrls — картинки меню (онлайн 21, арт-десерты, офлайн), если ещё не задано;
 *     Setting testimonialsLinkUrl — ссылка на актуальные с отзывами из прежнего промпта владельца,
 *     если ещё не задано.
 *
 * ИДЕМПОТЕНТНО: повторный запуск ничего не портит — бэкап пишется только один раз,
 * уже применённые значения не трогаются. ПО УМОЛЧАНИЮ ТОЛЬКО ПОКАЗЫВАЕТ, что изменит;
 * писать — только с APPLY=1. Секретов не печатает.
 *
 * Запуск на сервере (после выкатки кода, с «да» владельца):
 *   cd /opt/sweet-school-bot
 *   docker compose exec -T api node --input-type=module - < ops/2026-11-11-bot-texts.mjs           # проверка
 *   docker compose exec -T -e APPLY=1 api node --input-type=module - < ops/2026-11-11-bot-texts.mjs  # запись
 * Откат: значения из Setting aiPromptBackup20261111 / objectionLibraryBackup20261111 /
 * funnelStepsBackup20261111 вернуть на место (тем же способом, вручную).
 */
const DB_MODULE = process.env.DB_MODULE ?? "/app/apps/api/dist/db.js";
const APPLY = process.env.APPLY === "1";
const { prisma } = await import(DB_MODULE);

const MARKER = "ВЕРСИЯ ПРОМПТА 2026-11-11";

const NEW_PROMPT = `${MARKER}

КТО ТЫ
Ты пишешь от имени Ширин, кондитера из Душанбе, в её Instagram. Ты не бот и не признаёшься в этом. Пиши как она сама в телефоне: коротко, тепло, по делу. Одна мысль в сообщении, 1–2 коротких предложения. Без списков, без лекций, без «отличный вопрос».

КАК ПРОДАЁШЬ
Сначала прямой ответ на вопрос. Потом один лёгкий шаг: какой курс интересует или номер для оплаты. Не дави, не торопи, не выдумывай срочность. «Хочу», «как оплатить», «номер дайте» — сразу реквизиты одной строкой. Сомневается — коротко сними сомнение и остановись. «Подумаю» — «Албатта, саломат бошед».

ЯЗЫК
Пиши на языке клиента. Таджикский — живой разговорный душанбинский, как пишут сами клиентки: мешан, мекнем, мегирен, монен, мебинен, кати, хамуча, чиба, маъкул. Без книжных слов (мебошад, мутаассифона, лутфан, муфассал). Только «шумо» / «вы». Никак не называй человека (ни «апа», ни «апачон», ни «хохарчон»). Здороваешься один раз за разговор; если в истории уже было приветствие — сразу по делу. Смайлики не ставь, их добавит сама система, когда уместно.

ОНЛАЙН-КУРСЫ (уроки уже готовы, смотрите с телефона, остаются у вас навсегда)
1) «21 рецепт» — 70 сомони. 21 видеоурок с нуля на таджикском + текстовые рецепты. Меню: Клубника в шоколаде, Чизкейк Твикс, Пирожное Сникерс, Чизкейк Дубайский шоколад, Орео, Красный бархат, Рафаэлло, Фисташковое, Вупи пай, Шоколадное с ганашом, Чизкейк тортики, Шоколадный торт, Карамельный торт, Анна Павлова, Трайфл, Эклеры, Шу, Рулет Меренга, Афганская пахлава, Творожный пирог, Банановое пирожное. Названия десертов не переводи.
2) «Арт-десерты» — 50 сомони. 9 видов арт-десертов, видео на таджикском.
Оба курса вместе — 100 сомони.
Где уроки: в закрытой Telegram-группе или на нашем сайте — после оплаты откроем, как удобно. Нет Telegram — не беда: «Парво надорад, дар сайти мо мебинен, вай хам хамеша мемонад». Никогда не говори, что без Telegram нельзя.
Рецепты отдельно не продаются, только курс целиком. Сертификат входит в стоимость. Скидок, рассрочки, «50 на 50» нет — цены уже со скидкой.
Спросили про меню — система сама пришлёт фото меню, перечислять все десерты не нужно.

ОФЛАЙН-КУРС В ДУШАНБЕ
700 сомони, продукты наши. 8 дней, с 13:40 до 16:30. 22 вида десертов, арт-десерты тоже входят, всё испечённое забираете с собой, в конце сертификат. Адрес: Душанбе, Рудаки 177, назди Воданасос. Ближайший набор — 20 ноября (если ниже в строке «Офлайн-курс: …» другая дата, верна она). Запись без предоплаты: имя и номер телефона.
Про офлайн говори, только если человек сам спросил про офлайн, очно, адрес или «дар назди шумо». «Курс», «кай сар мешавад», «онлайн», «арзон», «харду курс» — это про онлайн.

ОПЛАТА
905 355 355, Фарангис Чаборова (Алиф или Душанбе Сити). Номер пиши один раз; если он уже есть выше — «номерро болотар навиштам». После оплаты — прислать сюда скриншот чека, ссылка на уроки придёт сюда же. Чек уже прислали и ссылку получили — чек больше не проси.

ТЕХНИКА
Нужна духовка с конвекцией. Печи «Odul» не подходят. Про другие марки не знаешь — не угадывай. Миксер любой. Учиться можно с 12 лет, младше — если ребёнок уже готовит.

НЕ ЗНАЕШЬ — НЕ ВЫДУМЫВАЙ
Нет ответа здесь или в блоках ниже (оплата из другой страны или с чужой карты, скачать видео, другая марка печи, как именно выдаётся сертификат, сроки, что-то личное) — верни ровно [ASK_SHIRIN]. Система скажет «Ширин сама ответит» и позовёт её.

ЗНАКОМЫЕ ШИРИН
С этого аккаунта Ширин переписывается и со своими. Если человек пишет НЕ про курсы (как дела, привет от кого-то, личный разговор, зовёт куда-то) — верни [NO_REPLY]. Сомневаешься, клиент или знакомая, — лучше [NO_REPLY].

ЧАСТОЕ
«Дорого», «скидка есть?» — «Ин нарххо аллакай бо скидка хастан». Боится, что не получится — «Хавотир нашавен, хамааш аз нол фахмондагиай, хамаи шогирдомон ёд гирифтан». Прислал фото десерта — одно короткое тёплое слово. «Рахмат», «хоб», «ок» — [NO_REPLY]. Курсов салатов и другой еды нет. Готовые торты на заказ не продаём — только учим.`;

const ONLY_TELEGRAM = /бе\s*телеграм\s*намеш|факат\s+(да|дар)\s+телеграм|фақат\s+(да|дар)\s+телеграм|да\s+ватсап\s+сифат|телеграм\s+ичозат\s+нест/iu;
const OLD_OFFLINE = /Рудаки\s*156|Додо\s*Пицца|15\s*сентябр/iu;

const MENU_MEDIA = {
  online70: ["https://shirinsweets.online/media/2a63855d-368c-40fc-b642-037a431e4def.jpg"],
  online50: ["https://manybot-thumbnails.s3.eu-central-1.amazonaws.com/fb4433534/ca/big_69c2e6c900233215cc5859be98a8dfac.png"],
  offline: ["https://shirinsweets.online/media/11711421-2fc6-462b-9127-ec74e194ab97.jpg"],
};
const OFFLINE_MENU_PHOTO = MENU_MEDIA.offline[0];

const OFFLINE_STEP_TEXT =
  "Курси ояндамон {дата} сар мешавад 700 сом пули продукты наметиен курс 8 руз давом дорад {десерты} намуд ширини таер мекунем, " +
  "арт десерхоям дохил мешан, аз соати {время} чизеки мепазем хамрох мебарен охирда сертификат мегирен " +
  "Сурога: {адрес}, барои запись ном и номер монен запись мекнем";

const plan = [];
async function getSetting(key) {
  return (await prisma.setting.findUnique({ where: { key } }))?.value ?? null;
}
async function setOnce(key, value, why) {
  if ((await getSetting(key)) !== null) return;
  plan.push({ what: `Setting ${key} (создать: ${why})`, run: () => prisma.setting.create({ data: { key, value } }) });
}
async function setValue(key, value, why) {
  plan.push({ what: `Setting ${key} (${why})`, run: () => prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } }) });
}

// 1) Промпт.
const oldPrompt = await getSetting("aiPrompt");
if (!oldPrompt?.startsWith(MARKER)) {
  if (oldPrompt) await setOnce("aiPromptBackup20261111", oldPrompt, `бэкап старого промпта, ${oldPrompt.length} знаков`);
  await setValue("aiPrompt", NEW_PROMPT, `новый промпт, ${NEW_PROMPT.length} знаков вместо ${oldPrompt?.length ?? 0}`);
}

// 2) Библиотека возражений.
const rawLib = await getSetting("objectionLibrary");
if (rawLib) {
  let list = [];
  try {
    list = JSON.parse(rawLib);
  } catch {
    list = null;
  }
  if (Array.isArray(list)) {
    const keep = list.filter((e) => !ONLY_TELEGRAM.test(e?.counterThatWorked ?? "") && !OLD_OFFLINE.test(e?.counterThatWorked ?? ""));
    if (keep.length !== list.length) {
      await setOnce("objectionLibraryBackup20261111", rawLib, "бэкап библиотеки возражений");
      await setValue("objectionLibrary", JSON.stringify(keep), `убрать ${list.length - keep.length} из ${list.length} записей (только Telegram / старый офлайн)`);
    }
  }
}

// 3) Шаги воронок.
const funnels = await prisma.funnel.findMany({ include: { steps: true } });
const stepBackup = [];
for (const funnel of funnels) {
  for (const step of funnel.steps) {
    let text = step.text;
    const data = {};
    if (step.order === 20) {
      if (funnel.trigger === "DM") text = text.replace(/^\s*Ассалому\s+алейкум[^\n]*\n+/u, "");
      text = text.replace(/Дарсҳо\s+дар\s+телеграм(?!\s+ё)/iu, "Дарсҳо дар Telegram ё дар сайти мо");
    }
    if (step.order === 30 && OLD_OFFLINE.test(text)) {
      text = OFFLINE_STEP_TEXT;
      if (!step.mediaUrl) {
        data.mediaUrl = OFFLINE_MENU_PHOTO;
        data.mediaType = "image";
      }
    }
    if (text !== step.text) data.text = text;
    if (Object.keys(data).length > 0) {
      stepBackup.push({ funnelId: funnel.id, order: step.order, text: step.text, mediaUrl: step.mediaUrl, mediaType: step.mediaType });
      plan.push({
        what: `FunnelStep ${funnel.trigger} #${step.order}: ${Object.keys(data).join(", ")}`,
        run: () => prisma.funnelStep.update({ where: { id: step.id }, data }),
      });
    }
  }
}
if (stepBackup.length > 0) await setOnce("funnelStepsBackup20261111", JSON.stringify(stepBackup), `бэкап ${stepBackup.length} шагов воронки`);

// 4) Медиа меню и ссылка на отзывы.
await setOnce("menuMediaUrls", JSON.stringify(MENU_MEDIA), "картинки меню от владельца");
const highlights = /https:\/\/www\.instagram\.com\/stories\/highlights\/\d+\/?/u.exec(oldPrompt ?? "")?.[0];
if (highlights) await setOnce("testimonialsLinkUrl", highlights, "ссылка на актуальные с отзывами из прежнего промпта владельца");

// Бэкапы — первыми, чтобы запись не прошла без них.
plan.sort((a, b) => Number(/Backup/.test(b.what)) - Number(/Backup/.test(a.what)));
if (plan.length === 0) console.log("Уже применено: менять нечего.");
for (const step of plan) console.log(`${APPLY ? "ПИШУ" : "ИЗМЕНИТ"}: ${step.what}`);
if (APPLY) {
  for (const step of plan) await step.run();
  console.log(`Готово: ${plan.length} изменений.`);
} else if (plan.length > 0) {
  console.log("Это проверка. Записать: APPLY=1.");
}
await prisma.$disconnect();
