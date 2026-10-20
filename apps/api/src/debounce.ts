/**
 * Человеческий тайминг ответа: бот не отвечает на каждый «пузырь» сразу, а ждёт,
 * пока человек допишет всё, что хотел (несколько сообщений подряд — обычное дело
 * в переписке), и отвечает один раз на всё сразу. Максимум ожидания — 4 секунды.
 *
 * ПОЧЕМУ НЕ БОЛЬШЕ. Было 9 секунд «для человечности», но вместе с генерацией это
 * давало почти полминуты тишины — и хозяйка успевала ответить с телефона раньше
 * бота (тогда бот замолкает на 20 минут, и вся автоматика проходит мимо). Скорость
 * тут важнее имитации набора: клиент ждёт ответа, а не паузы.
 *
 * 22.08.2026 срезано ещё раз, с 4 секунд до 2,5: владелец снова видел, как сестра
 * успевает ответить первой. Полторы секунды кажутся мелочью, но они складываются с
 * генерацией — а та в этот день доходила до 18 секунд на ровном месте. Заодно
 * ответы стали короче (промт теперь просит 1–2 предложения), а короткий ответ
 * модель отдаёт заметно быстрее длинного: экономия тут не в паузе, а в объёме.
 *
 * Живём в одном процессе (SQLite, один контейнер) — буфер в памяти, без гонок
 * между инстансами, которые решает Postgres-версия в основной CRM.
 */
import { logError } from "./db.js";

const WINDOW_MS = 2_500;

type Pending<TRescued> = {
  texts: string[];
  attachments: { url: string; kind: "image" | "video" | "audio" | "file" }[];
  rescued: TRescued[];
  timer: NodeJS.Timeout;
  /** Сохраняем onFlush, чтобы graceful shutdown мог реально отправить
   *  накопленные сообщения, а не просто очистить буфер. */
  onFlush: (
    text: string,
    attachments: { url: string; kind: "image" | "video" | "audio" | "file" }[],
    rescuedImages: TRescued[]
  ) => void | Promise<void>;
};

const pending = new Map<string, Pending<unknown>>();

/**
 * Очередь запуска `onFlush` по каждому контакту — не даёт двум близким, но
 * РАЗДЕЛЁННЫМ окнами всплескам сообщений одного человека запустить бота
 * параллельно и независимо друг от друга.
 *
 * ЖИВОЙ СЛУЧАЙ 23.08.2026 (parfume.ellita): чек и следом отдельным сообщением
 * «ина чекш» пришли с разрывом 6 секунд — больше окна дебаунса (2,5 с) — и
 * превратились в ДВА независимых окна вместо одного. Пока первый вызов ещё
 * генерировал ответ (не быстро — Gemini), второй уже стартовал: его история
 * переписки читалась из базы РАНЬШЕ, чем первый успел записать туда свой ответ,
 * и оба независимо решили сказать одно и то же — «Кабул кардем апачон, хозир
 * дохил мекнем» — прислали ДВЕ одинаковые фразы подряд. Шире окно не лечит:
 * разрыв между сообщениями человека ничем не ограничен сверху, а вот гонка двух
 * ОДНОВРЕМЕННЫХ вызовов лечится тем, что второй просто ждёт, пока первый
 * действительно закончит и сохранит свой ответ — тогда его история уже видит
 * этот ответ, и повторять нечего.
 */
const contactChains = new Map<string, Promise<void>>();

/**
 * Graceful shutdown: при SIGTERM/SIGINT немедленно сбрасываем все pending-буферы,
 * вызывая onFlush с накопленными данными. Без этого in-memory debounce теряет
 * все неотправленные сообщения при любом рестарте/деплое.
 * Для multi-instance нужна Redis-версия; это — минимум для single-instance.
 */
/**
 * Сбросить все буферы и ДОЖДАТЬСЯ отправки. Раньше функция возвращалась сразу,
 * а сама работа (ответ Gemini, отправка в директ) жила в цепочке промисов —
 * и process.exit при деплое обрывал её через миллисекунды: в логе бодрое
 * «сбрасываю буферы», а клиентка ответа не получала (разбор надёжности
 * 03.09.2026). Теперь вызывающий может подождать, с потолком.
 */
export function flushAllPending(): Promise<void> {
  const waits: Promise<void>[] = [];
  for (const [contactId, entry] of pending) {
    clearTimeout(entry.timer);
    pending.delete(contactId);
    const { texts, attachments, rescued, onFlush } = entry;
    runAfterPrevious(contactId, () => onFlush(texts.join("\n"), attachments, rescued));
    const chain = contactChains.get(contactId);
    if (chain) waits.push(chain);
  }
  return Promise.allSettled(waits).then(() => undefined);
}

/** Экспортируется отдельно от таймера окна — тест гоняет саму очередь напрямую,
 *  не дожидаясь реальных 2,5 секунд. */
export function runAfterPrevious(contactId: string, task: () => void | Promise<void>): void {
  const prev = contactChains.get(contactId) ?? Promise.resolve();
  const next = prev.then(() => task()).catch((err) => {
    logError("debounce:runAfterPrevious", err);
  });
  contactChains.set(contactId, next);
  next.finally(() => {
    if (contactChains.get(contactId) === next) contactChains.delete(contactId);
  });
}

/**
 * Добавляет сообщение в буфер контакта и (пере)запускает окно ожидания. Когда
 * окно истекает без новых сообщений — вызывает `onFlush` со всем накопленным,
 * склеенным в один текст (по строке на сообщение). Сами вызовы `onFlush` для
 * одного контакта идут строго по очереди (см. runAfterPrevious выше), даже если
 * человек отправил всплески дальше друг от друга, чем окно дебаунса.
 *
 * `rescuedImages` — уже спасённые картинки ЭТОГО сообщения (см. rescueIncomingImages
 * в ai.ts, вызывается в webhook.ts до дебаунса). Копятся так же, как attachments —
 * порядок должен совпадать, потому что aiReply сопоставляет их по позиции среди
 * вложений-картинок.
 */
export function debounceMessage<TRescued>(
  contactId: string,
  text: string,
  attachments: { url: string; kind: "image" | "video" | "audio" | "file" }[],
  rescuedImages: TRescued[],
  onFlush: (
    text: string,
    attachments: { url: string; kind: "image" | "video" | "audio" | "file" }[],
    rescuedImages: TRescued[]
  ) => void | Promise<void>
): void {
  const existing = pending.get(contactId) as Pending<TRescued> | undefined;
  if (existing) clearTimeout(existing.timer);

  const texts = [...(existing?.texts ?? []), text].filter(Boolean);
  const merged = [...(existing?.attachments ?? []), ...attachments];
  const mergedRescued = [...(existing?.rescued ?? []), ...rescuedImages];

  const timer = setTimeout(() => {
    pending.delete(contactId);
    runAfterPrevious(contactId, () => onFlush(texts.join("\n"), merged, mergedRescued));
  }, WINDOW_MS);
  // Таймер не должен держать процесс живым сам по себе (на случай остановки).
  timer.unref?.();

  pending.set(contactId, { texts, attachments: merged, rescued: mergedRescued, timer, onFlush } as Pending<unknown>);
}
