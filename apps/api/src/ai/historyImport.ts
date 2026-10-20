import { getSetting, logError, logInfo } from "../db.js";
import { rememberOwnerReply } from "./styleLearning.js";
import { igGet as ig } from "./igGet.js";
import { looksPersonal } from "./personalContact.js";
import { mentionsOurBusiness } from "./offTopicGuard.js";

/**
 * Импорт прошлых переписок аккаунта — чтобы бот сразу знал манеру хозяйки, а не
 * учился с нуля. Дальше он доучивается сам, на каждом её вмешательстве (см.
 * styleLearning).
 *
 * Берём только пары «клиент написал → хозяйка ответила»: одинокие реплики без
 * контекста манеру не показывают.
 *
 * ВЕСЬ АККАУНТ, А НЕ ПОСЛЕДНИЕ 50 ДИАЛОГОВ (22.08.2026, решение владельца:
 * «можешь весь аккаунт скопировать полностью»). Прежний импорт брал ровно одну
 * страницу и на том заканчивался — отсюда всего 135 примеров, и бот учился манере
 * по хвосту переписки за неделю. Теперь идём по страницам до конца.
 *
 * ЛИЧНЫЕ ПЕРЕПИСКИ НЕ БЕРЁМ ВООБЩЕ. С этого же аккаунта Ширин переписывается с
 * роднёй и знакомыми, и учить бота на «дочка, ты покушала?» — прямой путь к тому,
 * чтобы он заговорил так с клиенткой. Диалог с признаками личного отбрасывается
 * ЦЕЛИКОМ, а не по одному сообщению: в личной переписке манера другая вся, от
 * первого слова до последнего.
 */

type IgMessage = { id?: string; from?: { id?: string; username?: string }; message?: string; created_time?: string };

type Paged<T> = { data?: T[]; paging?: { cursors?: { after?: string }; next?: string } };

/**
 * Потолок страниц — защита от бесконечного цикла, а не ограничение объёма.
 * 200 страниц по 50 диалогов это 10 000 переписок: у школы столько нет и близко,
 * а зациклившийся обход выел бы дневную квоту Instagram за минуты.
 */
const MAX_PAGES = 200;
const PER_PAGE = 50;
/** Сколько сообщений тянуть из одного диалога. Больше не нужно: манера видна и по
 *  двум десяткам реплик, а каждая лишняя страница — отдельный запрос к Meta. */
const MESSAGES_PER_CONVO = 50;

export interface ImportResult {
  imported: number;
  scanned: number;
  conversations: number;
  /** Сколько переписок отброшено как личные — владельцу полезно это видеть. */
  skippedPersonal: number;
}

/**
 * Проходит ВСЕ диалоги аккаунта и складывает пары «вопрос → ответ хозяйки».
 *
 * @param maxConversations верхний предел (0 или отрицательное — без предела).
 */
export async function importHistory(maxConversations = 0): Promise<ImportResult> {
  const token = (await getSetting("igToken"))?.trim();
  const selfId = (await getSetting("igBusinessId"))?.trim();
  if (!token) throw new Error("Маркер Instagram не задан");

  // Кто «мы» — узнаём у самого API, чтобы отличать свои сообщения от клиентских.
  const me = (await ig("/me", { fields: "user_id,username" }, token)) as { user_id?: string; username?: string };
  const ourUsername = me.username;
  const ourId = selfId || me.user_id;

  let imported = 0;
  let scanned = 0;
  let conversations = 0;
  let skippedPersonal = 0;
  let after: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params: Record<string, string> = { platform: "instagram", limit: String(PER_PAGE) };
    if (after) params.after = after;

    const convos = (await ig("/me/conversations", params, token)) as Paged<{ id?: string }>;
    const batch = convos.data ?? [];
    if (batch.length === 0) break;

    for (const convo of batch) {
      if (!convo.id) continue;
      if (maxConversations > 0 && conversations >= maxConversations) return done();
      conversations++;
      try {
        const detail = (await ig(
          `/${convo.id}`,
          { fields: `messages.limit(${MESSAGES_PER_CONVO}){from,message,created_time}` },
          token
        )) as { messages?: { data?: IgMessage[] } };
        // Meta отдаёт от новых к старым — разворачиваем в хронологию разговора.
        const msgs = [...(detail.messages?.data ?? [])].reverse();
        scanned += msgs.length;

        const isOurs = (m: IgMessage): boolean => m.from?.username === ourUsername || m.from?.id === ourId;

        /**
         * ЛИЧНАЯ ПЕРЕПИСКА — ПРОПУСКАЕМ ВЕСЬ ДИАЛОГ.
         *
         * Два признака, и любого достаточно:
         *
         *  1) прямые приметы родни («оча», «дочка») вместе с бытовым вопросом —
         *     это точно не клиент;
         *  2) в переписке НЕТ НИ ОДНОГО слова про наше дело: ни курса, ни цены, ни
         *     десерта, ни записи. Клиент без таких слов не бывает — он за этим и
         *     пришёл. А знакомая пишет «салом, чи хел хасти» и обсуждает своё.
         *
         * Второй признак и есть главный: первый требует ДВУХ совпадений сразу и на
         * живых данных не сработал ни разу за 400 переписок, потому что знакомые
         * обычно не пишут «доченька, ты покушала?» — они просто говорят о своём.
         */
        const clientLines = msgs.filter((m) => !isOurs(m)).map((m) => (m.message ?? "").trim()).filter(Boolean);
        const looksLikeFamily = clientLines.some((line) => looksPersonal(line));
        // Пустой диалог не судим: не о чем.
        const aboutBusiness = clientLines.some((line) => mentionsOurBusiness(line));
        if (looksLikeFamily || (clientLines.length > 0 && !aboutBusiness)) {
          skippedPersonal++;
          continue;
        }

        let lastClientText = "";
        for (const m of msgs) {
          const text = (m.message ?? "").trim();
          if (!text) continue;
          if (isOurs(m)) {
            if (lastClientText) {
              await rememberOwnerReply(lastClientText, text, "HISTORY");
              imported++;
              lastClientText = ""; // одна пара на вопрос, дальше уже монолог
            }
          } else {
            lastClientText = text;
          }
        }
      } catch (err) {
        logError("historyImport", err);
      }
    }

    // Прогресс в консоль: импорт всего аккаунта идёт минутами, и молчащий процесс
    // неотличим от зависшего.
    logInfo(
      "style:import",
      `страница ${page + 1}: переписок ${conversations}, примеров ${imported}, личных пропущено ${skippedPersonal}`
    );

    after = convos.paging?.cursors?.after;
    if (!after || !convos.paging?.next) break;
  }

  return done();

  function done(): ImportResult {
    return { imported, scanned, conversations, skippedPersonal };
  }
}
