import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { env } from "../env.js";
import { prisma, logError } from "../db.js";
import {
  openByLink,
  currentAccess,
  statusFor,
  offlineAllowed,
  purchaseFor,
  verifyMagicLink,
  listDevicesFor,
  pairDevice,
  issuePairToken,
  MAX_DEVICE_SWAPS_PER_MONTH,
  type AccessResult,
} from "./access.js";
import { masterManifest, variantManifest, offlineSegmentList } from "./manifest.js";
import { OFFLINE_RENDITION } from "../storage/videoPipeline.js";
import { presignGet, storageConfig } from "../storage/s3.js";
import { parseStringArray, parseCourseTools } from "../json.js";
import { parseRecipeCard } from "./cardOcr.js";
import { chatHistory, receiveQuestion } from "./chat.js";
import { translateMany, isCourseLanguage, type CourseLanguage } from "./i18n.js";
import {
  courseCompleted,
  renderCertificate,
  certificateFileName,
  renderCertificatePng,
  certificatePngFileName,
  verifyCertificateNumber,
} from "./certificate.js";
import { getSetting } from "../db.js";

/**
 * ПУБЛИЧНОЕ API ПЛАТФОРМЫ КУРСОВ — то, с чем разговаривает телефон ученицы.
 *
 * Пароля нет: вход по ссылке из директа, дальше кука сессии, привязанная к
 * устройству (см. access.ts). Каждый запрос сюда заодно продлевает право
 * открывать скачанные уроки ещё на 30 дней — ученица ничего не нажимает.
 */

export const courseRouter = Router();

const API_BASE = "/api/course";

/** Ссылка на фото рецепта. Шесть часов: человек читает рецепт на кухне долго,
 *  а перезагружать страницу посреди готовки не должен. */
const PHOTO_TTL_SEC = 6 * 3600;

function apiBase(): string {
  // Абсолютный адрес нужен внутри манифеста: плеер тянет ключ и дорожки по
  // тому, что там написано, а не относительно страницы.
  return `${(env.publicBaseUrl || "").replace(/\/+$/, "")}${API_BASE}`;
}

/**
 * КОНТАКТЫ ШКОЛЫ ДЛЯ ГЛАВНОЙ СТРАНИЦЫ.
 *
 * Владелец 03.09.2026: человек, нажавший ссылку, должен попадать не в видео, а
 * на страницу школы — с уроками, живыми контактами и группой в Telegram.
 * Пустые поля не отдаём вовсе: кнопка «Наш Telegram», ведущая в никуда, хуже
 * отсутствующей кнопки.
 */
async function schoolContacts(): Promise<{ telegram: string | null; instagram: string | null; whatsapp: string | null }> {
  const [telegram, instagram, phone] = await Promise.all([
    getSetting("schoolTelegramGroupUrl"),
    getSetting("schoolInstagramUrl"),
    getSetting("schoolWhatsappPhone"),
  ]);
  const digits = phone?.replace(/\D/g, "") ?? "";
  return {
    telegram: telegram?.trim() || null,
    instagram: instagram?.trim() || null,
    whatsapp: digits.length >= 9 ? `https://wa.me/${digits}` : null,
  };
}

/**
 * ТЕ ЖЕ КОНТАКТЫ БЕЗ СЕССИИ — для экрана отказа (05.09.2026).
 *
 * Человек, у которого ссылка не открылась, /me не получит — а именно ему нужнее
 * всех кнопка «Написать Ширин». Ничего личного здесь нет: это те же адреса, что
 * на публичном сайте. Кэш на минуту в памяти — чтобы экран ошибки, который
 * перезагружают в отчаянии по десять раз, не ходил в базу за одним и тем же.
 */
const CONTACTS_CACHE_MS = 60_000;
let contactsCache: { at: number; value: Awaited<ReturnType<typeof schoolContacts>> } | null = null;

courseRouter.get(`${API_BASE}/contacts`, async (_req: Request, res: Response) => {
  const now = Date.now();
  if (!contactsCache || now - contactsCache.at > CONTACTS_CACHE_MS) {
    contactsCache = { at: now, value: await schoolContacts() };
  }
  res.setHeader("Cache-Control", "public, max-age=60");
  res.json(contactsCache.value);
});

