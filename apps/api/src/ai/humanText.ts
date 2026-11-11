/**
 * ТЕКСТ БОТА — КАК У ЖИВОГО ЧЕЛОВЕКА В ПЕРЕПИСКЕ (решение владельца 08.11.2026):
 * «он пишет как бот: длинные тире, много текста, сухо, по-литературному».
 *
 * Одна дверь для всех исходящих текстов бота (WhatsApp, Instagram, Messenger,
 * сайт): вызывается из messaging/send.ts::humanizeForContact и больше нигде не
 * повторяется. Сообщения самой Ширин (byHuman) сюда не попадают никогда.
 *
 *  1) ОСОБЫЕ БУКВЫ ҷ қ ӯ ғ ҳ ӣ — ПО СТИЛЮ СОБЕСЕДНИКА. Модель пишет таджикский
 *     правильными буквами (их же читает озвучка — голосовой путь сюда не заходит),
 *     а в текстовом сообщении буквы меняются на ч к у г х и, если сам клиент пишет
 *     без них. Пишет с ними — оставляем: так отвечает живой человек, по образцу
 *     собеседника.
 *  2) ДЛИННОЕ ТИРЕ «—» и «–» — убираем всегда: в переписке так не пишут, это
 *     признак сгенерированного текста. Между словами — запятая, в начале строки
 *     (список) — ничего, между цифрами (13:40–16:30) — обычный дефис.
 *  3) ОБРАЩЕНИЕ «апачон/апа» — убираем (владелец 08.11.2026: приветствие
 *     «Ассалому алейкум» без обращения). Запрет стоит и в промте, здесь — второй
 *     замок: образцы манеры Ширин сами содержат «Салом апачон», модель его копирует.
 *  4) ДЕЖУРНЫЕ ХВОСТЫ «Если будут вопросы, обращайтесь» — последнюю такую фразу
 *     срезаем, если после неё остаётся сам ответ.
 *
 * Многоточие «…», дефис «-», цифры, ссылки и смайлики этот модуль не трогает
 * (смайлики — ai/replyPolicy.ts::cleanKeepingWarmTail).
 */

const TAJIK_LETTER_CLASS = "ҷқӯғҳӣҶҚӮҒҲӢ";
const TAJIK_LETTER = new RegExp(String.raw`[${TAJIK_LETTER_CLASS}]`, "u");
const TAJIK_LETTER_ALL = new RegExp(String.raw`[${TAJIK_LETTER_CLASS}]`, "gu");

/** Карта замен особых букв на обычную кириллицу — единственная в проекте
 *  (её же использует поиск по рецептам, course/assistant.ts). */
const PLAIN_LETTER: Readonly<Record<string, string>> = {
  ҷ: "ч",
  Ҷ: "Ч",
  қ: "к",
  Қ: "К",
  ӯ: "у",
  Ӯ: "У",
  ғ: "г",
  Ғ: "Г",
  ҳ: "х",
  Ҳ: "Х",
  ӣ: "и",
  Ӣ: "И",
};

/** Есть ли в тексте особые таджикские буквы (в любом регистре, в т.ч. «и» + знак долготы). */
export function hasTajikLetters(text: string): boolean {
  return TAJIK_LETTER.test((text ?? "").normalize("NFC"));
}

/** ҷ→ч, қ→к, ӯ→у, ғ→г, ҳ→х, ӣ→и с сохранением регистра. */
export function plainTajikLetters(text: string): string {
  return (text ?? "").normalize("NFC").replace(TAJIK_LETTER_ALL, (ch) => PLAIN_LETTER[ch] ?? ch);
}

/** Тире всех видов, которыми модель заменяет запятую или «это». Дефис «-» не входит. */
const DASH = "—–―‒";

