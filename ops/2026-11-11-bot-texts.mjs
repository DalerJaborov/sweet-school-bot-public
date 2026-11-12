/**
 * ТЕКСТЫ БОТА ШКОЛЫ — ВЫКАТКА 11.11.2026 (ветка fix/bot-human-sales).
 *
 * Что меняет в базе (только это):
 *  1) Setting aiPrompt — новый короткий промпт «как живая Ширин»;
 *  2) Setting objectionLibrary — убраны «бе телеграм намешад» / «факат да телеграм» и старая
 *     карточка офлайна «15 сентябр, Рудаки 156»;
 *  3) FunnelStep: директ-воронка, шаг 20 — без второго «Ассалому алейкум»; обе воронки,
 *     шаг 20 — «дарсхо дар Telegram ё дар сайти мо»; обе воронки, шаг 30 (офлайн) — адрес
 *     «Рудаки 177, назди Воданасос» и число видов через подстановки {адрес} {десерты}
 *     {дата} {время} + фото «МЕНЮ КУРСА» офлайна;
 *  4) Setting menuMediaUrls — картинки меню (онлайн 21, арт-десерты, офлайн), если ещё не задано;
 *     Setting testimonialsLinkUrl — ссылка на актуальные с отзывами из прежнего промпта владельца,
 *     если ещё не задано.
 *
 * ПО УМОЛЧАНИЮ ТОЛЬКО ПОКАЗЫВАЕТ «было → стало» (промпт — первые и последние строки и
 * длина, шаги воронки — полный текст). Писать — только с APPLY=1. Секретов не печатает:
 * токены и ключи скрипт не читает вовсе.
 *
 * БЕЗОПАСНОСТЬ ЗАПИСИ (ревью 11.11.2026):
 *  - каждый APPLY, который что-то меняет, пишет СВОЙ бэкап с меткой времени —
 *    Setting `botTextsBackup20261111@<время>` (JSON всех прежних значений, которые
 *    этот запуск меняет). Прежние бэкапы не перезаписываются никогда;
 *  - бэкап и все правки — одной транзакцией (prisma.$transaction): либо всё, либо ничего;
 *  - повторный запуск идемпотентен: уже применённое (промпт с меткой версии, шаги с
 *    новым текстом) не трогает. Если владелец потом поправил тексты сам и снял метку —
 *    новый APPLY перезапишет только с новым бэкапом его правки;
 *  - правка шага 20/30, которую скрипт не узнал (текст не похож на ожидаемый), не
 *    молчит: печатает «НЕ ПРИМЕНИТСЯ: …» — такой шаг правьте руками в панели.
 *
 * Запуск на сервере (после выкатки кода, с «да» владельца):
 *   cd /opt/sweet-school-bot
 *   docker compose exec -T api node --input-type=module - < ops/2026-11-11-bot-texts.mjs           # проверка
 *   docker compose exec -T -e APPLY=1 api node --input-type=module - < ops/2026-11-11-bot-texts.mjs  # запись
 * Откат: значения из последнего Setting botTextsBackup20261111@… вернуть на место (тем же
 * способом, вручную): aiPrompt, objectionLibrary, steps[] по funnelId+order.
 */

export const MARKER = "ВЕРСИЯ ПРОМПТА 2026-11-11";
export const BACKUP_PREFIX = "botTextsBackup20261111@";

