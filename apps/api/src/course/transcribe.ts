import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { prisma, getSetting, logError, logInfo } from "../db.js";
import { resolveGeminiKeys } from "../ai/geminiKeys.js";
import { buildMediaPart } from "../ai/media.js";
import { generateWithFallback, thinkingConfigFor } from "../gemini.js";
import { logAiCall } from "../ai/aiLog.js";

/**
 * РАСШИФРОВКА УРОКА В ТЕКСТ.
 *
 * ЗАЧЕМ. В видео владелица проговаривает втрое больше, чем написано в рецепте:
 * «тесто должно тянуться вот так», «если духовка газовая — на десять градусов
 * меньше», «крем свернулся — значит сливки были холодные». Без расшифровки
 * помощник в чате на половину вопросов честно отвечает «в материалах этого
 * нет», и вопрос уходит Ширин — то есть автоматизация не работает ровно там,
 * где она нужнее всего.
 *
 * СКОЛЬКО ЭТО СТОИТ. Почти ничего, и вот почему:
 *  • звук вынимается ТЕМ ЖЕ проходом ffmpeg, который и так делает перекодировку
 *    урока, — отдельной работы для процессора почти нет;
 *  • в Gemini уходит не видео, а голая моно-дорожка 24 кбит/с: час урока это
 *    около 10 МБ вместо гигабайта;
 *  • делается ОДИН раз на урок и сохраняется в базу навсегда.
 * Для курса на двадцать часов это несколько центов суммарно, разово.
 *
 * ПОЧЕМУ НЕ WHISPER НА СВОЁМ СЕРВЕРЕ. Он бесплатен по деньгам, но не по
 * ресурсам: распознавание часа речи на слабом VPS съедает процессор на много
 * минут, а на том же сервере живёт бот, который обязан отвечать клиенткам за
 * секунды. Мы уже боремся за это с ffmpeg — добавлять вторую тяжёлую задачу
 * нельзя. К тому же таджикскую речь Gemini понимает заметно лучше.
 */

/** Битрейт дорожки для распознавания. Речь на 24 кбит/с моно разбирается без
 *  потерь, а размер файла падает в сотню раз против видео. */
const AUDIO_ARGS = ["-vn", "-ac", "1", "-ar", "16000", "-b:a", "24k", "-f", "mp3"];

/** Час речи это примерно 10 МБ; ставим потолок с запасом на длинный урок. */
const MAX_AUDIO_BYTES = 80 * 1024 * 1024;

/** Потолок на один вызов расшифровки, вместе с повторами и запасными моделями. */
const TOTAL_BUDGET_MS = 10 * 60_000;

const INSTRUCTION = [
  "Это озвучка урока кондитерской школы. Расшифруй ВСЁ, что говорит преподаватель, в связный текст.",
  "",
  "Правила:",
  "1. Пиши на том языке, на котором говорят (русский или таджикский), не переводи.",
  "2. Сохраняй все числа: граммы, градусы, минуты, количество яиц. Это самое важное в уроке.",
  "3. Убирай слова-паразиты и повторы, но не пересказывай и не сокращай смысл.",
  "4. Разбивай на абзацы по смысловым шагам приготовления.",
  "5. Не добавляй ничего от себя: ни советов, ни пояснений, ни заголовков.",
  "6. Если речь неразборчива, пропусти этот кусок молча.",
  "7. Если в записи НЕТ речи вовсе (музыка, шум, тишина, гудок) — ответь ровно одним словом: NO_SPEECH. Ничего не сочиняй.",
].join("\n");

/** Ответ модели, когда речи нет. Сравниваем без учёта регистра и знаков. */
const NO_SPEECH = "NO_SPEECH";
/**
 * Больше знаков в секунду человек не говорит. Проверочный прогон 03.09.2026:
 * на пятисекундном гудке без единого слова модель уверенно «расшифровала»
 * девять тысяч знаков про безе. Помощник в чате отвечал бы по выдумке — а
 * выдуманная температура портит десерт и доверие. Такой текст отбрасываем.
 */
const MAX_CHARS_PER_SEC = 25;

function run(command: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    // Потолок на случай, если ffmpeg встал на битом файле: без него задача
    // висела бы вечно и держала очередь (см. videoPipeline).
    const killer = setTimeout(() => child.kill("SIGKILL"), 20 * 60_000);
    killer.unref?.();
    child.on("error", (err) => {
      clearTimeout(killer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code: code ?? -1, stderr });
    });
  });
}

