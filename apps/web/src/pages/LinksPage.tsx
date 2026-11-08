import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { api } from "../api";
import { confirmDialog } from "../components/ConfirmDialog";
import { OfflineState } from "../components/EmptyState";
import { SkeletonList } from "../components/Skeleton";
import { toast } from "../components/Toast";
import { plural, timeAgo } from "../format";
import "./LinksPage.css";

/**
 * «ССЫЛКИ» (08.11.2026) — хозяйка и сестра сами делают ссылки, без программиста:
 *  1) на сайт школы — для рекламы и блогеров; по каждой видно, сколько людей
 *     перешло, сколько обратились и сколько купили (API: links/siteLinks.ts);
 *  2) в Telegram-группу курса — ученица заходит сама; ссылка сгорает после
 *     нужного числа входов или срока, её можно отозвать (links/telegramInvites.ts).
 * Каждый блок — до трёх полей и одна кнопка «Создать ссылку».
 */

type Option = { key: string; label: string };
type Options = {
  targets: Option[];
  sources: (Option & { needsLabel: boolean })[];
  groups: (Option & { ready: boolean })[];
  presets: Option[];
  botReady: boolean;
};
type SiteLinkRow = {
  id: string;
  url: string;
  targetLabel: string;
  sourceLabel: string;
  label: string | null;
  lang: string;
  clicks: number;
  leads: number;
  buyers: number;
  createdAt: string;
};
type InviteRow = {
  id: string;
  groupLabel: string;
  link: string;
  name: string | null;
  memberLimit: number | null;
  joinedCount: number;
  expiresAt: string | null;
  createdAt: string;
  status: "active" | "used" | "expired" | "revoked";
  joins?: { id: string; name: string; joinedAt: string; removed: boolean }[];
};

const LIST_STEP = 10;

export function LinksPage() {
  const [options, setOptions] = useState<Options | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api<Options>("/admin/v1/links/options")
      .then(setOptions)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Не удалось загрузить"));
  }, []);
  useEffect(load, [load]);

  if (error && !options) return <OfflineState error={error} onRetry={load} />;
  if (!options) return <SkeletonList rows={2} height={260} />;

  return (
    <div className="links-page">
      <SiteLinkBlock options={options} />
      <TelegramBlock options={options} />
    </div>
  );
}

// ---------- общее: готовая ссылка ----------

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast("Ссылка скопирована");
  } catch {
    toast("Не получилось скопировать — выделите ссылку и скопируйте вручную", "error");
  }
}

function CreatedLink({ url, title }: { url: string; title: string }) {
  const [qr, setQr] = useState<string | null>(null);
  const [qrError, setQrError] = useState(false);

  useEffect(() => {
    setQr(null);
    setQrError(false);
  }, [url]);

  async function showQr() {
    try {
      // Библиотека грузится только по нажатию: остальной панели она не нужна.
      const QRCode = (await import("qrcode")).default;
      setQr(await QRCode.toDataURL(url, { width: 480, margin: 2, errorCorrectionLevel: "M" }));
    } catch {
      setQrError(true);
    }
  }

  return (
    <div className="links-result" role="status" aria-live="polite">
      <p className="links-result-title">{title}</p>
      <input
        className="links-url"
        readOnly
        value={url}
        aria-label="Готовая ссылка"
        onFocus={(e) => e.currentTarget.select()}
      />
      <div className="links-actions">
        <button type="button" className="btn" onClick={() => void copyText(url)}>
          Скопировать
        </button>
        {!qr && (
          <button type="button" className="btn ghost" onClick={() => void showQr()}>
            QR-код
          </button>
        )}
      </div>
      {qrError && <p className="msg err">Не получилось сделать QR-код. Ссылка при этом работает.</p>}
      {qr && (
        <figure className="links-qr">
          <img src={qr} alt={`QR-код ссылки ${url}`} width={200} height={200} />
          <a className="btn quiet small" href={qr} download="shirin-link-qr.png">
            Скачать QR-код
          </a>
        </figure>
      )}
    </div>
  );
}

