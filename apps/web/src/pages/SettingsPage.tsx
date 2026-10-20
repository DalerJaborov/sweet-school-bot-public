import { useEffect, useRef, useState } from "react";

/** Ответ живой проверки модели (POST /admin/gemini-test). */
interface CheckResult {
  ok: boolean;
  /** HTTP-код Google; null — до него не дошли вовсе (сеть, таймаут, прокси). */
  status: number | null;
  /** Ответ Google дословно: наша интерпретация как раз и прятала настоящую причину. */
  detail: string;
  ms: number;
}
import { api } from "../api";
import { toast } from "../components/Toast";
import { Icons } from "../components/Brand";
import { useUnsavedGuard } from "../components/UnsavedGuard";
import { StoragePaste } from "../components/StoragePaste";
import { TelegramWebhook } from "../components/TelegramWebhook";

/**
 * Ключи настроек выводятся из FIELDS и ToggleKey, а не Record<string,…>:
 * опечатка в ключе (`values.aiModle`) раньше молча давала undefined и пустое
 * поле, теперь это ошибка компиляции. Список ключей на сервере —
 * services/settingsService.ts; здесь только те, что показывает панель.
 */
type FieldDef<K extends string> = {
  key: K;
  label: string;
  hint?: string;
  secret?: boolean;
  textarea?: boolean;
  checkable?: boolean;
  /** Поле, где нельзя ошибиться форматом: выбор из списка или календарь.
   *  Свободный текст «впишите ровно web» — тот же класс ошибки, что и провал
   *  с Cloudflare: человека просят перенести данные в формате, который знает
   *  только программа. */
  kind?: "radio" | "date";
  options?: { value: string; label: string }[];
};

/** Сохраняет литеральные типы ключей, не заставляя перечислять их дважды. */
function defineFields<const K extends string>(fields: readonly FieldDef<K>[]): readonly FieldDef<K>[] {
  return fields;
}

type ToggleKey = "aiEnabled" | "stuckAlertEnabled" | "qaAutoReplyEnabled";

/**
 * `checkable` — рядом с полем появляется кнопка «Проверить»: она спрашивает у Google
 * именно эту модель и показывает его ответ дословно.
 *
 * Зачем. За август Google закрыл две модели без предупреждения, и каждый раз бот
 * отвечал хуже или молчал, а понять почему было нельзя: за словом «не отвечает»
 * прячутся 404 (модель закрыта), 429 (кончилась квота), 401 (ключ мёртв) и 503
 * (перегрузка) — четыре беды с четырьмя разными лечениями. Владелец не может
 * зайти на сервер и посмотреть код ответа; теперь и не нужно.
 */