/** Убирает длинные тире: в начале строки — совсем, между цифрами — дефис, иначе — запятая. */
export function withoutDashes(text: string): string {
  if (!new RegExp(String.raw`[${DASH}]`, "u").test(text)) return text;
  return (
    text
      .replace(new RegExp(String.raw`^([ \t]*)[${DASH}]+[ \t]*`, "gmu"), "$1")
      .replace(new RegExp(String.raw`(\d)[ \t]*[${DASH}][ \t]*(\d)`, "gu"), "$1-$2")
      .replace(new RegExp(String.raw`[ \t]*[${DASH}]+[ \t]*`, "gu"), ", ")
      // «уроки, — прямо» → «уроки,, прямо» → «уроки, прямо»; «да. — нет» → «да. нет».
      .replace(/([,.!?:;…])[ \t]*,[ \t]*/gu, "$1 ")
      .replace(/,[ \t]*([.!?])/gu, "$1")
      .replace(/[ \t]*,[ \t]*$/gmu, "")
      .replace(/^([ \t]*),[ \t]*/gmu, "$1")
      .replace(/[ \t]{2,}/gu, " ")
  );
}

/** Обращения, которых бот не говорит (владелец 08.11.2026). Только целым словом. */
// «апа», «апачон», «апа-ҷон», «апа-джан», «апачонам» — одним словом, иначе от «Апа-ҷон»
// оставался бы хвост «-чон».
const ADDRESS_WORD = "апа(?:-?(?:ҷон|чон|джон|джан|жон)(?:ам)?)?|ападжон";
const ADDRESS_AT_LINE_START = new RegExp(String.raw`^([ \t]*)(?:${ADDRESS_WORD})(?!\p{L})[ \t]*[,!.]*[ \t]*`, "gimu");
const ADDRESS_INLINE = new RegExp(String.raw`[ \t]*,?[ \t]*(?<!\p{L})(?:${ADDRESS_WORD})(?!\p{L})`, "giu");

function capitalizeLineStarts(text: string, lines: Set<number>): string {
  if (lines.size === 0) return text;
  return text
    .split("\n")
    .map((line, i) =>
      lines.has(i)
        ? line.replace(/^([ \t]*)(\p{Ll})/u, (_m, sp: string, ch: string) => sp + ch.toLocaleUpperCase("ru"))
        : line,
    )
    .join("\n");
}

/** «Салом апачон, курс 50 сомони» → «Салом, курс 50 сомони»; «Апачон, курс…» → «Курс…». */
export function withoutAddressWords(text: string): string {
  if (!new RegExp(String.raw`(?<!\p{L})(?:${ADDRESS_WORD})(?!\p{L})`, "iu").test(text)) return text;
  const startHits = new Set<number>();
  const lines = text.split("\n").map((line, i) => {
    const stripped = line.replace(ADDRESS_AT_LINE_START, "$1");
    if (stripped !== line) startHits.add(i);
    return stripped;
  });
  const inline = lines
    .join("\n")
    .replace(ADDRESS_INLINE, "")
    .replace(/[ \t]+([,.!?…])/gu, "$1")
    .replace(/,([.!?])/gu, "$1");
  return capitalizeLineStarts(inline, startHits).trim();
}

/**
 * Дежурные хвосты в конце ответа. Срезается только ПОСЛЕДНЯЯ фраза и только если
 * до неё есть сам ответ: «Если будут вопросы, пишите» одной репликой не трогаем.
 */
const STOCK_TAIL = new RegExp(
  String.raw`(?:^|(?<=[.!?…\n]))[ \t]*(?:` +
    [
      // Только сама дежурная фраза («…вопросы, пишите»): если после «вопросы» идёт
      // дело («…вопросы по оплате, номер ниже»), фразу не трогаем.
      String.raw`(?:и\s+)?если\s+(?:у\s+вас\s+)?(?:будут|возникнут|появятся|остались|остаются|есть)\s+(?:ещё\s+|еще\s+)?(?:какие-?(?:то|либо|нибудь)\s+)?вопросы,?\s+(?:пишите|напишите|обращайтесь|спрашивайте|задавайте)(?:\s+(?:их|мне|сюда|в\s+любое\s+время|не\s+стесняйтесь)){0,3}`,
      String.raw`(?:если\s+что,?\s+)?обращайтесь(?:\s+(?:ещё|еще|сюда|в\s+любое\s+время)){0,2}`,
      String.raw`(?:всегда|буду)\s+рада\s+помочь`,
      String.raw`агар\s+савол(?:е|хо|ҳо|и\s+дигар)?\s+(?:бошад|дошта\s+бошед|дошта\s+бошен|пайдо\s+шавад|шавад),?\s+(?:нависед|нависен|пурсед|пурсен)`,
    ].join("|") +
    String.raw`)[.!?…]*[ \t]*$`,
  "iu",
);