const NEW_PROMPT = `${MARKER}

КТО ТЫ
Ты пишешь от имени Ширин, кондитера из Душанбе, в её Instagram. Ты не бот и не признаёшься в этом. Пиши как она сама в телефоне: коротко, тепло, по делу. Одна мысль в сообщении, 1–2 коротких предложения. Без списков, без лекций, без «отличный вопрос».

КАК ПРОДАЁШЬ
Сначала прямой ответ на вопрос. Потом один лёгкий шаг: какой курс интересует или номер для оплаты. Не дави, не торопи, не выдумывай срочность. «Хочу», «как оплатить», «номер дайте» — сразу реквизиты одной строкой. Сомневается — коротко сними сомнение и остановись. «Подумаю» — «Албатта, саломат бошед».

ЯЗЫК
Пиши на языке клиента. Таджикский — живой разговорный душанбинский, как пишут сами клиентки: мешан, мекнем, мегирен, монен, мебинен, кати, хамуча, чиба, маъкул. Без книжных слов (мебошад, мутаассифона, лутфан, муфассал). Только «шумо» / «вы». Никак не называй человека (ни «апа», ни «апачон», ни «хохарчон»). Здороваешься один раз за разговор; если в истории уже было приветствие — сразу по делу. Смайлики сам не ставь: когда уместно, их добавляет система.

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
Нет ответа здесь или в блоках ниже (оплата из другой страны или с чужой карты, скачать видео, другая марка печи, как именно выдаётся сертификат, сроки, что-то личное) — верни ровно [ASK_SHIRIN]. Система ответит «сейчас уточню и напишу вам» и позовёт человека.

ЗНАКОМЫЕ ШИРИН
С этого аккаунта Ширин переписывается и со своими. Если человек пишет НЕ про курсы (как дела, привет от кого-то, личный разговор, зовёт куда-то) — верни [NO_REPLY]. Сомневаешься, клиент или знакомая, — лучше [NO_REPLY].

ЧАСТОЕ
«Дорого», «скидка есть?» — «Ин нарххо аллакай бо скидка хастан». Боится, что не получится — «Хавотир нашавен, хамааш аз нол фахмондагиай, хамаи шогирдомон ёд гирифтан». Прислал фото десерта — одно короткое тёплое слово. «Рахмат», «хоб», «ок» — [NO_REPLY]. Курсов салатов и другой еды нет. Готовые торты на заказ не продаём — только учим.`;

const MENU_MEDIA = {
  online70: ["https://shirinsweets.online/media/2a63855d-368c-40fc-b642-037a431e4def.jpg"],
  online50: ["https://shirinsweets.online/media/mb-f7e90459f2bd2579.png"],
  offline: ["https://shirinsweets.online/media/11711421-2fc6-462b-9127-ec74e194ab97.jpg"],
};
const OFFLINE_MENU_PHOTO = MENU_MEDIA.offline[0];

const OFFLINE_STEP_TEXT =
  "Курси ояндамон {дата} сар мешавад 700 сом пули продукты наметиен курс 8 руз давом дорад {десерты} намуд ширини таер мекунем, " +
  "арт десерхоям дохил мешан, аз соати {время} чизеки мепазем хамрох мебарен охирда сертификат мегирен " +
  "Сурога: {адрес}, барои запись ном и номер монен запись мекнем";

const ONLY_TELEGRAM = /бе\s*телеграм\s*намеш|факат\s+(да|дар)\s+телеграм|фақат\s+(да|дар)\s+телеграм|да\s+ватсап\s+сифат|телеграм\s+ичозат\s+нест/iu;
const OLD_OFFLINE = /Рудаки\s*156|Додо\s*Пицца|15\s*сентябр/iu;
const DM_GREETING = /^\s*Ассал[оа]м[уy]?\s+ал[ае]йкум[^\n]*\n+/iu;
const TELEGRAM_ONLY_LINE = /Дарс[ҳх]о\s+дар\s+телеграм(?!\s+ё)/iu;
const TELEGRAM_OR_SITE = "Дарсҳо дар Telegram ё дар сайти мо";

/** Длинный текст для журнала: первые и последние строки и длина (полный промпт в консоль не льём). */
export function preview(text, lines = 3) {
  if (text == null) return "(пусто)";
  const all = String(text).split("\n");
  const head = all.slice(0, lines);
  const tail = all.length > lines * 2 ? ["…", ...all.slice(-lines)] : all.slice(lines);
  return [...head, ...tail].map((l) => `    | ${l}`).join("\n") + `\n    (${String(text).length} знаков, ${all.length} строк)`;
}

