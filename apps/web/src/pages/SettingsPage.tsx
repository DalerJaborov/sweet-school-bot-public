import { useEffect, useRef, useState } from "react";
import { FreeLessonSettings } from "../components/FreeLessonSettings";
import { WhatsAppSettings } from "../components/WhatsAppSettings";
import { KnowledgeReview } from "../components/KnowledgeReview";

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
import { Switch } from "../components/Switch";
import { confirmDialog } from "../components/ConfirmDialog";
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

type ToggleKey = "aiEnabled" | "stuckAlertEnabled" | "qaAutoReplyEnabled" | "botFrozen";

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
  { key: "appSecret", label: "Секрет приложения Meta", secret: true, hint: "Нужен для проверки подлинности вебхуков. Возьмите App Secret из настроек подключённого приложения Meta" },
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
  { key: "telegramChatId50", label: "ID группы — «Арт-десерты»", hint: "Например -1001234567890" },
  { key: "telegramChatId70", label: "ID группы — «21 рецепт»", hint: "Например -1009876543210" },
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
  // Офлайн-курс (дата набора, часы, цена) — раздел «Цены и даты»; свой текст карточки — «Тексты».
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

  /** Тумблеры, которые сейчас сохраняются: повторное нажатие на тот же игнорируем. */
  const inFlight = useRef(new Set<string>());

  /**
   * Тумблер меняется сразу; если сервер не принял — возвращаем и говорим об
   * этом. Включение ответов клиентам — только после подтверждения: после него
   * помощник начинает писать настоящим людям.
   */
  async function flip(key: "aiEnabled" | "stuckAlertEnabled" | "qaAutoReplyEnabled", next: boolean, set: (v: boolean) => void) {
    if (inFlight.current.has(key)) return;
    if (key === "aiEnabled" && next) {
      const ok = await confirmDialog({
        title: "Включить ответы клиентам?",
        message: "Помощник начнёт сам отвечать людям в Instagram и на сайте. Выключить можно этим же тумблером.",
        confirmLabel: "Включить",
      });
      if (!ok) return;
    }
    inFlight.current.add(key);
    set(next);
    try {
      await api("/admin/settings", { method: "PUT", body: { [key]: String(next) } });
      if (original.current) original.current[key] = next;
    } catch (e) {
      set(!next);
      toast(e instanceof Error ? e.message : "Не удалось сохранить", "error");
    } finally {
      inFlight.current.delete(key);
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
      <FreeLessonSettings />
      <WhatsAppSettings />
      <KnowledgeReview />
      <p className="hint">Подключения и подсказки для помощника. Секретные поля показываются как ••• — ввод нового значения заменит старое.</p>
      {err && <div className="msg err">{err}</div>}
      {values.botFrozen === "true" && (
        <div className="msg" role="status">
          <strong>Бот работает только по воронкам.</strong> Свободные ответы, проверка чеков,
          автоматическая выдача доступа и напоминания покупателям отключены. Покупки
          обрабатываются вручную в WhatsApp. Оплаченные уроки доступны ученицам.
        </div>
      )}
      {original.current && !values.appSecret && (
        <p className="msg err">Секрет Meta не задан: подлинность входящих вебхуков не проверяется. Нужен App Secret подключённого приложения.</p>
      )}
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
      {/* Тумблеры сохраняются сразу, одним касанием: раньше человек щёлкал,
          забывал нажать «Сохранить» внизу — и помощник работал по-старому. */}
      <div className="switch-group">
        <Switch
          checked={aiEnabled}
          disabled={values.botFrozen === "true"}
          onChange={(next) => void flip("aiEnabled", next, setAiEnabled)}
          label="Помощник отвечает на вопросы клиентов"
          hint="Выключите, если хотите отвечать всем сами."
          testId="switch-aiEnabled"
        />
        <Switch
          checked={stuckAlertEnabled}
          onChange={(next) => void flip("stuckAlertEnabled", next, setStuckAlertEnabled)}
          label="Сообщать в Telegram, если разговор зашёл в тупик"
          hint="Те же случаи всё равно будут в вечерней сводке."
          testId="switch-stuckAlertEnabled"
        />
        <Switch
          checked={qaAutoReplyEnabled}
          disabled={values.botFrozen === "true"}
          onChange={(next) => void flip("qaAutoReplyEnabled", next, setQaAutoReplyEnabled)}
          label="Повторять ваш прошлый ответ в учебной группе"
          hint="Если вопрос почти такой же, как был раньше. На новые вопросы помощник молчит — отвечаете вы."
          testId="switch-qaAutoReplyEnabled"
        />
      </div>
      <button className="btn" onClick={save} disabled={saving}>
        {saving ? "Сохраняю…" : "Сохранить"}
      </button>
    </div>
  );
}