function deny(res: Response, result: Exclude<AccessResult, { ok: true }>): void {
  res.status(statusFor(result.reason)).json({ error: result.message, reason: result.reason });
}

/** Первый вход: страница отдаёт токен из адреса и отпечаток браузера. */
courseRouter.post(`${API_BASE}/open`, async (req: Request, res: Response) => {
  const parsed = z
    .object({
      token: z.string().min(10),
      fingerprint: z.string().max(200).optional(),
      /** «Это мой новый телефон» — заменить самое старое устройство. */
      replaceOldest: z.boolean().optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Нужен token" });
    return;
  }
  const result = await openByLink(req, res, parsed.data.token, parsed.data.fingerprint, parsed.data.replaceOldest ?? false);
  if (!result.ok) {
    // При упоре в лимит показываем, какие устройства заняли места, — экран
    // «заменить самое старое?» строится из этого.
    if (result.reason === "device_limit") {
      const claims = verifyMagicLink(parsed.data.token);
      const byCode = claims?.jti && !claims.contactId ? await prisma.contact.findUnique({ where: { accessTokenId: claims.jti } }) : null;
      const contactId = claims?.contactId ?? byCode?.id ?? null;
      const devices = contactId ? await listDevicesFor(contactId) : [];
      const contact = contactId ? await prisma.contact.findUnique({ where: { id: contactId } }) : null;
      const swapsLeft = contact
        ? Math.max(
            0,
            MAX_DEVICE_SWAPS_PER_MONTH -
              (contact.deviceSwapAt && contact.deviceSwapAt.getTime() > Date.now() - 30 * 86_400_000 ? contact.deviceSwaps : 0)
          )
        : 0;
      res.status(statusFor(result.reason)).json({ error: result.message, reason: result.reason, devices, swapsLeft });
      return;
    }
    return deny(res, result);
  }
  res.json({ ok: true, contactId: result.contact.id });
});

/** Установленное приложение обменивает pair-токен на сессию (см. access.ts). */
courseRouter.post(`${API_BASE}/pair`, async (req: Request, res: Response) => {
  const parsed = z.object({ pair: z.string().min(10) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Нужен pair" });
    return;
  }
  const result = await pairDevice(req, res, parsed.data.pair);
  if (!result.ok) return deny(res, result);
  res.json({ ok: true, contactId: result.contact.id });
});

/**
 * ПЕРСОНАЛЬНЫЙ МАНИФЕСТ. С живой сессией start_url несёт pair-токен этого
 * устройства — так приложение с экрана «Домой» на iPhone входит без ссылки.
 * Без сессии — обычный манифест. id фиксирован: разные start_url не должны
 * превращаться в разные приложения. no-store: манифест личный.
 */
courseRouter.get(`${API_BASE}/app.webmanifest`, async (req: Request, res: Response) => {
  const access = await currentAccess(req);
  const startUrl = access.ok ? `/course?pair=${encodeURIComponent(issuePairToken(access.contact.id, access.device))}` : "/course";
  const lang = access.ok && access.contact.preferredLanguage === "tg" ? "tg" : "ru";
  res
    .type("application/manifest+json")
    .setHeader("Cache-Control", "private, no-store")
    .json({
      id: "/course",
      name: "Shirin",
      short_name: "Shirin",
      description: lang === "tg" ? "Дарсҳои Ширин" : "Уроки Ширин",
      start_url: startUrl,
      scope: "/course",
      display: "standalone",
      display_override: ["standalone"],
      orientation: "any",
      lang,
      dir: "ltr",
      theme_color: "#C9376B",
      background_color: "#FFFFFF",
      icons: [
        { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
        { src: "/icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
    });
});

/**
 * Всё, что нужно нарисовать экран: курс, уроки, прогресс, срок офлайн-ключа.
 * Одним запросом — на телефоне каждый лишний поход в сеть это заметная пауза,
 * а у части учениц связь плохая по определению.
 */
courseRouter.get(`${API_BASE}/me`, async (req: Request, res: Response) => {
  const access = await currentAccess(req);
  if (!access.ok) return deny(res, access);

  const { contact, purchases, device } = access;

  // ВСЕ купленные курсы — в одном окне (владелец 03.09.2026). Раньше экран
  // строился из одной покупки, и купившая оба курса жила в двух окнах по двум
  // ссылкам.
  const courseIds = purchases.map((p) => p.courseId).filter((id): id is string => Boolean(id));
  const courses =
    courseIds.length > 0
      ? await prisma.course.findMany({
          where: { id: { in: courseIds } },
          orderBy: { order: "asc" },
          // Корзина: удалённый урок ученице не отдаём никогда, даже в
          // отсчёт на возврат.
          include: { modules: { orderBy: { order: "asc" }, include: { lessons: { where: { deletedAt: null }, orderBy: { order: "asc" } } } } },
        })
      : [];

  // Язык выбирает сама ученица при первом входе. Пока не выбрала — русский:
  // это язык, на котором написан весь исходный текст, и показать его без
  // перевода честнее, чем гадать по стране входа.
  const lang: CourseLanguage = isCourseLanguage(contact.preferredLanguage) ? contact.preferredLanguage : "ru";
  const profile = {
    firstName: contact.studentFirstName ?? null,
    lastName: contact.studentLastName ?? null,
    language: isCourseLanguage(contact.preferredLanguage) ? contact.preferredLanguage : null,
  };
  const school = await schoolContacts();

  // ИМЕННОЙ водяной знак. Раньше в плеер уходило название курса — одинаковое
  // у всех, поэтому по утёкшей записи было невозможно понять, кто её сделал, и
  // страха слить не возникало вовсе. Имя плюс хвост номера человека опознают
  // источник однозначно, а посторонним ничего не сообщают.
  const watermark = [
    [contact.studentFirstName, contact.studentLastName].filter(Boolean).join(" ") ||
      (contact.username ? `@${contact.username}` : ""),
    contact.id.slice(-4),
  ]
    .filter(Boolean)
    .join(" · ");

  if (courses.length === 0) {
    // Каталог ещё не заполнен (backfill не проходил) — честно говорим, что
    // курс в подготовке, вместо пустого экрана без объяснений.
    res.json({
      ready: false,
      message: "Курс готовится, загляните чуть позже",
      offlineUntil: device.offlineKeyExpiresAt,
      profile,
      school,
      watermark,
      courses: [],
      course: null,
    });
    return;
  }

  const progress = await prisma.progress.findMany({ where: { purchaseId: { in: purchases.map((p) => p.id) } } });
  const byLesson = new Map(progress.map((p) => [p.lessonId, p]));
  const cfg = await storageConfig();
  const certificates = await prisma.certificate.findMany({ where: { contactId: contact.id } });
  const certByCourse = new Map(certificates.map((c) => [c.courseId, c]));

  // ОДНА пачка перевода на весь экран, по всем курсам разом: перевод стоит
  // времени, и десятки последовательных запросов к Gemini превратили бы
  // открытие списка уроков в долгое ожидание.
  const source: string[] = [];
  for (const course of courses) {
    const lessonsFlat = course.modules.flatMap((m) => m.lessons);
    source.push(course.title, course.description ?? "");
    source.push(...course.modules.map((m) => m.title));
    source.push(...lessonsFlat.map((l) => l.title));
    source.push(...lessonsFlat.map((l) => l.recipeText ?? ""));
  }
  const t = await translateMany(source, lang);
  let cursor = 0;
  const next = () => t[cursor++];

  const out = courses.map((course) => {
    const purchase = purchaseFor(purchases, course.id);
    const lessonsFlat = course.modules.flatMap((m) => m.lessons);
    // Сертификат: положен, когда досмотрены ВСЕ готовые уроки курса. Считаем
    // здесь же, из уже загруженного прогресса — лишний запрос не нужен.
    const readyLessons = lessonsFlat.filter((l) => l.status === "READY");
    const doneCount = readyLessons.filter((l) => byLesson.get(l.id)?.completedAt).length;
    const cert = certByCourse.get(course.id);
    const title = next();
    const description = next() || null;
    const moduleTitles = course.modules.map(() => next());
    const lessonTitles = lessonsFlat.map(() => next());
    const lessonRecipes = lessonsFlat.map(() => next());
    const titleOf = new Map(lessonsFlat.map((l, i) => [l.id, lessonTitles[i]]));
    const recipeOf = new Map(lessonsFlat.map((l, i) => [l.id, lessonRecipes[i] || null]));

    return {
      id: course.id,
      code: course.code,
      title,
      description,
      // Курс куплен, но материалы ещё не завезли (например, «Арт-десерты» до
      // импорта): честно говорим об этом, а не показываем пустой список уроков
      // без единого объяснения (найдено ревизией 04.09.2026).
      comingSoon: lessonsFlat.length === 0,
      purchaseId: purchase?.id ?? null,
      // Набор инструментов курса (визуальная система 04.09.2026, §5) — не
      // переводим: названия инструментов и ссылка «где купить» владелец пишет
      // сам, на языке, на котором и должны остаться (как рецепты — правило
      // i18n.ts).
      toolsData: parseCourseTools(course.toolsData),
      certificate: {
        eligible: readyLessons.length > 0 && doneCount === readyLessons.length,
        done: doneCount,
        total: readyLessons.length,
        fullName: cert?.fullName ?? null,
        lang: cert?.lang ?? null,
        issuedAt: cert?.issuedAt ?? null,
        number: cert?.number ?? null,
      },
      modules: course.modules.map((m, mi) => ({
        id: m.id,
        title: moduleTitles[mi],
        lessons: m.lessons.map((l) => {
          const pr = byLesson.get(l.id);
          return {
            id: l.id,
            title: titleOf.get(l.id) ?? l.title,
            durationSec: l.durationSec,
            ready: l.status === "READY",
            recipeText: recipeOf.get(l.id) ?? l.recipeText,
            // Структурированный рецепт (карточка v2, §2) — как записан
            // распознаванием, БЕЗ перевода: названия ингредиентов остаются на
            // языке карточки, переводит их только markdown-версия выше.
            recipeData: l.recipeData ? parseRecipeCard(l.recipeData) : null,
            // Подписанными ссылками, а не публичными: бакет закрыт целиком.
            // Публичная раздача открыла бы вместе с фото и сегменты видео —
            // пути к ним видны прямо в манифесте, угадывать нечего.
            recipePhotos: cfg
              ? parseStringArray(l.recipePhotos).map((path) => presignGet(cfg, path, PHOTO_TTL_SEC))
              : [],
            posterUrl: cfg && l.posterPath ? presignGet(cfg, l.posterPath, PHOTO_TTL_SEC) : null,
            // Тизер — тот же срок подписи, что у обложки: это анонс, не урок.
            teaserUrl: cfg && l.teaserMp4Path ? presignGet(cfg, l.teaserMp4Path, PHOTO_TTL_SEC) : null,
            // Обложки 16:9/9:16, сгенерированные из кадра тизера/постера (storage/coverArt.ts).
            // null у старых уроков до scripts/backfill-covers.ts — тогда в UI используется posterUrl.
            coverUrl: cfg && l.coverPath ? presignGet(cfg, l.coverPath, PHOTO_TTL_SEC) : null,
            storyUrl: cfg && l.storyPath ? presignGet(cfg, l.storyPath, PHOTO_TTL_SEC) : null,
            positionSec: pr?.positionSec ?? 0,
            percent: pr?.percent ?? 0,
            completed: Boolean(pr?.completedAt),
          };
        }),
      })),
    };
  });

  res.json({
    ready: true,
    watermark,
    profile,
    school,
    offlineUntil: device.offlineKeyExpiresAt,
    offlineRendition: OFFLINE_RENDITION,
    courses: out,
    // Алиас на один релиз: старая сборка приложения, закешированная сервис-
    // воркером в телефонах, ждёт единственный `course`.
    course: out[0] ?? null,
  });
});

/**
 * ЗНАКОМСТВО: язык и имя, которые ученица вводит САМА при первом входе.
 *
 * Имя нужно не для вежливости. Оно уходит в водяной знак поверх видео — тот
 * самый, по которому видно, чья запись утекла, — и служит вторым признаком при
 * восстановлении доступа с ДРУГОГО аккаунта: чек можно переслать подруге, а
 * что человек вписал здесь, подруга не знает.
 *
 * Instagram-ник для этого не годится: он бывает вроде "sweet_girl_2007", а имя
 * профиля часто пустое или из одних значков.
 */
courseRouter.post(`${API_BASE}/profile`, async (req: Request, res: Response) => {
  const access = await currentAccess(req);
  if (!access.ok) return deny(res, access);

  const parsed = z
    .object({
      firstName: z.string().trim().min(1).max(60),
      lastName: z.string().trim().max(60).optional().default(""),
      language: z.enum(["ru", "tg"]),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Впишите имя и выберите язык", reason: "bad_profile" });
    return;
  }

  const { firstName, lastName, language } = parsed.data;
  await prisma.contact.update({
    where: { id: access.contact.id },
    data: {
      studentFirstName: firstName,
      studentLastName: lastName || null,
      preferredLanguage: language,
    },
  });
  res.json({ ok: true });
});

/**
 * СМЕНА ЯЗЫКА ПОСЛЕ ЗНАКОМСТВА — отдельно от него: перевыбрать язык человек
 * должен мочь, не вводя имя заново.
 */
courseRouter.post(`${API_BASE}/language`, async (req: Request, res: Response) => {
  const access = await currentAccess(req);
  if (!access.ok) return deny(res, access);
  const parsed = z.object({ language: z.enum(["ru", "tg"]) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Неизвестный язык", reason: "bad_language" });
    return;
  }
  await prisma.contact.update({
    where: { id: access.contact.id },
    data: { preferredLanguage: parsed.data.language },
  });
  res.json({ ok: true });
});

/**
 * СЕРТИФИКАТ. Выдаётся ТОЛЬКО за полностью пройденный курс — проверка на
 * сервере, а не по галочке на экране. Имя вводится ещё раз, даже если есть в
 * профиле: на документе не должно быть опечатки. Ошиблась — присылает новое
 * имя, запись обновляется, номер остаётся. Скачивание — отдельным GET, чтобы
 * телефон открыл PDF как файл, а не как ответ fetch.
 */
courseRouter.post(`${API_BASE}/certificate`, async (req: Request, res: Response) => {
  const access = await currentAccess(req);
  if (!access.ok) return deny(res, access);
  const parsed = z
    .object({
      courseId: z.string().min(1),
      firstName: z.string().trim().min(1).max(60),
      lastName: z.string().trim().min(1).max(60),
      lang: z.enum(["ru", "tg"]),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Впишите имя и фамилию", reason: "bad_certificate" });
    return;
  }
  const purchase = purchaseFor(access.purchases, parsed.data.courseId);
  if (!purchase) {
    res.status(404).json({ error: "Курс не найден", reason: "not_found" });
    return;
  }
  const { done, total } = await courseCompleted(purchase.id, parsed.data.courseId);
  if (total === 0 || done < total) {
    res.status(409).json({ error: `Пройдено ${done} из ${total} уроков — сертификат выдаётся за весь курс`, reason: "not_completed" });
    return;
  }

  const fullName = `${parsed.data.firstName} ${parsed.data.lastName}`.replace(/\s+/g, " ").trim();
  const existing = await prisma.certificate.findUnique({
    where: { contactId_courseId: { contactId: access.contact.id, courseId: parsed.data.courseId } },
  });
  const cert = existing
    ? await prisma.certificate.update({ where: { id: existing.id }, data: { fullName, lang: parsed.data.lang } })
    : await prisma.certificate.create({
        data: {
          contactId: access.contact.id,
          courseId: parsed.data.courseId,
          fullName,
          lang: parsed.data.lang,
          // Номер — сквозной по всем сертификатам: печатается на документе.
          number: (await prisma.certificate.count()) + 1,
        },
      });
  res.json({ ok: true, fullName: cert.fullName, lang: cert.lang, number: cert.number, issuedAt: cert.issuedAt });
});

courseRouter.get(`${API_BASE}/certificate/:courseId.pdf`, async (req: Request, res: Response) => {
  const access = await currentAccess(req);
  if (!access.ok) return deny(res, access);
  const lang = req.query.lang === "tg" ? "tg" : "ru";
  const cert = await prisma.certificate.findUnique({
    where: { contactId_courseId: { contactId: access.contact.id, courseId: req.params.courseId } },
  });
  if (!cert) {
    res.status(404).json({ error: "Сначала укажите имя для сертификата", reason: "not_found" });
    return;
  }
  const pdf = await renderCertificate({ fullName: cert.fullName, issuedAt: cert.issuedAt, lang });
  res
    .type("application/pdf")
    .setHeader("Content-Disposition", `attachment; filename="${certificateFileName(cert.number, lang)}"`)
    .setHeader("Cache-Control", "private, no-store")
    .send(Buffer.from(pdf));
});

/**
 * ВЕРСИЯ ДЛЯ ШАРИНГА — PNG 1080×1350 под ленту Instagram (визуальная система
 * 04.09.2026 §6). Та же авторизация и тот же поиск записи, что у .pdf: это не
 * новый документ, а другой формат уже выписанного сертификата.
 */
courseRouter.get(`${API_BASE}/certificate/:courseId.png`, async (req: Request, res: Response) => {
  const access = await currentAccess(req);
  if (!access.ok) return deny(res, access);
  const lang = req.query.lang === "tg" ? "tg" : "ru";
  const cert = await prisma.certificate.findUnique({
    where: { contactId_courseId: { contactId: access.contact.id, courseId: req.params.courseId } },
    include: { course: { select: { title: true } } },
  });
  if (!cert) {
    res.status(404).json({ error: "Сначала укажите имя для сертификата", reason: "not_found" });
    return;
  }
  const png = await renderCertificatePng({
    fullName: cert.fullName,
    courseTitle: cert.course.title,
    issuedAt: cert.issuedAt,
    lang,
    number: cert.number,
  });
  res
    .type("image/png")
    .setHeader("Content-Disposition", `attachment; filename="${certificatePngFileName(cert.number, lang)}"`)
    .setHeader("Cache-Control", "private, no-store")
    .send(Buffer.from(png));
});

/**
 * ПРОВЕРКА ПО QR — публично, без сессии: камера телефона наводится на код с
 * сертификата, и любой (работодатель, например) видит, что документ настоящий.
 * Никаких контактов ученицы наружу — только имя, курс и дата (certificate.ts).
 */
courseRouter.get(`${API_BASE}/certificate/verify/:number`, async (req: Request, res: Response) => {
  const result = await verifyCertificateNumber(Number(req.params.number));
  if (!result.found) {
    res.status(404).json({ ok: false });
    return;
  }
  res.json({
    ok: true,
    fullName: result.fullName,
    courseTitle: result.courseTitle,
    issuedAt: result.issuedAt,
    lang: result.lang,
  });
});

/**
 * Урок доступен этому человеку? Урок принадлежит модулю, модуль — курсу, курс —
 * одной из его покупок. Возвращаем и покупку: прогресс и чат пишутся на неё.
 */
async function lessonForAccess(access: Extract<AccessResult, { ok: true }>, lessonId: string) {
  const lesson = await prisma.lesson.findFirst({ where: { id: lessonId, deletedAt: null }, include: { module: true } });
  if (!lesson) return null;
  const purchase = purchaseFor(access.purchases, lesson.module.courseId);
  if (lesson.isPreview) return { lesson, purchase: purchase ?? access.purchase };
  if (!purchase) return null;
  return { lesson, purchase };
}

courseRouter.get(`${API_BASE}/lessons/:id/manifest`, async (req: Request, res: Response) => {
  const access = await currentAccess(req);
  if (!access.ok) return deny(res, access);
  const found = await lessonForAccess(access, req.params.id);
  if (!found) {
    res.status(404).json({ error: "Урок не найден" });
    return;
  }
  const { lesson } = found;
  const body = await masterManifest(lesson, apiBase());
  if (!body) {
    res.status(409).json({ error: "Видео этого урока ещё готовится" });
    return;
  }
  res.type("application/vnd.apple.mpegurl").send(body);
});

courseRouter.get(`${API_BASE}/lessons/:id/variant/:name`, async (req: Request, res: Response) => {
  const access = await currentAccess(req);
  if (!access.ok) return deny(res, access);
  const found = await lessonForAccess(access, req.params.id);
  if (!found) {
    res.status(404).json({ error: "Урок не найден" });
    return;
  }
  const { lesson } = found;
  const body = await variantManifest(lesson, req.params.name, apiBase());
  if (!body) {
    res.status(404).json({ error: "Качество недоступно" });
    return;
  }
  res.type("application/vnd.apple.mpegurl").send(body);
});

/**
 * КЛЮЧ РАСШИФРОВКИ — сердце защиты.
 *
 * Отдаётся только живой сессии на знакомом устройстве. Скачанные сегменты без
 * него бесполезны: переданные другому человеку файлы не откроются, а если
 * доступ отозвали, офлайн-копия умрёт сама, когда истечёт выданный ранее срок.
 */
courseRouter.get(`${API_BASE}/lessons/:id/key`, async (req: Request, res: Response) => {
  const access = await currentAccess(req);
  if (!access.ok) return deny(res, access);
  // Право на офлайн истекло — ключ не отдаём. Именно эта проверка делает
  // тридцатидневный срок настоящим, а не декоративным.
  if (!offlineAllowed(access.device)) {
    return deny(res, {
      ok: false,
      reason: "offline_expired",
      message: "Подключитесь к интернету на минуту, чтобы продолжить смотреть сохранённые уроки",
    });
  }
  const found = await lessonForAccess(access, req.params.id);
  if (!found?.lesson.encryptionKey) {
    res.status(404).json({ error: "Ключ недоступен" });
    return;
  }
  const key = Buffer.from(found.lesson.encryptionKey, "base64");
  res
    .type("application/octet-stream")
    // Ключ кешируется телефоном ради офлайна, но не промежуточными узлами:
    // private запрещает CDN и прокси держать его у себя.
    .setHeader("Cache-Control", `private, max-age=${30 * 86400}`);
  res.send(key);
});

/** Список сегментов для офлайн-загрузки — всегда экономная дорожка. */
courseRouter.get(`${API_BASE}/lessons/:id/offline`, async (req: Request, res: Response) => {
  const access = await currentAccess(req);
  if (!access.ok) return deny(res, access);
  if (!offlineAllowed(access.device)) {
    return deny(res, {
      ok: false,
      reason: "offline_expired",
      message: "Подключитесь к интернету, чтобы сохранять уроки",
    });
  }
  const found = await lessonForAccess(access, req.params.id);
  if (!found) {
    res.status(404).json({ error: "Урок не найден" });
    return;
  }
  const { lesson } = found;
  const list = await offlineSegmentList(lesson, OFFLINE_RENDITION);
  if (!list) {
    res.status(409).json({ error: "Видео этого урока ещё готовится" });
    return;
  }
  res.json({
    lessonId: lesson.id,
    rendition: OFFLINE_RENDITION,
    keyUrl: `${apiBase()}/lessons/${lesson.id}/key`,
    variantUrl: `${apiBase()}/lessons/${lesson.id}/variant/${OFFLINE_RENDITION}`,
    segments: list.urls,
  });
});

/**
 * Прогресс. Пишется дозированно (фронт шлёт раз в 15 секунд), одна строка на
 * урок — не журнал, а закладка «где остановилась».
 */
courseRouter.post(`${API_BASE}/lessons/:id/progress`, async (req: Request, res: Response) => {
  const access = await currentAccess(req);
  if (!access.ok) return deny(res, access);
  const parsed = z
    .object({ positionSec: z.number().int().min(0).max(60 * 60 * 12), percent: z.number().int().min(0).max(100) })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Ожидается { positionSec, percent }" });
    return;
  }
  const found = await lessonForAccess(access, req.params.id);
  if (!found) {
    res.status(404).json({ error: "Урок не найден" });
    return;
  }
  const { lesson } = found;

  // 70% считаем пройденным (владелец 03.09.2026): люди перематывают и не
  // досматривают хвост, а сертификат — за понимание курса, не за минуты.
  const completed = parsed.data.percent >= 70;

  // ПРОЦЕНТ ТОЛЬКО РАСТЁТ. Раньше здесь стоял `set`, и код делал ровно обратное
  // тому, что обещал комментарий: пересмотр урока с начала обнулял прогресс на
  // экране и в напоминаниях. Ученица, вернувшаяся освежить рецепт перед
  // готовкой, выглядела как бросившая курс — и получала догоняющее «вы
  // остановились», хотя прошла урок до конца.
  //
  // Позицию, наоборот, пишем как есть: это закладка «где я сейчас», и она
  // обязана двигаться назад вместе с человеком.
  const existing = await prisma.progress.findUnique({
    where: { purchaseId_lessonId: { purchaseId: found.purchase.id, lessonId: lesson.id } },
    select: { percent: true },
  });
  const percent = Math.max(parsed.data.percent, existing?.percent ?? 0);

  await prisma.progress.upsert({
    where: { purchaseId_lessonId: { purchaseId: found.purchase.id, lessonId: lesson.id } },
    create: {
      purchaseId: found.purchase.id,
      lessonId: lesson.id,
      positionSec: parsed.data.positionSec,
      percent,
      completedAt: completed ? new Date() : null,
    },
    update: {
      positionSec: parsed.data.positionSec,
      percent,
      ...(completed ? { completedAt: new Date() } : {}),
    },
  });

  // Первый реальный просмотр — тот же сигнал, что «начала учиться» в Telegram.
  if (!found.purchase.startedLearning && parsed.data.positionSec > 30) {
    await prisma.purchase
      .update({ where: { id: found.purchase.id }, data: { startedLearning: true } })
      .catch((err) => logError("course:markStartedLearning", err));
  }

  res.json({ ok: true, completed });
});

// ---------- чат с учительницей (C8) ----------

/** История одной ученицы. Ответы бота и живой Ширин для неё одинаковы: и то и
 *  другое — ответ школы, различать их ей незачем (владелец различает в панели). */
courseRouter.get(`${API_BASE}/chat`, async (req: Request, res: Response) => {
  const access = await currentAccess(req);
  if (!access.ok) return deny(res, access);
  const rows = await chatHistory(access.purchases.map((p) => p.id));
  res.json({
    messages: rows.map((m) => ({
      id: m.id,
      fromStudent: m.fromStudent,
      text: m.text,
      createdAt: m.createdAt,
    })),
  });
});

courseRouter.post(`${API_BASE}/chat`, async (req: Request, res: Response) => {
  const access = await currentAccess(req);
  if (!access.ok) return deny(res, access);
  const parsed = z
    .object({
      text: z.string().trim().min(1).max(1000),
      lessonId: z.string().nullable().optional(),
      /** Написано без сети и доставлено позже — помечаем, чтобы владелец
       *  понимал разрыв между временем вопроса и временем доставки. */
      queuedOffline: z.boolean().optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Напишите вопрос текстом, до 1000 символов" });
    return;
  }

  // Урок из чужого курса в ленту не пускаем: по нему владельцу показали бы
  // неверный контекст вопроса.
  const lessonId = parsed.data.lessonId ?? null;
  const found = lessonId ? await lessonForAccess(access, lessonId) : null;

  // Вопрос пишется на покупку того курса, к которому относится урок; без
  // урока — на якорную. Лента при этом одна на все курсы человека.
  const rows = await receiveQuestion(
    found?.purchase ?? access.purchase,
    parsed.data.text,
    found?.lesson.id ?? null,
    parsed.data.queuedOffline ?? false,
    access.purchases.map((p) => p.id)
  );
  res.json({
    messages: rows.map((m) => ({
      id: m.id,
      fromStudent: m.fromStudent,
      text: m.text,
      createdAt: m.createdAt,
    })),
  });
});