function withoutOneStockTail(text: string): string {
  const trimmed = text.trim();
  const m = STOCK_TAIL.exec(trimmed);
  if (!m) return text;
  const rest = trimmed.slice(0, m.index).trim();
  return rest ? rest : text;
}

/** Срезает дежурные хвосты до неподвижной точки: «…Всегда рада помочь. Обращайтесь.»
 *  теряет обе фразы за один вызов, поэтому повторная правка ничего не меняет. */
export function withoutStockTails(text: string): string {
  let out = text;
  for (let i = 0; i < 5; i++) {
    const next = withoutOneStockTail(out);
    if (next === out) return out;
    out = next;
  }
  return out;
}

export type HumanizeOptions = {
  /** Клиент сам пишет особыми буквами — тогда оставляем их как есть. */
  keepTajikLetters: boolean;
};

/** Полная правка исходящего текста бота. Идемпотентна: повторный вызов ничего не меняет. */
/**
 * СЛУЖЕБНЫЕ МЕТКИ НЕ УХОДЯТ КЛИЕНТУ (ревью 11.11.2026). Модель отвечает метками
 * [NO_REPLY], [ASK_SHIRIN] — код их ловит, но если метка пришла вместе с текстом
 * («Сейчас уточню [ASK_SHIRIN]») или в пути, где её не разбирают (ответ под
 * комментарием), клиент видел «[ASK_SHIRIN]». Режется любая метка в квадратных
 * скобках: ЗАГЛАВНЫМИ буквами («[NO_REPLY]», «[МЕТКА]») или через подчёркивание
 * («[ask_shirin]»); в метке должна быть хоть одна буква — «[1]» не трогаем.
 * Стоит в обеих дверях бота: humanizeBotText (отправка) и cleanAutomatedReply.
 */
const SERVICE_MARKER = /\[\s*(?=[^\]]*\p{L})(?:[\p{Lu}\d]+(?:[_ :.-]+[\p{Lu}\d]+)*|[\p{L}\d]+(?:_[\p{L}\d]+)+)\s*\]/gu;

export function stripServiceMarkers(text: string): string {
  if (!text || !text.includes("[")) return text;
  return text
    .replace(SERVICE_MARKER, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,!?])/g, "$1")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

export function humanizeBotText(text: string, opts: HumanizeOptions): string {
  if (!text) return text;
  let out = stripServiceMarkers(text.normalize("NFC"));
  out = withoutAddressWords(out);
  out = withoutStockTails(out);
  out = withoutDashes(out);
  if (!opts.keepTajikLetters) out = plainTajikLetters(out);
  return out.trim();
}

/**
 * Текст для СРАВНЕНИЯ с историей (шаблоны, подписи видео, образцы манеры): та же правка,
 * что у двери отправки, без особых букв, без смайликов, точек в конце и регистра. Так
 * старая строка в истории («Хорошо — сейчас Ширин…», «ҳамон ҷо нависед.») и новая
 * («Хорошо, сейчас Ширин…») сравниваются по смыслу шаблона, а не по знакам.
 */
export function comparableBotText(text: string | null | undefined): string {
  return humanizeBotText(text ?? "", { keepTajikLetters: false })
    .replace(/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}️‍]/gu, "")
    .replace(/[\s.!…]+$/u, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase("ru");
}

/** Пишет ли клиент сам особыми буквами — по его последним сообщениям. */
export function clientUsesTajikLetters(clientTexts: readonly (string | null | undefined)[]): boolean {
  return clientTexts.some((t) => typeof t === "string" && hasTajikLetters(t));
}

/** Символы, которых не должно быть в тексте бота клиенту без особых букв (для тестов-сторожей). */
export const FORBIDDEN_IN_PLAIN_BOT_TEXT = new RegExp(String.raw`[${TAJIK_LETTER_CLASS}${DASH}]`, "u");
