import { getSetting, logError } from "./db.js";
import { singleFlight } from "./services/singleFlight.js";
import { igGet } from "./ai/igGet.js";
import { handleComment } from "./funnel.js";

/**
 * ДОЗАПРАВКА ПРОПУЩЕННЫХ КОММЕНТАРИЕВ.
 *
 * Вебхук — единственный обычный путь, которым к нам приходит комментарий. Если
 * в момент доставки контейнер перезапускался (деплой), Meta после нескольких
 * неудачных попыток БОЛЬШЕ НЕ повторяет — событие теряется без следа: в базе
 * нет ни SeenComment, ни Contact, ни строчки в логе. Это происходит при КАЖДОМ
 * деплое, если в этот момент кто-то оставил комментарий (см. случай
 * kami1zade.ol).
 *
 * Решение — не полагаться только на вебхук, а раз в REPOLL_MINUTES САМИМ
 * спрашивать Instagram: берём недавние публикации и их свежие комментарии, и
 * то, чего ещё нет в SeenComment, прогоняем через ТОТ ЖЕ handleComment, что и
 * обычный вебхук (webhook.ts) — значит и защита от повторной обработки та же
 * (атомарный insert в SeenComment внутри handleComment, см. funnel.ts), и
 * логика воронки та же, без дублирования.
 *
 * Это подстраховка на глубину MAX_LOOKBACK_HOURS назад, а не полная
 * синхронизация истории — обычных нескольких минут простоя при деплое хватает
 * с большим запасом.
 */

const MAX_MEDIA = 12; // публикаций из ленты проверяем за один тик — не сотни
const MAX_COMMENTS_PER_MEDIA = 50;
const MAX_LOOKBACK_HOURS = 48;

export type IgComment = {
  id?: string;
  text?: string;
  timestamp?: string;
  username?: string;
  from?: { id?: string; username?: string };
};

/**
 * Чистая проверка «стоит ли вообще передавать этот комментарий в обработку».
 * Вынесена отдельно от сетевых вызовов, чтобы её можно было проверить тестом
 * без базы и без Instagram API. Финальную защиту от повторной обработки всё
 * равно даёт атомарный insert в SeenComment внутри handleComment — это только
 * фильтр, а не источник истины.
 */
export function shouldBackfill(c: IgComment, selfUsername: string, cutoffMs: number): boolean {
  if (!c.id || !c.text?.trim()) return false;
  const authorId = c.from?.id;
  const authorUsername = c.from?.username ?? c.username;
  // СВОЙ КОММЕНТАРИЙ — ПО USERNAME, А НЕ ПО ID (найдено 22.08.2026 на живых
  // данных прода). Проверка боем показала: числовой id, который отдаёт /me,
  // НЕ совпадает с тем id, что стоит в from.id у СОБСТВЕННЫХ же комментариев
  // школы — Instagram использует для одного и того же аккаунта разные
  // scoped-id в разных полях (`id` у /me, `from.id` и ещё третий
  // `self_ig_scoped_id` у комментария). Сравнение по id молча пропускало бы
  // фильтр, и бот заводил бы контакт по собственным эмодзи-ответам под
  // постами. Username в обоих местах один и тот же.
  if (!authorId || !authorUsername || authorUsername.toLowerCase() === selfUsername.toLowerCase()) return false;
  if (c.timestamp) {
    const ts = new Date(c.timestamp).getTime();
    if (Number.isFinite(ts) && ts < cutoffMs) return false; // старше окна подстраховки
  }
  return true;
}

/** Дёргается общим тиком (см. index.ts). Не накладывается сама на себя —
 *  опрос всех публикаций может занять несколько секунд. */
export async function pollMissedComments(): Promise<void> {
  // Один прогон за раз, с предохранителем от вечного «занято» (singleFlight.ts).
  await singleFlight("commentBackfill", async () => {
    try {
      await sweep();
    } catch (err) {
      logError("commentBackfill", err);
    }
  });
}

async function sweep(): Promise<void> {
  const token = (await getSetting("igToken"))?.trim();
  if (!token) return; // не настроено — ждём, пока владелец впишет маркер в Настройках

  // В базе НЕТ отдельной настройки с числовым ID аккаунта (проверено на проде —
  // есть только igToken) — тот же путь, что уже работает в ownMedia.ts: свою
  // ленту токен Instagram Login отдаёт через /me, без отдельного ID. Username
  // (а не id, см. shouldBackfill) — то, чем ниже отличаем чужой комментарий от
  // своего же ответа под постом.
  const me = (await igGet("/me", { fields: "id,username" }, token)) as { id?: string; username?: string };
  const selfUsername = me.username;
  if (!selfUsername) return;

  const cutoffMs = Date.now() - MAX_LOOKBACK_HOURS * 3_600_000;

  const media = (await igGet("/me/media", { fields: "id,timestamp", limit: String(MAX_MEDIA) }, token)) as {
    data?: { id?: string }[];
  };

  for (const post of media.data ?? []) {
    if (!post.id) continue;

    let comments: { data?: IgComment[] };
    try {
      comments = (await igGet(
        `/${post.id}/comments`,
        { fields: "id,text,timestamp,username,from", limit: String(MAX_COMMENTS_PER_MEDIA) },
        token
      )) as { data?: IgComment[] };
    } catch (err) {
      // Один пост не должен останавливать обход остальных — например, если
      // публикацию удалили или закрыли комментарии.
      logError("commentBackfill:comments", err);
      continue;
    }

    for (const c of comments.data ?? []) {
      if (!shouldBackfill(c, selfUsername, cutoffMs)) continue;

      // Тот же вход, что у вебхука. handleComment сам атомарно проверяет
      // SeenComment — если комментарий уже обработан (вебхуком или этим же
      // опросом чуть раньше), тихо выходит, второе приглашение не уйдёт.
      await handleComment({
        commentId: c.id as string,
        mediaId: post.id,
        igUserId: c.from!.id as string,
        username: c.from?.username ?? c.username ?? null,
        text: c.text as string,
        channel: "INSTAGRAM",
      }).catch((err) => logError("commentBackfill:handle", err));
    }
  }
}
