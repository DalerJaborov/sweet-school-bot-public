import { prisma, getSetting, logError } from "./../db.js";

/**
 * Самообучение стилю хозяйки — БЕЗ переписывания промта.
 *
 * Промт владельца это закон, его меняет только он. Бот учится иначе: копит
 * реальные пары «вопрос клиента → ответ хозяйки» и подмешивает лучшие из них в
 * каждый запрос как образцы. Модель перенимает манеру («Салом апачон», «Не
 * намешава», короткие фразы без подлизывания), а правила остаются под контролем
 * человека — то есть стиль улучшается, а поведение не «уплывает» само по себе.
 *
 * Два источника примеров:
 *  1) прошлые переписки аккаунта (разовый импорт, см. importHistory);
 *  2) КАЖДЫЙ случай, когда хозяйка вмешалась в живой разговор — значит бот
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
  contactId?: string
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
export async function buildStyleBlock(clientText = ""): Promise<string> {
  if ((await getSetting("styleLearningEnabled")) === "false") return "";

  const pool = await prisma.styleExample.findMany({
    where: { enabled: true },
    orderBy: [{ ledToSale: "desc" }, { createdAt: "desc" }],
    take: CANDIDATE_POOL,
  });
  if (pool.length === 0) return "";

  const ask = words(clientText);
  const examples = [...pool]
    .map((e) => ({ e, s: score(e, ask) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, EXAMPLES_IN_PROMPT)
    .map((x) => x.e);

  const lines = examples.map((e) =>
    e.clientText.trim() ? `Клиент: ${e.clientText.trim()}\nШирин: ${e.ownerText}` : `Ширин: ${e.ownerText}`
  );
  return (
    "\n\nТАК ОТВЕЧАЕТ САМА ШИРИН — ЭТО ЭТАЛОН. Держи её манеру: те же слова, тот же " +
    "душанбинский говор, та же длина фразы. Если ниже есть случай на тот же вопрос — " +
    "отвечай практически её текстом, меняя только то, что относится к этому человеку. " +
    "Ничего не добавляй от себя: ни вежливых довесков, ни лишних вопросов.\n\n" +
    lines.join("\n\n")
  );
}