function ShowMore({ shown, total, onMore }: { shown: number; total: number; onMore: () => void }) {
  if (shown >= total) return null;
  return (
    <button type="button" className="btn quiet wide links-more" onClick={onMore}>
      Показать ещё ({total - shown})
    </button>
  );
}

// ---------- ссылка на сайт ----------

function SiteLinkBlock({ options }: { options: Options }) {
  const ids = useId();
  const [target, setTarget] = useState(options.targets[0]?.key ?? "home");
  const [lang, setLang] = useState<"tg" | "ru">("tg");
  const [source, setSource] = useState(options.sources[0]?.key ?? "instagram");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [rows, setRows] = useState<SiteLinkRow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [shown, setShown] = useState(LIST_STEP);

  const needsLabel = options.sources.find((s) => s.key === source)?.needsLabel ?? false;
  const labelTitle = source === "blogger" ? "Имя блогера" : "Название рекламы";

  const loadRows = useCallback(() => {
    setListError(null);
    api<{ links: SiteLinkRow[] }>("/admin/v1/links/site")
      .then((d) => setRows(d.links))
      .catch((e: unknown) => setListError(e instanceof Error ? e.message : "Не удалось загрузить список"));
  }, []);
  useEffect(loadRows, [loadRows]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pending.current) return;
    if (needsLabel && label.trim().length < 2) {
      setError(`Впишите: ${labelTitle.toLowerCase()}.`);
      return;
    }
    pending.current = true;
    setBusy(true);
    setError(null);
    // Прошлая готовая ссылка не должна висеть рядом с новой ошибкой.
    setCreated(null);
    try {
      const d = await api<{ link: { url: string } }>("/admin/v1/links/site", {
        method: "POST",
        body: { target, lang, source, label: needsLabel ? label.trim() : null },
      });
      setCreated(d.link.url);
      loadRows();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не получилось создать ссылку");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="card links-block" aria-labelledby={`${ids}-h`}>
      <h2 id={`${ids}-h`}>Ссылка на сайт</h2>
      <p className="hint">Для рекламы и блогеров: потом видно, сколько людей пришло по каждой ссылке.</p>

      <form onSubmit={submit} noValidate>
        <label className="field">
          <span>Куда ведёт</span>
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            {options.targets.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <div className="seg links-lang" role="group" aria-label="Язык страницы">
          {(
            [
              ["tg", "Тоҷикӣ"],
              ["ru", "Русский"],
            ] as const
          ).map(([key, title]) => (
            <button
              key={key}
              type="button"
              className={lang === key ? "active" : ""}
              aria-pressed={lang === key}
              onClick={() => setLang(key)}
            >
              {title}
            </button>
          ))}
        </div>

        <fieldset className="links-sources">
          <legend>Откуда придут люди</legend>
          <div className="links-choices">
            {options.sources.map((s) => (
              <label key={s.key} className={`links-choice ${source === s.key ? "active" : ""}`}>
                <input
                  type="radio"
                  name={`${ids}-source`}
                  value={s.key}
                  checked={source === s.key}
                  onChange={() => setSource(s.key)}
                />
                {s.label}
              </label>
            ))}
          </div>
        </fieldset>

        {needsLabel && (
          <label className="field">
            <span>{labelTitle}</span>
            <input
              value={label}
              maxLength={60}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={source === "blogger" ? "Например, Мадина" : "Например, Ноябрь — сторис"}
              autoComplete="off"
              aria-describedby={`${ids}-label-note`}
            />
          </label>
        )}
        {needsLabel && (
          <p id={`${ids}-label-note`} className="links-note links-label-note">
            Это слово будет видно в адресе страницы — без фамилии и телефона.
          </p>
        )}

        {error && (
          <p className="msg err" role="alert">
            {error}
          </p>
        )}
        <button className="btn wide" type="submit" disabled={busy}>
          {busy ? "Создаю…" : "Создать ссылку"}
        </button>
      </form>

      {created && <CreatedLink url={created} title="Готово. Вставьте ссылку в рекламу или отправьте блогеру." />}

      <h3 className="links-list-title">Ваши ссылки</h3>
      {listError && !rows && <OfflineState error={listError} onRetry={loadRows} />}
      {!rows && !listError && <SkeletonList rows={2} height={56} />}
      {rows && rows.length === 0 && <p className="hint">Пока ни одной. Первая появится здесь сразу после создания.</p>}
      {rows && rows.length > 0 && (
        <ul className="list links-list">
          {rows.slice(0, shown).map((r) => (
            <li className="list-row" key={r.id}>
              <div className="list-main">
                <div className="list-title">
                  {r.sourceLabel}
                  {r.label ? `: ${r.label}` : ""} → {r.targetLabel}
                  {r.lang === "ru" ? " (рус.)" : ""}
                </div>
                <div className="list-sub">
                  {r.clicks} {plural(r.clicks, "переход", "перехода", "переходов")} · {r.leads}{" "}
                  {plural(r.leads, "обратился", "обратились", "обратились")} через чат или форму на сайте · {r.buyers}{" "}
                  {plural(r.buyers, "купил", "купили", "купили")} через чат на сайте
                </div>
              </div>
              <button
                type="button"
                className="btn quiet small"
                onClick={() => void copyText(r.url)}
                aria-label={`Скопировать ссылку ${r.url}`}
              >
                Копия
              </button>
            </li>
          ))}
        </ul>
      )}
      {rows && <ShowMore shown={shown} total={rows.length} onMore={() => setShown((n) => n + LIST_STEP)} />}
      {rows && rows.length > 0 && (
        <p className="hint links-footnote">
          Покупки через WhatsApp и Instagram сюда не попадают: там человек пишет без ссылки.
        </p>
      )}
    </section>
  );
}

// ---------- приглашение в Telegram ----------

const STATUS_TEXT: Record<InviteRow["status"], string> = {
  active: "Действует",
  used: "Все вошли — ссылка закрыта",
  expired: "Срок вышел",
  revoked: "Отозвана",
};

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

function TelegramBlock({ options }: { options: Options }) {
  const ids = useId();
  const readyGroups = options.groups.filter((g) => g.ready);
  const [group, setGroup] = useState(readyGroups[0]?.key ?? "");
  const [name, setName] = useState("");
  const [preset, setPreset] = useState(options.presets[0]?.key ?? "one");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [rows, setRows] = useState<InviteRow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [shown, setShown] = useState(LIST_STEP);

  const loadRows = useCallback(() => {
    setListError(null);
    api<{ invites: InviteRow[] }>("/admin/v1/links/telegram")
      .then((d) => setRows(d.invites))
      .catch((e: unknown) => setListError(e instanceof Error ? e.message : "Не удалось загрузить список"));
  }, []);
  useEffect(loadRows, [loadRows]);

  const blocked = !options.botReady
    ? "Бот Telegram не подключён. Откройте «Настройки» и вставьте токен бота."
    : readyGroups.length === 0
      ? "Не указаны ID групп. Откройте «Настройки» и впишите ID групп курсов."
      : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pending.current || blocked || !group) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    setCreated(null);
    try {
      const d = await api<{ invite: { link: string } }>("/admin/v1/links/telegram", {
        method: "POST",
        body: { group, preset, name: name.trim() || null },
      });
      setCreated(d.invite.link);
      setName("");
      loadRows();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не получилось создать ссылку");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  async function revoke(row: InviteRow) {
    const ok = await confirmDialog({
      title: "Отозвать ссылку?",
      message: "По ней больше никто не войдёт. Кто уже в группе — останется.",
      confirmLabel: "Отозвать",
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/admin/v1/links/telegram/${encodeURIComponent(row.id)}/revoke`, { method: "POST" });
      toast("Ссылка отозвана");
      if (created === row.link) setCreated(null);
      loadRows();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Не получилось отозвать", "error");
    }
  }

  async function removeJoiner(row: InviteRow, join: NonNullable<InviteRow["joins"]>[number]) {
    const ok = await confirmDialog({
      title: `Удалить ${join.name} из группы?`,
      message: "Человек выйдет из группы. Вернуться сможет только по новой ссылке.",
      confirmLabel: "Удалить",
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/admin/v1/links/telegram/${encodeURIComponent(row.id)}/joins/${encodeURIComponent(join.id)}/remove`, {
        method: "POST",
      });
      toast("Удалили из группы");
      loadRows();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Не получилось удалить", "error");
    }
  }

  return (
    <section className="card links-block" aria-labelledby={`${ids}-h`}>
      <h2 id={`${ids}-h`}>Ссылка в Telegram-группу</h2>
      <p className="hint">Ученица заходит в группу сама. Ссылка сгорает после нужного числа входов или срока.</p>

      {blocked && (
        <p className="msg warn" role="status">
          {blocked}
        </p>
      )}

      <form onSubmit={submit} noValidate>
        <label className="field">
          <span>Группа</span>
          <select value={group} onChange={(e) => setGroup(e.target.value)} disabled={Boolean(blocked)}>
            {readyGroups.map((g) => (
              <option key={g.key} value={g.key}>
                {g.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Для кого (необязательно)</span>
          <input
            value={name}
            maxLength={32}
            onChange={(e) => setName(e.target.value)}
            placeholder="Имя ученицы"
            autoComplete="off"
            disabled={Boolean(blocked)}
          />
        </label>
        <label className="field">
          <span>Сколько входов</span>
          <select value={preset} onChange={(e) => setPreset(e.target.value)} disabled={Boolean(blocked)}>
            {options.presets.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        {error && (
          <p className="msg err" role="alert">
            {error}
          </p>
        )}
        <button className="btn wide" type="submit" disabled={busy || Boolean(blocked)}>
          {busy ? "Создаю…" : "Создать ссылку"}
        </button>
      </form>

      {created && <CreatedLink url={created} title="Готово. Отправьте ссылку ученице в WhatsApp или Telegram." />}

      <h3 className="links-list-title">Выданные ссылки</h3>
      {listError && !rows && <OfflineState error={listError} onRetry={loadRows} />}
      {!rows && !listError && <SkeletonList rows={2} height={56} />}
      {rows && rows.length === 0 && <p className="hint">Пока ни одной.</p>}
      {rows && rows.length > 0 && (
        <ul className="list links-list">
          {rows.slice(0, shown).map((r) => (
            <li className="list-row" key={r.id}>
              <div className="list-main">
                <div className="list-title">
                  {r.name ?? "Без имени"} · {r.groupLabel}
                </div>
                <div className="list-sub">
                  <span className={`chip links-status ${r.status}`}>{STATUS_TEXT[r.status]}</span>
                  вошли {r.joinedCount}
                  {r.memberLimit != null ? ` из ${r.memberLimit}` : ""}
                  {r.status === "active" && r.expiresAt ? ` · до ${shortDate(r.expiresAt)}` : ""}
                  {r.status !== "active" ? ` · выдана ${timeAgo(r.createdAt)}` : ""}
                </div>
                {r.joins && r.joins.length > 0 && (
                  <ul className="links-joins" aria-label="Кто вошёл по ссылке">
                    {r.joins.map((j) => (
                      <li key={j.id}>
                        <span>{j.name}</span>
                        {j.removed ? (
                          <span className="links-note">удалили из группы</span>
                        ) : (
                          <button
                            type="button"
                            className="btn quiet small"
                            onClick={() => void removeJoiner(r, j)}
                            aria-label={`Удалить из группы: ${j.name}`}
                          >
                            Удалить из группы
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {r.status === "active" && (
                <div className="links-row-actions">
                  <button
                    type="button"
                    className="btn quiet small"
                    onClick={() => void copyText(r.link)}
                    aria-label={`Скопировать ссылку для: ${r.name ?? "без имени"}`}
                  >
                    Копия
                  </button>
                  <button
                    type="button"
                    className="btn danger small"
                    onClick={() => void revoke(r)}
                    aria-label={`Отозвать ссылку для: ${r.name ?? "без имени"}`}
                  >
                    Отозвать
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {rows && <ShowMore shown={shown} total={rows.length} onMore={() => setShown((n) => n + LIST_STEP)} />}
    </section>
  );
}