function full(text) {
  return text == null ? "    (пусто)" : String(text).split("\n").map((l) => `    | ${l}`).join("\n");
}

/**
 * Собирает план без записи. Возвращает { changes, notes, backup }:
 *  changes — что изменится (what, before, after, kind) и как записать (run(tx));
 *  notes   — «НЕ ПРИМЕНИТСЯ: …» и «уже применено: …» для журнала;
 *  backup  — прежние значения всего, что меняется (пишется одной строкой Setting).
 */
export async function planBotTexts(db) {
  const changes = [];
  const notes = [];
  const backup = { aiPrompt: undefined, objectionLibrary: undefined, steps: [], settingsCreated: [] };
  const getSetting = async (key) => (await db.setting.findUnique({ where: { key } }))?.value ?? null;

  // 1) Промпт.
  const oldPrompt = await getSetting("aiPrompt");
  if (oldPrompt?.startsWith(MARKER)) {
    notes.push("уже применено: aiPrompt (стоит метка версии) — не трогаю");
  } else {
    backup.aiPrompt = oldPrompt;
    changes.push({
      what: `Setting aiPrompt: новый промпт, ${NEW_PROMPT.length} знаков вместо ${oldPrompt?.length ?? 0}`,
      kind: "long",
      before: oldPrompt,
      after: NEW_PROMPT,
      run: (tx) => tx.setting.upsert({ where: { key: "aiPrompt" }, create: { key: "aiPrompt", value: NEW_PROMPT }, update: { value: NEW_PROMPT } }),
    });
  }

  // 2) Библиотека возражений.
  const rawLib = await getSetting("objectionLibrary");
  if (rawLib) {
    let list = null;
    try {
      list = JSON.parse(rawLib);
    } catch {
      notes.push("НЕ ПРИМЕНИТСЯ: objectionLibrary — не JSON, проверьте руками в панели");
    }
    if (Array.isArray(list)) {
      const keep = list.filter((e) => !ONLY_TELEGRAM.test(e?.counterThatWorked ?? "") && !OLD_OFFLINE.test(e?.counterThatWorked ?? ""));
      if (keep.length !== list.length) {
        backup.objectionLibrary = rawLib;
        const value = JSON.stringify(keep);
        changes.push({
          what: `Setting objectionLibrary: убрать ${list.length - keep.length} из ${list.length} записей (только Telegram / старый офлайн)`,
          kind: "count",
          run: (tx) => tx.setting.update({ where: { key: "objectionLibrary" }, data: { value } }),
        });
      }
    }
  }

  // 3) Шаги воронок.
  const funnels = await db.funnel.findMany({ include: { steps: true } });
  for (const funnel of funnels) {
    for (const step of funnel.steps) {
      if (step.order !== 20 && step.order !== 30) continue;
      const label = `${funnel.trigger} «${funnel.name ?? funnel.id}» шаг ${step.order}`;
      let text = step.text ?? "";
      const data = {};
      if (step.order === 20) {
        if (funnel.trigger === "DM") {
          if (DM_GREETING.test(text)) text = text.replace(DM_GREETING, "");
          else notes.push(`НЕ ПРИМЕНИТСЯ: ${label} — приветствия «Ассалому алейкум» в начале нет, убирать нечего (проверьте, не здоровается ли шаг иначе)`);
        }
        if (TELEGRAM_ONLY_LINE.test(text)) text = text.replace(TELEGRAM_ONLY_LINE, TELEGRAM_OR_SITE);
        else if (!/Telegram\s+ё\s+дар\s+сайт/iu.test(text))
          notes.push(`НЕ ПРИМЕНИТСЯ: ${label} — строки «Дарсҳо дар телеграм» нет, «или на сайте» не добавлено (правьте руками)`);
      }
      if (step.order === 30) {
        if (OLD_OFFLINE.test(text)) {
          text = OFFLINE_STEP_TEXT;
          if (!step.mediaUrl) {
            data.mediaUrl = OFFLINE_MENU_PHOTO;
            data.mediaType = "image";
          }
        } else if (text !== OFFLINE_STEP_TEXT) {
          notes.push(`НЕ ПРИМЕНИТСЯ: ${label} — старого адреса («Рудаки 156», «Додо Пицца») нет, текст не узнан (правьте руками)`);
        }
      }
      if (text !== (step.text ?? "")) data.text = text;
      if (Object.keys(data).length === 0) continue;
      backup.steps.push({ funnelId: funnel.id, order: step.order, text: step.text, mediaUrl: step.mediaUrl, mediaType: step.mediaType });
      changes.push({
        what: `FunnelStep ${label}: ${Object.keys(data).join(", ")}`,
        kind: "full",
        before: step.text,
        after: data.text ?? step.text,
        run: (tx) => tx.funnelStep.update({ where: { id: step.id }, data }),
      });
    }
  }

  // 4) Медиа меню и ссылка на отзывы — только если ещё не заданы (правки владельца не трогаем).
  const createIfMissing = async (key, value, why) => {
    if ((await getSetting(key)) !== null) return;
    backup.settingsCreated.push(key);
    changes.push({ what: `Setting ${key} (создать: ${why})`, kind: "short", before: null, after: value, run: (tx) => tx.setting.create({ data: { key, value } }) });
  };
  await createIfMissing("menuMediaUrls", JSON.stringify(MENU_MEDIA), "картинки меню от владельца");
  const highlights = /https:\/\/www\.instagram\.com\/stories\/highlights\/\d+\/?/u.exec(oldPrompt ?? "")?.[0];
  if (highlights) await createIfMissing("testimonialsLinkUrl", highlights, "ссылка на актуальные с отзывами из прежнего промпта владельца");

  return { changes, notes, backup };
}

