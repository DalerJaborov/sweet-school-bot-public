/**
 * ДЕМО-ДАННЫЕ ДЛЯ ЛОКАЛЬНОЙ ПАНЕЛИ — чтобы посмотреть «Утро Ширин» глазами
 * владелицы с живыми цифрами, очередью чеков и вопросами, а не на пустой базе.
 *
 * ТОЛЬКО DEV: скрипт отказывается работать, если DATABASE_URL не указывает на
 * dev.db. На проде запускать нечего и незачем — данные здесь выдуманные.
 *
 * Запуск из apps/api:
 *   npx tsx scripts/seed-demo.ts
 *
 * Повторный запуск сначала удаляет всё, что создал прошлый (по префиксу
 * igUserId "demo-" и коду курсов), потом создаёт заново.
 */
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";

dotenv.config();

const url = process.env.DATABASE_URL ?? "";
if (!url.includes("dev.db")) {
  console.error("seed-demo: DATABASE_URL должен указывать на dev.db — это демо-данные, не для прода.");
  process.exit(1);
}

const { prisma } = await import("../src/db.js");
const { MEDIA_DIR } = await import("../src/upload.js");

const DAY = 86_400_000;
const now = Date.now();
const ago = (days: number, hours = 0) => new Date(now - days * DAY - hours * 3_600_000);

// ---- люди -----------------------------------------------------------------

const PEOPLE: { name: string; username: string; channel?: string }[] = [
  { name: "Мадина Рахимова", username: "madina.cakes" },
  { name: "Нигина Саидова", username: "nigina_sweet" },
  { name: "Фарзона Қурбонова", username: "farzona.qurbonova" },
  { name: "Шаҳноза Ҳакимова", username: "shahnoza_hakimova" },
  { name: "Дилноза Мирзоева", username: "dilnoza.mirzoeva" },
  { name: "Гулнора Юсупова", username: "gulnora_yusupova" },
  { name: "Малика Азизова", username: "malika.azizova" },
  { name: "Зарина Ниёзова", username: "zarina_niyozova" },
  { name: "Севара Бобоева", username: "sevara.boboeva" },
  { name: "Мехрангез Шарипова", username: "mehrangez_sharipova" },
  { name: "Тахмина Раҷабова", username: "tahmina.rajabova" },
  { name: "Нилуфар Ғаффорова", username: "nilufar_gafforova" },
  { name: "Муниса Каримова", username: "munisa.karimova" },
  { name: "Фотима Абдуллоева", username: "fotima_abdulloeva" },
  { name: "Анастасия Петрова", username: "nastya.bakes" },
  { name: "Екатерина Смирнова", username: "katya_smirnova" },
  { name: "Ольга Иванова", username: "olga.ivanova.cake" },
  { name: "Марҳабо Назарова", username: "marhabo_nazarova" },
  { name: "Сарвиноз Ҷӯраева", username: "sarvinoz.juraeva" },
  { name: "Парвина Давлатова", username: "parvina_davlatova" },
  { name: "Ҳусния Сафарова", username: "husniya.safarova" },
  { name: "Мавлуда Исмоилова", username: "mavluda_ismoilova" },
  { name: "Рухшона Аминова", username: "rukhshona.aminova" },
  { name: "Шукрона Одинаева", username: "shukrona_odinaeva" },
  { name: "Мунира Холова", username: "munira.kholova" },
  { name: "Нозанин Раҳмонова", username: "nozanin_rahmonova" },
  { name: "Диёра Ашурова", username: "diyora.ashurova" },
  { name: "Фируза Ҳасанова", username: "firuza_hasanova" },
  { name: "Гулчеҳра Муродова", username: "gulchehra.murodova" },
  { name: "Лола Нуралиева", username: "lola_nuralieva" },
  { name: "Мадинабону Абдуллозода Саидмуродовна", username: "madinabonu_abdullozoda_saidmurodovna" },
  { name: "Наргис Валиева", username: "nargis.valieva", channel: "WEB" },
  { name: "Ирина Кузнецова", username: "irina.kuznetsova", channel: "WEB" },
  { name: "Сабрина Каримзода", username: "sabrina_karimzoda", channel: "MESSENGER" },
  { name: "Манижа Раҳимзода", username: "manizha.rahimzoda" },
  { name: "Зулфия Ҳамидова", username: "zulfiya_hamidova" },
  { name: "Барно Собирова", username: "barno.sobirova" },
  { name: "Ҷамила Умарова", username: "jamila_umarova" },
  { name: "Шоира Ғуломова", username: "shoira.gulomova" },
  { name: "Матлуба Эргашева", username: "matluba_ergasheva" },
];

