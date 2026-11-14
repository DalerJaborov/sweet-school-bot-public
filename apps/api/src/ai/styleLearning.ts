import { prisma, getSetting, logError } from "./../db.js";
import { detectClientLanguage, type ClientLanguage } from "./clientLanguage.js";
import { comparableBotText, humanizeBotText, withoutAddressWords } from "./humanText.js";

/**
 * Самообучение стилю хозяйки — БЕЗ переписывания промта.
 *
 * Промт владельца это закон, его меняет только он. Бот учится иначе: копит
 * реальные пары «вопрос клиента → ответ хозяйки» и подмешивает лучшие из них в
 * каждый запрос как образцы. Модель перенимает манеру («Не намешава», короткие
 * фразы без подлизывания), а правила остаются под контролем
 * человека — то есть стиль улучшается, а поведение не «уплывает» само по себе.
 *
 * Два источника примеров:
 *  1) прошлые переписки аккаунта (разовый импорт, см. importHistory);
 *  2) КАЖДЫЙ случай, когда хозяйка вмешалась в живой разговор (Instagram:
 *     webhook.ts, WhatsApp: whatsapp/worker.ts::learnFromOwner) — значит бот
 *     ответил не так, а она показала, как надо. Это и есть постоянное обучение:
 *     чем дольше система работает, тем ближе бот к её манере.
 */

/** Сколько примеров подмешивать в запрос. Владелец просил «точную копию стиля»,
 *  поэтому берём заметно больше, чем нужно для одной лишь манеры: на типовые
 *  вопросы («сколько стоит», «куда переводить») бот должен отвечать её же
 *  словами, а не пересказом. */
const EXAMPLES_IN_PROMPT = 24;
/** Из скольких кандидатов выбираем — берём с запасом и ранжируем по близости к
 *  текущему вопросу, иначе в промт попадают просто самые свежие пары. */
const CANDIDATE_POOL = 200;
/** Длинные простыни — не образец манеры, а конкретный длинный случай. */
const MAX_EXAMPLE_LEN = 400;

/** Служебные и бессмысленные ответы, которые учить незачем. */
function isUseless(text: string): boolean {
  const t = text.trim();
  if (t.length < 2) return true;
  if (t.length > MAX_EXAMPLE_LEN) return true;
  if (/^https?:\/\/\S+$/.test(t)) return true; // просто ссылка
  return false;
}

/** Голосовое/фото/видео, приложенные к ответу хозяйки — своя постоянная копия,
 *  см. saveOwnerMedia в upload.ts (ссылка Instagram короткоживущая). */
export type OwnerMedia = { url: string; type: "audio" | "image" | "video" };

/**
 * Сохраняет пару «вопрос → ответ хозяйки». Дубли отсекает уникальность в базе.
 *
 * Пустой ownerText раньше отсекался как бесполезный (isUseless) — правильно для
 * чистого текста, но не для фото/видео БЕЗ подписи: сама картинка — уже ответ
 * (например, скриншот с реквизитами), терять её из-за пустой строки текста
 * нельзя. Поэтому проверка на бесполезность включается только когда медиа нет.
 */
export async function rememberOwnerReply(
  clientText: string,
  ownerText: string,
  source: "HISTORY" | "TAKEOVER",
  media?: OwnerMedia,
  /** Чей это разговор — известен для живого вмешательства (TAKEOVER, см.
   *  webhook.ts), неизвестен/не гарантирован для разового импорта истории
   *  (HISTORY, см. historyImport.ts) — там остаётся null. См. markExamplesAsSuccessful. */
  contactId?: string,
): Promise<void> {
  if (!media && isUseless(ownerText)) return;
  await prisma.styleExample
    .create({
      data: {
        clientText: clientText.slice(0, 500),
        ownerText: ownerText.trim(),
        source,
        mediaUrl: media?.url,
        mediaType: media?.type,
        contactId,
      },
    })
    .catch((err) => {
      // P2002 = дубликат примера (уже сохранён) — это нормально.
      if ((err as { code?: string })?.code !== "P2002") {
        logError("styleLearning:saveExample", err);
      }
    });
}