const FIELDS = defineFields([
  { key: "igToken", label: "Маркер доступа Instagram", secret: true, hint: "Получим при подключении аккаунта Ширин" },
  { key: "verifyToken", label: "Проверочное слово вебхука", hint: "Любая строка — её же вбиваем в настройках приложения Meta" },
  { key: "appSecret", label: "Секрет приложения Meta", secret: true, hint: "Для проверки подписи вебхука (можно оставить пустым)" },
  { key: "geminiKey", label: "Ключ Gemini", secret: true, hint: "Для ИИ-консультанта" },
  {
    key: "geminiKeysExtra",
    label: "Ещё ключи Gemini (запасные)",
    secret: true,
    textarea: true,
    hint: "По одному на строку (или через запятую) — бот переключится сюда сам, если основной ключ откажет или упрётся в лимит",
  },
  {
    key: "aiModel",
    label: "Модель ИИ",
    hint: "По умолчанию gemini-3.7-flash. Google закрывает модели без предупреждения — если бот вдруг отвечает хуже или молчит, смените имя здесь и нажмите «Проверить»",
    checkable: true,
  },
  {
    key: "aiModelVoice",
    label: "Модель для голосовых",
    hint: "По умолчанию gemini-3.1-pro-preview. Дешёвые модели таджикскую речь на слух почти не понимают — здесь нужна сильная, даже ценой 20 секунд ожидания",
    checkable: true,
  },
  { key: "aiPrompt", label: "Промт ИИ-консультанта", textarea: true, hint: "Кто он, как отвечает, что знает о курсах и Ширин" },
  {
    key: "fbPageToken",
    label: "Маркер страницы Facebook (Messenger)",
    secret: true,
    hint: "Чтобы бот отвечал и в Messenger страницы Ширин. Пусто — работает только Instagram",
  },
  { key: "fbPageId", label: "ID страницы Facebook", hint: "Нужен для проверки, что вебхук пришёл от нашей страницы" },
  {
    key: "telegramBotToken",
    label: "Токен Telegram-бота",
    secret: true,
    hint: "Один и тот же бот — добавь его админом (с правом приглашать) в ОБЕ группы, право заходить в них по одной ссылке ему не нужно, только выдавать",
  },
  { key: "telegramChatId50", label: "ID группы — курс за 50 сомони", hint: "Например -1001234567890" },
  { key: "telegramChatId70", label: "ID группы — курс за 70 сомони", hint: "Например -1009876543210" },
  {
    key: "manualInviteLinks",
    label: "Постоянные ссылки, которые вы рассылаете сами",
    textarea: true,
    hint: "По одной на строку — вход по ним бот не будет считать «непонятным» и не пришлёт тревогу",
  },
  {
    key: "courseAccessLink",
    label: "Запасная ссылка доступа",
    hint: "Если сумма на чеке не читается или Telegram не настроен — уйдёт эта, статичная (её увидит и владелец в «Чеках», решит сам)",
  },
  {
    key: "offlineCourseDate",
    label: "Офлайн-курс: дата начала",
    hint: "Например «3 октября». Бот называет её тем, кто хочет записаться",
  },
  {
    key: "offlineCourseStartDate",
    label: "Офлайн-курс: дата начала набора",
    hint: "Сайт и бот показывают «Ближайший набор: …» только пока дата впереди; когда она прошла — пишут «дата уточняется», пока вы не поставите новую. За сутки до неё бот напомнит записавшимся и пришлёт вам список с номерами",
    kind: "date",
  },
  {
    key: "offlineCourseInfoTg",
    label: "Офлайн-курс: сообщение на таджикском",
    textarea: true,
    hint: "Уходит клиентке дословно, отдельным сообщением — бот его не пересказывает. Пишите короткими строками со значками, так читается с телефона за секунду. Пусто — уйдёт заготовка",
  },
  {
    key: "offlineCourseInfo",
    label: "Офлайн-курс: сообщение на русском",
    textarea: true,
    hint: "То же самое для тех, кто пишет по-русски. Язык бот выбирает сам по переписке",
  },
  {
    key: "schoolTelegramGroupUrl",
    label: "Сайт: группа в Telegram",
    hint: "Ссылка вида https://t.me/… — ученицы увидят кнопку на главной странице уроков. Пусто — кнопки не будет",
  },
  {
    key: "schoolInstagramUrl",
    label: "Сайт: Instagram",
    hint: "Ссылка на профиль Ширин. Тоже кнопкой на главной странице",
  },
  {
    key: "schoolWhatsappPhone",
    label: "Сайт: номер для WhatsApp",
    hint: "С кодом страны, например 992001234567. Ученица нажмёт и сразу напишет живому человеку",
  },
  {
    key: "r2Endpoint",
    label: "Хранилище видео: адрес",
    hint: "Из Cloudflare R2, вида https://<длинный-id>.r2.cloudflarestorage.com",
  },
  { key: "r2Bucket", label: "Хранилище видео: имя бакета", hint: "Например sweet-school" },
  {
    key: "r2AccessKeyId",
    label: "Хранилище видео: ключ доступа",
    secret: true,
    hint: "Access Key ID из Cloudflare — показывается один раз при создании токена",
  },
  {
    key: "r2SecretKey",
    label: "Хранилище видео: секретный ключ",
    secret: true,
    hint: "Secret Access Key из Cloudflare — тоже показывается один раз",
  },
  {
    key: "courseDeliveryMode",
    label: "Куда вести после оплаты",
    hint: "Старые ученицы остаются там, где были, — это только для новых покупок",
    kind: "radio",
    options: [
      { value: "telegram", label: "В Telegram-группу (как раньше)" },
      { value: "web", label: "На нашу платформу — одна ссылка на все курсы" },
      { value: "both", label: "Обе ссылки в одном сообщении" },
    ],
  },
  {
    key: "stuckAlertCooldownHours",
    label: "Тревога «застрял» — пауза между повторами по одному человеку, часов",
    hint: "По умолчанию 2. Не влияет, если тревога выключена тумблером ниже",
  },
]);