// ---- курсы ----------------------------------------------------------------

type LessonSeed = { title: string; status: "READY" | "PROCESSING" | "FAILED"; ocr?: "reviewed" | "pending"; durationSec?: number };

const COURSES: { code: string; title: string; price: number; description: string; modules: { title: string; lessons: LessonSeed[] }[] }[] = [
  {
    code: "COURSE70",
    title: "21 рецепт",
    price: 70,
    description: "Классика домашней кондитерской: от клубники в шоколаде до чизкейка.",
    modules: [
      {
        title: "Основы",
        lessons: [
          { title: "Клубника в шоколаде", status: "READY", ocr: "reviewed", durationSec: 612 },
          { title: "Чизкейк «Твикс»", status: "READY", ocr: "pending", durationSec: 1340 },
          { title: "Пирожное «Сникерс»", status: "READY", ocr: "pending", durationSec: 980 },
          { title: "Трайфл «Красный бархат»", status: "READY", ocr: "reviewed", durationSec: 1105 },
        ],
      },
      {
        title: "Торты",
        lessons: [
          { title: "Медовик со сметанным кремом", status: "READY", durationSec: 1710 },
          { title: "Наполеон", status: "PROCESSING" },
          { title: "Торт «Три молока» — классический вариант с карамельной пропиткой", status: "READY", ocr: "pending", durationSec: 1502 },
          { title: "Морковный торт", status: "FAILED" },
        ],
      },
    ],
  },
  {
    code: "COURSE50",
    title: "Арт-десерты",
    price: 50,
    description: "Десерты, которые фотографируют: муссы, зеркальная глазурь, бенто-торты.",
    modules: [
      {
        title: "Муссы и глазурь",
        lessons: [
          { title: "Мусс «Три шоколада»", status: "READY", ocr: "reviewed", durationSec: 1420 },
          { title: "Зеркальная глазурь", status: "READY", durationSec: 890 },
          { title: "Бенто-торт с ягодами", status: "READY", durationSec: 1210 },
          { title: "Макарон на итальянской меренге", status: "READY", durationSec: 1660 },
          { title: "Тарт с лимонным курдом", status: "READY", durationSec: 1330 },
          { title: "Павлова с маскарпоне", status: "PROCESSING" },
        ],
      },
    ],
  },
];

const RECIPE_DATA = (title: string) =>
  JSON.stringify({
    title,
    language: "tg",
    components: [
      {
        name: "Хамир",
        items: [
          { ingredient: "Орд", amount: "250", unit: "г", note: null, emoji: "🌾" },
          { ingredient: "Шакар", amount: "120", unit: "г", note: null, emoji: "🍬" },
          { ingredient: "Тухм", amount: "3", unit: "дона", note: "калон", emoji: "🥚" },
          { ingredient: "Равған", amount: "180", unit: "г", note: "82,5%", emoji: "🧈" },
        ],
      },
      {
        name: "Крем",
        items: [
          { ingredient: "Қаймоқ", amount: "300", unit: "мл", note: "33%", emoji: "🥛" },
          { ingredient: "Шоколад", amount: "150", unit: "г", note: "сиёҳ", emoji: "🍫" },
          { ingredient: "Ванилин", amount: "1", unit: "қошуқ", note: null, emoji: null },
        ],
      },
    ],
  });

const RECIPE_TEXT = `## Хамир
- Орд — 250 г
- Шакар — 120 г
- Тухм — 3 дона (калон)
- Равған — 180 г (82,5%)

## Крем
- Қаймоқ — 300 мл (33%)
- Шоколад — 150 г (сиёҳ)
- Ванилин — 1 қошуқ`;

const QUESTIONS = [
  "Салом! Крем у меня получился жидким, взбивала 5 минут — что не так? Сливки 33%, холодные.",
  "Можно заменить маскарпоне на творожный сыр? В магазине не нашла.",
  "Шоколад ҳангоми об кардан ғафс шуд, чӣ кор кунам?",
  "Сколько дней хранится медовик в холодильнике, если делать на заказ к субботе?",
];

