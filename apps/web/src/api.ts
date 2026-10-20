let token = localStorage.getItem("ssb_token") ?? "";

export function setToken(t: string) {
  token = t;
  localStorage.setItem("ssb_token", t);
}

export function hasToken(): boolean {
  return Boolean(token);
}

export function logout() {
  token = "";
  localStorage.removeItem("ssb_token");
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * ТОКЕН ПРОТУХ — ПАНЕЛЬ ВОЗВРАЩАЕТСЯ КО ВХОДУ, а не сыплет «Нужен вход» на
 * каждом экране. Токен живёт 30 дней (admin.ts, miniApp.ts); раньше после
 * этого срока App по-прежнему считал `hasToken()` истиной, и владелица
 * видела красную ошибку на каждой вкладке без единой подсказки, что делать
 * (финальный аудит 05.09.2026). Теперь 401 на запросе С токеном стирает его
 * и перезагружает страницу: в браузере покажется форма пароля, внутри
 * Telegram вход пройдёт заново по подписи initData — без участия человека.
 *
 * Только когда токен БЫЛ: 401 на /admin/login с неверным паролем — это не
 * протухшая сессия, и перезагружать форму на нём нельзя.
 */
let sessionExpiredHandler: () => void = () => {
  if (typeof location !== "undefined") location.reload();
};

/** Для тестов и для App, если тот захочет показать форму без перезагрузки. */
export function setSessionExpiredHandler(handler: () => void): void {
  sessionExpiredHandler = handler;
}

function expireSessionIfUnauthorized(res: Response, sentToken: boolean): void {
  if (res.status !== 401 || !sentToken) return;
  logout();
  sessionExpiredHandler();
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; noAuth?: boolean } = {}
): Promise<T> {
  const sentToken = Boolean(token) && !options.noAuth;
  const res = await fetch(path, {
    method: options.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      // noAuth — для входа из Telegram: токена ещё нет, он как раз выдаётся.
      ...(sentToken ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; details?: unknown };
  expireSessionIfUnauthorized(res, sentToken);
  if (!res.ok) {
    // Сервер иногда шлёт details (например, что именно не сошлось в воронке) —
    // без него владелец видел одну и ту же общую фразу на любую причину отказа.
    const details = data.details != null ? `: ${formatDetails(data.details)}` : "";
    throw new ApiError(res.status, (data.error ?? `Ошибка ${res.status}`) + details);
  }
  return data as T;
}

function formatDetails(details: unknown): string {
  if (typeof details === "string") return details;
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

/** Загрузка файла — отдельно от api(), потому что тело здесь не JSON, а форма. */
export async function uploadFile(file: File): Promise<{ url: string; kind: string }> {
  const form = new FormData();
  form.append("file", file);
  const sentToken = Boolean(token);
  const res = await fetch("/admin/upload", {
    method: "POST",
    headers: sentToken ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  const data = (await res.json().catch(() => ({}))) as { url?: string; kind?: string; error?: string };
  expireSessionIfUnauthorized(res, sentToken);
  if (!res.ok || !data.url) throw new ApiError(res.status, data.error ?? `Ошибка ${res.status}`);
  return { url: data.url, kind: data.kind ?? "" };
}

export type Button = { title: string; targetOrder: number };
export type Step = {
  order: number;
  delaySeconds: number;
  text: string;
  buttons: Button[];
  mediaUrl?: string | null;
  mediaType?: "video" | "image" | "file" | null;
  stopAfter: boolean;
};
export type Funnel = {
  id?: string;
  name: string;
  enabled: boolean;
  trigger: "COMMENT" | "DM";
  postUrl?: string | null;
  mediaIds: string[];
  keywords: string[];
  anyComment: boolean;
  startTag: string;
  repeatAfterDays: number;
  steps: Step[];
  _count?: { deliveries: number };
};
export type Delivery = {
  id: string;
  state: "ACTIVE" | "WAITING" | "DONE" | "FAILED";
  createdAt: string;
  commentText?: string | null;
  lastError?: string | null;
  contact: { id: string; igUserId: string; username?: string | null; name?: string | null; avatarUrl?: string | null; channel?: string | null };
  funnel: { name: string };
};
export type ReceiptCheck = {
  id: string;
  kind: "valid" | "suspicious" | "unchecked";
  confidence: number;
  reason: string;
  linkSent: boolean;
  ownerDecision?: "PENDING" | "APPROVED" | "REJECTED" | null;
  imageUrl?: string | null;
  /** null — сумма на чеке не прочиталась: подтверждение требует явного выбора курса. */
  amount?: number | null;
  /** Какой курс это по сумме — считает сервер теми же допусками, что allocate(). */
  courseGuess?: string | null;
  createdAt: string;
  contact: { id: string; igUserId: string; username?: string | null; name?: string | null; avatarUrl?: string | null; channel?: string | null; paid: boolean };
};
export type Testimonial = {
  id: string;
  imageUrl: string;
  caption?: string | null;
  active: boolean;
  lastShownAt?: string | null;
  createdAt: string;
};
export type PersonalContact = {
  id: string;
  igUserId: string;
  username?: string | null;
  personalReason?: string | null;
  updatedAt: string;
};

// ---- главный экран «Сегодня» (GET /admin/today, см. apps/api/src/today.ts) ----

export type Handle = { contactId: string; handle: string; instagramUrl: string | null; channel: string | null };

export type QueueItem =
  | {
      kind: "receipt";
      id: string;
      who: Handle;
      imageUrl: string | null;
      amount: number | null;
      courseGuess: string | null;
      reason: string;
      confidence: number;
      createdAt: string;
    }
  | { kind: "question"; id: string; who: Handle; text: string; lesson: string | null; createdAt: string }
  | { kind: "notOpened"; who: Handle; paidAt: string; daysAgo: number }
  | { kind: "transcodeFailed"; lessonId: string; title: string }
  | { kind: "recipesToReview"; count: number }
  | { kind: "gemini"; calls: number; limit: number; percent: number };

export type GoodNewsItem = {
  kind: "finished" | "certificate" | "openedSameDay";
  who: Handle;
  course: string | null;
  at: string;
  reviewText: string;
};

export type Today = {
  generatedAt: string;
  money: { yesterday: number; dayBefore: number; week: number; prevWeek: number; salesYesterday: number; salesWeek: number };
  pendingReceipts: number;
  unansweredQuestions: number;
  notOpened: number;
  sparkline: { day: string; money: number; sales: number }[];
  queue: QueueItem[];
  goodNews: GoodNewsItem[];
  system: {
    bot: boolean;
    instagram: boolean;
    storage: boolean;
    diskFreePct: number | null;
    gemini: { calls: number; limit: number };
    problems: string[];
  };
};

/** «Спросить помощницу» (POST /admin/assistant/ask, apps/api/src/assistantPanel.ts). */
export type AssistantSource = { tool: string; args: Record<string, unknown>; summary: string; data: unknown };
export type AssistantAnswer = {
  answer: string;
  sources: AssistantSource[];
  draft?: { text: string; forContactId: string };
  /** Посчитано без модели (нет ключей, лимит, сбой). */
  fallback?: boolean;
};
export type AssistantTurn = { role: "user" | "model"; text: string };

/** 429 с готовым ответом без ИИ приходит как ошибка с полем fallback — достаём его. */
export async function askAssistant(question: string, history: AssistantTurn[]): Promise<AssistantAnswer> {
  const sentToken = Boolean(token);
  const res = await fetch("/admin/assistant/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(sentToken ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ question, history }),
  });
  const data = (await res.json().catch(() => ({}))) as Partial<AssistantAnswer> & { error?: string; fallback?: AssistantAnswer | boolean };
  expireSessionIfUnauthorized(res, sentToken);
  if (res.ok && typeof data.answer === "string") return data as AssistantAnswer;
  if (data.fallback && typeof data.fallback === "object") return data.fallback;
  throw new ApiError(res.status, data.error ?? `Ошибка ${res.status}`);
}

/** Вопрос/ответ из чата ученицы (GET /admin/course-chat). */
export type ChatRow = {
  id: string;
  who: string;
  lesson: string | null;
  fromStudent: boolean;
  byBot: boolean;
  text: string | null;
  answered: boolean;
  createdAt: string;
};

/** Раздел «Тексты и цены» (GET/PUT /admin/texts). */
export type TextsForm = {
  prices: { course50: number; course70: number; bundle: number };
  texts: {
    paymentPhone: string;
    paymentRecipient: string;
    paymentBanks: string;
    paymentNameNoteRu: string;
    paymentNameNoteTg: string;
    certificateRuleRu: string;
    certificateRuleTg: string;
    lessonLanguageRu: string;
    lessonLanguageTg: string;
    afterPaymentRu: string;
    afterPaymentTg: string;
  };
  offline: {
    price: number;
    days: number;
    hours: string;
    desserts: number;
    address: string;
    startDate: string;
    infoRu: string;
    infoTg: string;
  };
};

export type TextsPreview = {
  priceLine: string;
  priceList: { code: string; title: string; price: number; insteadOf?: number }[];
  payment: { ru: string; tg: string };
  certificate: { ru: string; tg: string };
  lessonLanguage: { ru: string; tg: string };
  afterPayment: { ru: string; tg: string };
  offlineCard: { ru: string; tg: string };
  botRules: string;
};

export type TextsResponse = TextsForm & { defaults: TextsForm; preview: TextsPreview };

// ---- волна 2B: проверка OCR-рецептов, черновик от ИИ, импорт ----

/** Строка структурированного рецепта (Lesson.recipeData, см. cardOcr.ts). */
export type RecipeItem = { ingredient: string; amount: string | null; unit: string | null; note: string | null; emoji: string | null };
export type RecipeComponent = { name: string; items: RecipeItem[] };
export type RecipeCard = { title: string; components: RecipeComponent[]; language: string };

/** GET /admin/lessons/:id/recipe — карточка на проверку. */
export type LessonRecipe = {
  id: string;
  title: string;
  order: number;
  module: string;
  course: string;
  recipeSource: string | null;
  recipeReviewedAt: string | null;
  needsReview: boolean;
  recipeText: string | null;
  recipeData: RecipeCard | null;
  photos: string[];
};

/** GET /admin/recipes/review — уроки, ждущие проверки. */
export type ReviewRow = { id: string; title: string; order: number; module: string; course: string; coverUrl: string | null; photos: number };

/** POST /admin/course-chat/:id/draft — черновик ответа (ничего не отправляет). */
export type DraftResponse = { draft: string; source: string } | { draft: null; reason: string; note: string };

// ---- цифры и карточка ученицы (GET /admin/metrics/*, см. apps/api/src/metrics.ts) ----

export type PurchaseChannel = "INSTAGRAM" | "MESSENGER" | "WEB" | "MANUAL";

export type FunnelStep = {
  key: "wrote" | "funnel" | "receipt" | "paid" | "opened" | "finished" | "certificate";
  title: string;
  count: number;
  /** Процент от предыдущего шага; у первого — null. */
  conversion: number | null;
};
export type FunnelResponse = { days: number; steps: FunnelStep[] };

export type RevenueBucket = { key: string; title: string; count: number; sum: number };
export type RevenueResponse = {
  days: number;
  total: number;
  count: number;
  byCourse: RevenueBucket[];
  byChannel: RevenueBucket[];
  timeToPay: { medianHours: number | null; averageHours: number | null; sample: number };
};

export type StudentLesson = {
  id: string;
  title: string;
  order: number;
  ready: boolean;
  done: boolean;
  percent: number;
  positionSec: number;
  durationSec: number | null;
};
export type StudentCourse = {
  purchaseId: string;
  code: string;
  title: string;
  amount: number;
  channel: PurchaseChannel;
  boughtAt: string;
  revoked: boolean;
  firstOpenedAt: string | null;
  percent: number;
  lessonsTotal: number;
  lessonsDone: number;
  finishedAt: string | null;
  certificate: { number: number; issuedAt: string } | null;
  lessons: StudentLesson[];
};
export type StudentDevice = {
  id: string;
  label: string;
  city: string | null;
  lastSeenAt: string;
  blocked: boolean;
  blockedReason: string | null;
};
export type Student = {
  contact: {
    id: string;
    handle: string;
    name: string | null;
    studentName: string | null;
    channel: string;
    instagramUrl: string | null;
    whatsappUrl: string | null;
    paidAt: string | null;
    accessRevokedAt: string | null;
    accessIssuedAt: string | null;
    personal: boolean;
  };
  courses: StudentCourse[];
  devices: StudentDevice[];
  unansweredQuestions: number;
};

// ---- ⌘K-поиск (GET /admin/search, см. apps/api/src/search.ts) ----

export type SearchStudent = { id: string; handle: string; name: string | null; paid: boolean; phone: string | null };
export type SearchLesson = { id: string; title: string; order: number; course: string };
export type SearchSection = { tab: string; title: string };
export type SearchResponse = { q: string; students: SearchStudent[]; lessons: SearchLesson[]; sections: SearchSection[] };

export function search(q: string): Promise<SearchResponse> {
  return api<SearchResponse>(`/admin/search?q=${encodeURIComponent(q)}`);
}

/** Корзина уроков («Утро Ширин» §19): GET /admin/lessons/trash. */
export type TrashedLesson = { id: string; title: string; module: string; course: string; deletedAt: string; purgeAt: string };
export type TrashResponse = { rows: TrashedLesson[] };
export type DeleteLessonResponse = { ok: true; undoUntil: string };