type FieldKey = (typeof FIELDS)[number]["key"];
type SettingKey = FieldKey | ToggleKey;
type Settings = Partial<Record<SettingKey, string | null>>;

export function SettingsPage() {
  const [values, setValues] = useState<Settings>({});
  const [aiEnabled, setAiEnabled] = useState(false);
  const [stuckAlertEnabled, setStuckAlertEnabled] = useState(true);
  // По умолчанию ВЫКЛЮЧЕНО (в отличие от stuckAlertEnabled выше) — новая
  // возможность включать сюрпризом сразу после деплоя не должна, владелец
  // включает осознанно, когда готова (26.08.2026).
  const [qaAutoReplyEnabled, setQaAutoReplyEnabled] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** Какое поле сейчас проверяется и что ответил Google по каждому — см. checkModel. */
  const [checking, setChecking] = useState<string | null>(null);
  const [checks, setChecks] = useState<Partial<Record<FieldKey, CheckResult>>>({});
  // Что пришло с сервера — с этим сравниваем текущий ввод, чтобы понять, есть
  // ли несохранённые правки (см. UnsavedGuard: раньше уход со страницы посреди
  // редактирования промта в 10 000 символов терял его без единого предупреждения).
  const original = useRef<{
    values: Settings;
    aiEnabled: boolean;
    stuckAlertEnabled: boolean;
    qaAutoReplyEnabled: boolean;
  } | null>(null);
  const dirty =
    original.current != null &&
    (aiEnabled !== original.current.aiEnabled ||
      stuckAlertEnabled !== original.current.stuckAlertEnabled ||
      qaAutoReplyEnabled !== original.current.qaAutoReplyEnabled ||
      FIELDS.some((f) => (values[f.key] ?? "") !== (original.current!.values[f.key] ?? "")));
  useUnsavedGuard(dirty);

  function setValue(key: FieldKey, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  useEffect(() => {
    api<Settings>("/admin/settings")
      .then((s) => {
        setValues(s);
        setAiEnabled(s.aiEnabled === "true");
        // По умолчанию включено — тот же приём, что stuckAlert.ts: отсутствие
        // настройки не значит "выключено".
        setStuckAlertEnabled(s.stuckAlertEnabled !== "false");
        setQaAutoReplyEnabled(s.qaAutoReplyEnabled === "true");
        original.current = {
          values: s,
          aiEnabled: s.aiEnabled === "true",
          stuckAlertEnabled: s.stuckAlertEnabled !== "false",
          qaAutoReplyEnabled: s.qaAutoReplyEnabled === "true",
        };
      })
      .catch((e) => setErr(e.message));
  }, []);

  /**
   * Проверяем ТО, ЧТО СОХРАНЕНО, а не то, что набрано в поле: бот работает
   * сохранённым значением, и проверка набранного отвечала бы на другой вопрос.
   * Поэтому сначала сохраняем, потом спрашиваем Google.
   */
  async function checkModel(key: FieldKey) {
    setChecking(key);
    try {
      await api("/admin/settings", {
        method: "PUT",
        body: {
          ...Object.fromEntries(FIELDS.map((f) => [f.key, values[f.key] ?? ""])),
          aiEnabled: String(aiEnabled),
          stuckAlertEnabled: String(stuckAlertEnabled),
          qaAutoReplyEnabled: String(qaAutoReplyEnabled),
        },
      });
      original.current = { values, aiEnabled, stuckAlertEnabled, qaAutoReplyEnabled };
      const result = await api<CheckResult>("/admin/gemini-test", {
        method: "POST",
        body: { model: values[key] ?? "" },
      });
      setChecks((prev) => ({ ...prev, [key]: result }));
    } catch (e) {
      setChecks((prev) => ({
        ...prev,
        [key]: { ok: false, status: null, detail: e instanceof Error ? e.message : "Проверка не удалась", ms: 0 },
      }));
    } finally {
      setChecking(null);
    }
  }

  async function save() {
    if (saving) return; // защита от двойного тапа
    setSaving(true);
    setErr(null);
    try {
      const payload: Record<string, string> = {
        aiEnabled: String(aiEnabled),
        stuckAlertEnabled: String(stuckAlertEnabled),
        qaAutoReplyEnabled: String(qaAutoReplyEnabled),
      };
      for (const f of FIELDS) payload[f.key] = values[f.key] ?? "";
      await api("/admin/settings", { method: "PUT", body: payload });
      original.current = { values, aiEnabled, stuckAlertEnabled, qaAutoReplyEnabled };
      toast("Настройки сохранены");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Ошибка");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <h2>{Icons.settings} Настройки</h2>
      <p className="hint">Ключи и промт ИИ. Секретные поля показываются как ••• — ввод нового значения заменит старое.</p>
      {err && <div className="msg err">{err}</div>}
      {/* Первым делом — хранилище видео: без него платформа курсов не работает
          вовсе, а четыре отдельных поля ниже владелец уже пробовал и застрял.
          Поля ниже после вставки заполнятся масками — панель их перечитает
          при следующем открытии, специально дёргать нечего. */}
      <StoragePaste />
      <TelegramWebhook />
      {FIELDS.map((f) => (
        <label className="field" key={f.key}>
          <span>{f.label}{f.hint ? ` — ${f.hint}` : ""}</span>
          {f.kind === "radio" ? (
            <div className="radio-group" role="radiogroup" aria-label={f.label}>
              {(f.options ?? []).map((o) => (
                <label key={o.value} className="toggle">
                  <input
                    type="radio"
                    name={f.key}
                    value={o.value}
                    checked={(values[f.key] || (f.options?.[0]?.value ?? "")) === o.value}
                    onChange={() => setValue(f.key, o.value)}
                  />
                  {o.label}
                </label>
              ))}
            </div>
          ) : f.kind === "date" ? (
            <input type="date" value={values[f.key] ?? ""} onChange={(e) => setValue(f.key, e.target.value)} />
          ) : f.textarea ? (
            <textarea value={values[f.key] ?? ""} onChange={(e) => setValue(f.key, e.target.value)} />
          ) : (
            <input type="text" value={values[f.key] ?? ""} onChange={(e) => setValue(f.key, e.target.value)} />
          )}
          {f.checkable && (
            <div className="row" style={{ gap: 8, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn ghost"
                disabled={checking === f.key}
                onClick={() => checkModel(f.key)}
              >
                {checking === f.key ? "Спрашиваю Google…" : "Проверить"}
              </button>
              {checks[f.key] && (
                <span className={`check-note ${checks[f.key]!.ok ? "ok" : "err"}`}>
                  {checks[f.key]!.ok
                    ? `Модель отвечает · ${checks[f.key]!.ms} мс`
                    : `${checks[f.key]!.status ?? "нет связи"} · ${checks[f.key]!.detail}`}
                </span>
              )}
            </div>
          )}
        </label>
      ))}
      <div className="row" style={{ marginBottom: 14 }}>
        <label className="toggle">
          <input type="checkbox" checked={aiEnabled} onChange={(e) => setAiEnabled(e.target.checked)} />
          ИИ-консультант отвечает на свободные вопросы
        </label>
      </div>
      <div className="row" style={{ marginBottom: 14 }}>
        <label className="toggle">
          <input
            type="checkbox"
            checked={stuckAlertEnabled}
            onChange={(e) => setStuckAlertEnabled(e.target.checked)}
          />
          Живая тревога «застрял разговор» в Telegram (те же случаи всё равно видны в вечерней сводке)
        </label>
      </div>
      <div className="row" style={{ marginBottom: 14 }}>
        <label className="toggle">
          <input
            type="checkbox"
            checked={qaAutoReplyEnabled}
            onChange={(e) => setQaAutoReplyEnabled(e.target.checked)}
          />
          Автоответ в учебной группе — бот повторяет её же прошлый ответ на близко совпавший повторный вопрос
          (новый вопрос без совпадения — молчит, отвечает Ширин как обычно; нужны обе настройки группы выше)
        </label>
      </div>
      <button className="btn" onClick={save} disabled={saving}>
        {saving ? "Сохраняю…" : "Сохранить"}
      </button>
    </div>
  );
}