// ---- картинки -------------------------------------------------------------

function placeholderJpeg(kind: "receipt" | "card", index: number): Buffer {
  const w = kind === "receipt" ? 720 : 960;
  const h = kind === "receipt" ? 1280 : 720;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = kind === "receipt" ? "#ffffff" : "#fff3e6";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#1f1b1b";
  ctx.font = "bold 40px sans-serif";
  if (kind === "receipt") {
    const amounts = [50, 70, 100];
    const amount = amounts[index % amounts.length];
    ctx.fillText("Алиф Моби", 60, 120);
    ctx.font = "28px sans-serif";
    ctx.fillText("Перевод выполнен", 60, 180);
    ctx.font = "bold 72px sans-serif";
    ctx.fillText(`${amount},00 TJS`, 60, 320);
    ctx.font = "28px sans-serif";
    ctx.fillText("Получатель: Фарангис Ч.", 60, 400);
    ctx.fillText("+992 905 355 355", 60, 450);
    ctx.fillText(new Date(now - index * 3_600_000).toLocaleString("ru-RU"), 60, 520);
    ctx.fillStyle = "#c9376b";
    ctx.fillRect(60, 580, w - 120, 6);
    ctx.fillStyle = "#777";
    ctx.font = "24px sans-serif";
    ctx.fillText("Демо-чек для локальной панели", 60, 660);
  } else {
    ctx.fillText("Карточка рецепта", 60, 100);
    ctx.font = "30px sans-serif";
    const lines = RECIPE_TEXT.split("\n");
    lines.forEach((line, i) => ctx.fillText(line.replace(/^#+\s*/, ""), 60, 180 + i * 44));
  }
  return canvas.toBuffer("image/jpeg", 82);
}

function writeMedia(name: string, buf: Buffer): string {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  fs.writeFileSync(path.join(MEDIA_DIR, name), buf);
  return `/media/${name}`;
}

// ---- основная работа ------------------------------------------------------

async function wipe(): Promise<void> {
  await prisma.contact.deleteMany({ where: { igUserId: { startsWith: "demo-" } } });
  await prisma.course.deleteMany({ where: { code: { in: COURSES.map((c) => c.code) } } });
}

async function main(): Promise<void> {
  await wipe();

  // Курсы, разделы, уроки.
  const lessonIds: Record<string, string[]> = {};
  const courseIds: Record<string, string> = {};
  const cardUrl = writeMedia("demo-recipe-card.jpg", placeholderJpeg("card", 0));
  for (const [ci, c] of COURSES.entries()) {
    const course = await prisma.course.create({
      data: { code: c.code, title: c.title, price: c.price, description: c.description, order: ci, active: true },
    });
    courseIds[c.code] = course.id;
    lessonIds[c.code] = [];
    // Нумерация уроков с 1 — как у импортёра (importRoutes.ts: order ≥ 1).
    let order = 1;
    for (const [mi, m] of c.modules.entries()) {
      const mod = await prisma.module.create({ data: { courseId: course.id, title: m.title, order: mi } });
      for (const l of m.lessons) {
        const lesson = await prisma.lesson.create({
          data: {
            moduleId: mod.id,
            title: l.title,
            order: order++,
            status: l.status,
            hlsPath: l.status === "READY" ? `courses/${c.code}/${order - 1}/master.m3u8` : null,
            durationSec: l.durationSec ?? null,
            transcriptStatus: l.status === "READY" ? "READY" : "PENDING",
            recipeText: l.ocr ? RECIPE_TEXT : `Рецепт «${l.title}»: смешать, выпекать 40 минут при 170 °C.`,
            recipeData: l.ocr ? RECIPE_DATA(l.title) : null,
            recipeSource: l.ocr ? "card-ocr" : null,
            recipeReviewedAt: l.ocr === "reviewed" ? ago(3) : null,
            // Локально хранилища нет — ключи есть, presign их не отдаст; путь
            // нужен, чтобы счётчик «фото» в списке проверки был не нулевым.
            recipePhotos: l.ocr ? JSON.stringify([cardUrl]) : "[]",
            isPreview: order === 2,
          },
        });
        lessonIds[c.code].push(lesson.id);
      }
    }
  }

  // Контакты.
  const contacts: { id: string; username: string; channel: string }[] = [];
  for (const [i, p] of PEOPLE.entries()) {
    const channel = p.channel ?? "INSTAGRAM";
    const c = await prisma.contact.create({
      data: {
        channel,
        igUserId: `demo-${1000 + i}`,
        username: p.username,
        name: p.name,
        createdAt: ago(30 - Math.floor(i * 0.7)),
        studentFirstName: i % 3 === 0 ? p.name.split(" ")[0] : null,
        studentLastName: i % 3 === 0 ? p.name.split(" ").slice(1).join(" ") : null,
        preferredLanguage: i % 4 === 0 ? "tg" : "ru",
      },
    });
    contacts.push({ id: c.id, username: p.username, channel });
    // Пара сообщений — для воронки «написали».
    await prisma.message.createMany({
      data: [
        { contactId: c.id, direction: "IN", text: i % 2 ? "Салом, курс чанд пул?" : "Здравствуйте, сколько стоит курс?", createdAt: ago(30 - Math.floor(i * 0.7), 1) },
        { contactId: c.id, direction: "OUT", text: "Курс «21 рецепт» — 50 с., «Арт-десерты» — 70 с., оба — 100 с.", createdAt: ago(30 - Math.floor(i * 0.7)) },
      ],
    });
  }

  // 25 покупок за 30 дней (часть — сегодня/вчера).
  const purchaseDays = [0, 0, 1, 1, 1, 2, 3, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 15, 17, 19, 21, 23, 25, 27, 29];
  const purchases: { id: string; contactId: string; code: string; createdAt: Date }[] = [];
  for (const [i, days] of purchaseDays.entries()) {
    const contact = contacts[i];
    const bundle = i % 5 === 0;
    const codes = bundle ? ["COURSE50", "COURSE70"] : [i % 3 === 0 ? "COURSE70" : "COURSE50"];
    const createdAt = ago(days, (i * 5) % 20);
    await prisma.contact.update({
      where: { id: contact.id },
      data: {
        paid: true,
        paidAt: createdAt,
        accessTokenId: `demo-token-${i}`,
        accessIssuedAt: createdAt,
      },
    });
    for (const code of codes) {
      const amount = bundle ? (code === "COURSE50" ? 50 : 50) : code === "COURSE50" ? 50 : 70;
      const opened = i % 7 !== 3 && days > 0; // несколько «оплатила, но не открыла»
      const p = await prisma.purchase.create({
        data: {
          contactId: contact.id,
          course: code,
          courseId: courseIds[code],
          amount,
          rawAmount: bundle ? 100 : amount,
          currency: "TJS",
          source: i === 8 ? "MANUAL" : "RECEIPT",
          createdAt,
          firstOpenedAt: opened ? new Date(createdAt.getTime() + (i % 2 ? 2 * 3_600_000 : 1.5 * DAY)) : null,
          startedLearning: opened,
        },
      });
      purchases.push({ id: p.id, contactId: contact.id, code, createdAt });
      if (opened) {
        // Устройство.
        await prisma.device.create({
          data: {
            purchaseId: p.id,
            contactId: contact.id,
            secret: `demo-secret-${p.id}`,
            fingerprint: `demo-fp-${p.id}`,
            userAgent:
              i % 2
                ? "Mozilla/5.0 (Linux; Android 13; SM-A515F) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36"
                : "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1",
            lastCity: i % 3 ? "Душанбе" : "Худжанд",
            firstSeenAt: p.firstOpenedAt ?? createdAt,
            lastSeenAt: ago(Math.max(0, days - 1)),
            offlineKeyExpiresAt: ago(-30),
          },
        });
        // Прогресс: чем старше покупка, тем дальше прошла.
        const ids = lessonIds[code];
        const done = Math.min(ids.length, Math.floor(days / 3) + (i % 2));
        for (const [li, lessonId] of ids.entries()) {
          if (li < done) {
            await prisma.progress.create({
              data: { purchaseId: p.id, lessonId, percent: 100, positionSec: 0, completedAt: new Date(createdAt.getTime() + (li + 1) * DAY) },
            });
          } else if (li === done) {
            await prisma.progress.create({ data: { purchaseId: p.id, lessonId, percent: 35, positionSec: 400 } });
          }
        }
      }
    }
  }

  // Сертификаты: две ученицы прошли всё.
  const finished = [purchases[purchases.length - 1], purchases[purchases.length - 3]];
  let number = 1;
  for (const p of finished) {
    const ids = lessonIds[p.code];
    for (const lessonId of ids) {
      await prisma.progress.upsert({
        where: { purchaseId_lessonId: { purchaseId: p.id, lessonId } },
        create: { purchaseId: p.id, lessonId, percent: 100, completedAt: ago(2) },
        update: { percent: 100, completedAt: ago(2) },
      });
    }
    const who = PEOPLE[contacts.findIndex((c) => c.id === p.contactId)];
    await prisma.certificate.create({
      data: { contactId: p.contactId, courseId: courseIds[p.code], fullName: who.name, number: number++, issuedAt: ago(1, 3) },
    });
  }

  // 4 вопроса без ответа + один отвеченный.
  for (const [i, text] of QUESTIONS.entries()) {
    const p = purchases[i + 2];
    await prisma.courseChatMessage.create({
      data: { purchaseId: p.id, lessonId: lessonIds[p.code][i % 3], fromStudent: true, text, createdAt: ago(0, 2 + i * 5) },
    });
  }
  await prisma.courseChatMessage.create({
    data: { purchaseId: purchases[7].id, lessonId: lessonIds[purchases[7].code][0], fromStudent: true, text: "Спасибо, всё получилось!", readByOwnerAt: ago(1), createdAt: ago(1, 4) },
  });
  await prisma.courseChatMessage.create({
    data: { purchaseId: purchases[7].id, fromStudent: false, text: "Ура! Ждём фото 🍰", createdAt: ago(1, 3) },
  });

  // 3 чека, ждущих решения (у людей, которые ещё не купили) + история.
  const pendingReasons = [
    "Сумма 50, но получатель не наш — «Фаридун Р.». Похоже, перевод не на ту карту.",
    "Скриншот размыт, дата не читается.",
    "Сумма 100 сомони — оба курса? Дата вчерашняя, получатель совпадает.",
  ];
  const pendingAmounts = [50, null, 100];
  for (let i = 0; i < 3; i++) {
    const contact = contacts[30 + i];
    const url = writeMedia(`demo-receipt-${i + 1}.jpg`, placeholderJpeg("receipt", i));
    await prisma.receiptCheck.create({
      data: {
        contactId: contact.id,
        kind: "suspicious",
        confidence: 40 + i * 15,
        reason: pendingReasons[i],
        ownerDecision: "PENDING",
        imageUrl: url,
        amount: pendingAmounts[i],
        imageHash: `demo-hash-pending-${i}`,
        receiptAt: ago(0, 3 + i),
        createdAt: ago(0, 1 + i * 4),
      },
    });
  }
  for (const [i, p] of purchases.slice(0, 12).entries()) {
    await prisma.receiptCheck.create({
      data: {
        contactId: p.contactId,
        kind: "valid",
        confidence: 90 + (i % 9),
        reason: "Перевод на наши реквизиты, сумма совпадает с ценой курса.",
        linkSent: true,
        ownerDecision: null,
        amount: p.code === "COURSE50" ? 50 : 70,
        imageHash: `demo-hash-valid-${i}`,
        createdAt: p.createdAt,
        decidedAt: p.createdAt,
      },
    });
  }

  // Запись на офлайн-курс.
  await prisma.offlineSignup.create({
    data: { contactId: contacts[35].id, name: "Зулфия Ҳамидова", phone: "+992 93 555 44 33", notified: true, createdAt: ago(2) },
  });

  // Личный контакт (мама).
  await prisma.contact.update({ where: { id: contacts[39].id }, data: { personal: true, personalReason: "мама Ширин" } });

  // Платформа, а не Telegram-группа — иначе «не открыла» считается по группе.
  await prisma.setting.upsert({ where: { key: "courseDeliveryMode" }, create: { key: "courseDeliveryMode", value: "web" }, update: { value: "web" } });

  console.log(
    `seed-demo: контактов ${contacts.length}, покупок ${purchases.length}, уроков ${Object.values(lessonIds).flat().length}, чеков в ожидании 3, вопросов ${QUESTIONS.length}`
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