/** Печать «было → стало». */
export function describePlan({ changes, notes }, log = console.log) {
  if (changes.length === 0) log("Менять нечего: всё уже применено.");
  for (const c of changes) {
    log(`ИЗМЕНИТ: ${c.what}`);
    if (c.kind === "long") log(`  было:\n${preview(c.before)}\n  стало:\n${preview(c.after)}`);
    else if (c.kind === "full") log(`  было:\n${full(c.before)}\n  стало:\n${full(c.after)}`);
    else if (c.kind === "short") log(`  стало: ${String(c.after).slice(0, 200)}`);
  }
  for (const n of notes) log(n);
}

/**
 * Запись: бэкап с меткой времени и все правки — одной транзакцией. Возвращает имя
 * бэкапа (или null, если менять было нечего).
 */
export async function applyBotTexts(db, plan, now = new Date()) {
  if (plan.changes.length === 0) return null;
  const backupKey = `${BACKUP_PREFIX}${now.toISOString()}`;
  await db.$transaction(async (tx) => {
    await tx.setting.create({ data: { key: backupKey, value: JSON.stringify(plan.backup) } });
    for (const c of plan.changes) await c.run(tx);
  });
  return backupKey;
}

export async function main({ db, apply, log = console.log }) {
  const plan = await planBotTexts(db);
  describePlan(plan, log);
  if (!apply) {
    if (plan.changes.length > 0) log("Это проверка. Записать: APPLY=1.");
    return { plan, backupKey: null };
  }
  const backupKey = await applyBotTexts(db, plan);
  log(backupKey ? `Готово: ${plan.changes.length} изменений, бэкап — Setting ${backupKey}.` : "Записывать нечего.");
  return { plan, backupKey };
}

// Тест импортирует функции с BOT_TEXTS_NO_MAIN=1 и даёт свою базу.
if (process.env.BOT_TEXTS_NO_MAIN !== "1") {
  const { prisma } = await import(process.env.DB_MODULE ?? "/app/apps/api/dist/db.js");
  try {
    await main({ db: prisma, apply: process.env.APPLY === "1" });
  } finally {
    await prisma.$disconnect();
  }
}
