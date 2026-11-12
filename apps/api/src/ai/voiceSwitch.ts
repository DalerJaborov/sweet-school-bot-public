import { getSetting } from "../db.js";

/**
 * ОДИН ВЫКЛЮЧАТЕЛЬ ГОЛОСА ДЛЯ ВСЕХ АВТООТВЕТОВ (12.11.2026).
 *
 * `voiceReplyEnabled` выключен (или строки нет) — бот не отправляет голосовое
 * НИ ОТКУДА: ни синтез ElevenLabs (ai/voiceReply.ts), ни одобренное живое
 * аудио из библиотеки (ai/mediaReuse.ts), ни голос Ширин в автоответе
 * учебной группы (qaGroup.ts). Синтез дополнительно требует
 * `voiceCloneEnabled`. Ручные отправки живым человеком сюда не относятся.
 *
 * Все автоответы спрашивают только эту функцию — так новый путь не сможет
 * «забыть» рубильник (сторож: tests/unit/voiceOffNoLibraryAudio.test.ts).
 */
export async function voiceRepliesAllowed(): Promise<boolean> {
  return (await getSetting("voiceReplyEnabled")) === "true";
}