/**
 * Помечает примеры разговора как приведшие к продаже. Вызывается, когда человек
 * оплатил: всё, что хозяйка писала этому человеку, оказалось рабочим — такие
 * примеры идут в промт первыми.
 */
export async function markExamplesAsSuccessful(contactId: string): Promise<void> {
  const ownerTexts = await prisma.message.findMany({
    where: { contactId, direction: "OUT", text: { not: null } },
    select: { text: true },
    take: 50,
  });
  const texts = ownerTexts.map((m) => (m.text as string).trim()).filter(Boolean);
  if (texts.length === 0) return;
  // contactId в WHERE — раньше матчили ТОЛЬКО по тексту глобально: типовая
  // фраза («курс 50 сомони, оплата на карту...») из ЧУЖИХ, неуспешных
  // переписок ошибочно получала бонус ledToSale только по совпадению слов.
  // Строки без contactId (HISTORY-импорт) этим путём бонус больше не получают —
  // ожидаемо, у них никогда не было привязки к конкретному разговору.
  await prisma.styleExample
    .updateMany({ where: { contactId, ownerText: { in: texts } }, data: { ledToSale: true } })
    .catch((err) => logError("style:markSuccess", err));
}

/** Слова вопроса без коротких служебных — по ним ищем похожие случаи.
 *  Экспортируется — тот же матчинг переиспользует ai/mediaReuse.ts (Фаза 2
 *  плана «максимальное использование архива»), чтобы не заводить второй
 *  механизм подбора похожего вопроса в проекте. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3);
}

/**
 * Насколько пример подходит к ТЕКУЩЕМУ вопросу. Складываем три вещи:
 *  • сколько слов вопроса совпало с вопросом из примера — главное;
 *  • пример привёл к продаже — такой ответ доказанно работает;
 *  • это живое вмешательство хозяйки (TAKEOVER), а не старая переписка — она
 *    поправляла бота именно там, где он ошибался, значит образец точнее.
 */
export function score(example: { clientText: string; ledToSale: boolean; source: string }, ask: string[]): number {
  if (ask.length === 0) return (example.ledToSale ? 3 : 0) + (example.source === "TAKEOVER" ? 1 : 0);
  const theirs = new Set(words(example.clientText));
  let overlap = 0;
  for (const w of ask) if (theirs.has(w)) overlap += 1;
  return overlap * 2 + (example.ledToSale ? 3 : 0) + (example.source === "TAKEOVER" ? 1 : 0);
}

/**
 * Блок образцов для системного промта. Если известно, что человек спросил СЕЙЧАС,
 * вперёд идут примеры на тот же вопрос — так бот отвечает на «сколько стоит»
 * ровно теми словами, какими отвечает Ширин, а не своим пересказом. Дальше —
 * доказавшие себя (привели к продаже) и её живые поправки.
 */
/** Служебный мусор, который однажды попал в «образцы» как будто это слова хозяйки. */
const NOT_HER_WORDS = /Automation powered|Drafting the|\*\*|NO_REPLY|Рады приветствовать вас в|Добро пожаловать в/;

/**
 * Образцы, написанные НЕ хозяйкой: тексты, которые бот или воронка уже слали клиентам
 * (замер 08.11.2026: 236 из 940 образцов дословно совпали с автоматическими
 * сообщениями). Учить бота его же шаблонам — замкнутый круг: «манера Ширин»
 * превращается в эхо самого бота. Отсеиваем при выборке, базу не трогаем.
 */