/** Достаёт из видеофайла моно-дорожку для распознавания. */
export async function extractAudio(sourceFile: string, outDir: string): Promise<string | null> {
  const target = path.join(outDir, "audio.mp3");
  const { code, stderr } = await run("ffmpeg", ["-y", "-i", sourceFile, ...AUDIO_ARGS, target]);
  if (code !== 0) {
    logError("transcribe:extractAudio", new Error(`ffmpeg вернул ${code}: ${stderr.slice(-500)}`));
    return null;
  }
  const size = (await fs.promises.stat(target).catch(() => null))?.size ?? 0;
  if (size === 0) return null;
  if (size > MAX_AUDIO_BYTES) {
    logError("transcribe:extractAudio", new Error(`дорожка ${Math.round(size / 1024 / 1024)} МБ — слишком длинный урок`));
    return null;
  }
  return target;
}

/**
 * Расшифровывает урок и сохраняет текст. Ошибка не роняет ничего: урок
 * останется без расшифровки, помощник будет отвечать по одному рецепту, а
 * повторить можно кнопкой в панели.
 */
export async function transcribeLesson(lessonId: string, audioFile: string): Promise<boolean> {
  // Тумблер: владелец может не хотеть тратить на это вызовы модели.
  if ((await getSetting("lessonTranscribeEnabled"))?.trim() === "false") {
    await prisma.lesson.update({ where: { id: lessonId }, data: { transcriptStatus: "SKIPPED" } });
    return false;
  }

  const apiKeys = await resolveGeminiKeys();
  if (apiKeys.length === 0) {
    await prisma.lesson.update({ where: { id: lessonId }, data: { transcriptStatus: "SKIPPED" } });
    return false;
  }

  try {
    const buffer = await fs.promises.readFile(audioFile);
    const part = await buildMediaPart(buffer, "audio/mpeg", apiKeys[0]);
    if (!part) throw new Error("не удалось подготовить дорожку для Gemini");

    // Та же модель, что для голосовых клиенток: дешёвые flash таджикскую речь
    // на слух почти не понимают.
    const model = (await getSetting("aiModelVoice"))?.trim() || "gemini-3.1-pro-preview";
    const startedAt = Date.now();
    const result = await generateWithFallback(
      apiKeys,
      model,
      (used) =>
        JSON.stringify({
          contents: [{ role: "user", parts: [part, { text: INSTRUCTION }] }],
          generationConfig: {
            temperature: 0.1,
            // Часовой урок — это тысячи слов; потолок должен вмещать их целиком.
            maxOutputTokens: 16000,
            thinkingConfig: thinkingConfigFor(used),
          },
        }),
      // Общий потолок на всю расшифровку: час речи модель разбирает минуты, но
      // висеть бесконечно она не должна — это фоновая задача с таймаутом.
      TOTAL_BUDGET_MS
    );

    // В журнал трат — тем же путём, что и остальные вызовы Gemini: расшифровка
    // урока раньше нигде не считалась (найдено 06.09.2026 — «сколько это
    // стоило» не на что было ответить), хотя это разовый, но не бесплатный ход.
    if ("error" in result) {
      void logAiCall({ endpoint: "lesson-transcribe", ms: Date.now() - startedAt, ok: false });
    } else {
      void logAiCall({ endpoint: "lesson-transcribe", model: result.model, usage: result.usage, ms: Date.now() - startedAt, ok: true });
    }

    // GeminiResult — либо { text }, либо { error }: разбираем явно, чтобы
    // причина неудачи попала в лог, а не потерялась.
    if ("error" in result) throw new Error(result.error);
    const transcript = (result.text ?? "").trim();
    if (!transcript) throw new Error("модель вернула пустую расшифровку");

    // Речи нет — так и запишем, а не «расшифровку» из головы модели.
    if (transcript.replace(/[^A-Za-z_]/g, "").toUpperCase() === NO_SPEECH || transcript.length < 20) {
      await prisma.lesson.update({ where: { id: lessonId }, data: { transcript: null, transcriptStatus: "SKIPPED" } });
      logInfo("transcribe", `урок ${lessonId}: речи нет — расшифровка пропущена`);
      return false;
    }
    const lesson = await prisma.lesson.findUnique({ where: { id: lessonId }, select: { durationSec: true } });
    if (lesson?.durationSec && transcript.length > lesson.durationSec * MAX_CHARS_PER_SEC) {
      await prisma.lesson.update({ where: { id: lessonId }, data: { transcript: null, transcriptStatus: "SKIPPED" } });
      logError(
        "transcribe:implausible",
        new Error(`урок ${lessonId}: ${transcript.length} знаков на ${lesson.durationSec} с — похоже на выдумку, отброшено`)
      );
      return false;
    }

    await prisma.lesson.update({
      where: { id: lessonId },
      data: { transcript, transcriptStatus: "READY" },
    });
    logInfo("transcribe", `урок ${lessonId}: расшифровано символов ${transcript.length}`);
    return true;
  } catch (err) {
    logError("transcribe:lesson", err);
    await prisma.lesson
      .update({ where: { id: lessonId }, data: { transcriptStatus: "FAILED" } })
      .catch((e) => logError("transcribe:markFailed", e));
    return false;
  }
}