export async function withoutBotAuthored<T extends { ownerText: string }>(pool: T[]): Promise<T[]> {
  const texts = [...new Set(pool.map((e) => e.ownerText.trim()).filter(Boolean))];
  if (texts.length === 0) return pool;
  // Бот пишет в историю текст после фильтра отправки (без тире, буквы по стилю клиента),
  // а образец мог прийти и до фильтра, и после: ищем все варианты и сравниваем в одном виде.
  const variants = new Set<string>();
  for (const t of texts) {
    variants.add(t);
    variants.add(humanizeBotText(t, { keepTajikLetters: false }));
    variants.add(humanizeBotText(t, { keepTajikLetters: true }));
  }
  // Instagram снимает точку в конце (voice.ts::toOwnerVoice), а в истории она осталась.
  for (const v of [...variants]) if (!/[.!?…]$/u.test(v)) variants.add(v + ".");
  const sentByBot = new Set(
    (
      await prisma.message.findMany({
        where: { direction: "OUT", byHuman: false, text: { in: [...variants] } },
        select: { text: true },
      })
    ).map((m) => comparableBotText(m.text)),
  );
  return pool.filter((e) => !sentByBot.has(comparableBotText(e.ownerText)) && !NOT_HER_WORDS.test(e.ownerText));
}

/** Бонус образцу на языке текущего клиента: таджикской клиентке — таджикские образцы. */
export function languageBonus(example: { ownerText: string }, language: ClientLanguage): number {
  if (language !== "ru" && language !== "tg") return 0;
  return detectClientLanguage(example.ownerText) === language ? 4 : 0;
}

export async function buildStyleBlock(clientText = "", knownLanguage?: ClientLanguage): Promise<string> {
  if ((await getSetting("styleLearningEnabled")) === "false") return "";

  const rawPool = await prisma.styleExample.findMany({
    // Библиотека медиа - это файлы с ключевыми словами, а не живые ответы Ширин: в образцы манеры не годятся.
    where: { enabled: true, source: { not: "LIBRARY" } },
    orderBy: [{ ledToSale: "desc" }, { createdAt: "desc" }],
    take: CANDIDATE_POOL,
  });
  const pool = await withoutBotAuthored(rawPool);
  if (pool.length === 0) return "";

  const ask = words(clientText);
  // Язык контакта из ai.ts (цепочка contactLanguage) точнее, чем одно сообщение: «Салом» или голосовое.
  const language = knownLanguage ?? detectClientLanguage(clientText);
  const examples = [...pool]
    .map((e) => ({ e, s: score(e, ask) + languageBonus(e, language) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, EXAMPLES_IN_PROMPT)
    .map((x) => x.e);

  // Обращение «апачон/апа» из образцов убираем (владелец 08.11.2026: бот так не
  // обращается), иначе модель копирует его из её же фраз, сколько ни запрещай.
  const lines = examples.map((e) => {
    const owner = withoutAddressWords(e.ownerText);
    return e.clientText.trim() ? `Клиент: ${e.clientText.trim()}\nШирин: ${owner}` : `Ширин: ${owner}`;
  });
  const tajikRule =
    language === "tg"
      ? "\n\nПИСЬМЕННЫЙ ТАДЖИКСКИЙ: слова, порядок слов и длину фраз бери у Ширин из образцов ниже: коротко, разговорно, по-душанбински, на «шумо» (мекнен, мегирен, дорем). " +
        "Буквы пиши правильные таджикские (ӣ ӯ қ ғ ҳ ҷ), даже где Ширин в образце их не ставит: под собеседника их правит код перед отправкой, а озвучке нужны правильные буквы. " +
        "НЕ ВЫДУМЫВАЙ слов и оборотов, которых нет в образцах и в разговорнике: нет подходящего образца, скажи короче и проще."
      : "";
  return (
    tajikRule +
    "\n\nТАК ОТВЕЧАЕТ САМА ШИРИН (её настоящие сообщения клиентам). ЭТО ЭТАЛОН МАНЕРЫ, НЕ ИСТОЧНИК АКТУАЛЬНЫХ ФАКТОВ. Держи её манеру: те же слова, тот же " +
    "душанбинский говор, та же длина фразы, так же коротко, как в WhatsApp. Эти примеры исторические: не копируй из них цены, даты, акции, состав курса, реквизиты или личные данные. " +
    "Факты бери только из текущих правил и настроек курса; при конфликте или отсутствии подтверждения не угадывай. " +
    "Ничего не добавляй от себя: ни вежливых довесков, ни лишних вопросов.\n\n" +
    lines.join("\n\n")
  );
}
