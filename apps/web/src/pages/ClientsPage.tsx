import { useEffect, useState } from "react";
import { api } from "../api";
import { Icons } from "../components/Brand";
import { confirmDialog } from "../components/ConfirmDialog";
import { EmptyState, OfflineState } from "../components/EmptyState";
import { SkeletonList } from "../components/Skeleton";
import { toast } from "../components/Toast";
import { plural, shortWho, timeAgo } from "../format";
import { usePaged } from "../hooks/usePaged";
import { ManualEnrollment } from "../components/ManualEnrollment";

/**
 * КЛИЕНТЫ — список людей, а не таблица данных.
 *
 * Прошлый вариант был таблицей в шесть колонок, и на телефоне (да и на ноутбуке)
 * длинное название воронки рвалось по одному слову в столбик, раздувая строку на
 * пол-экрана. Здесь у каждого человека одна строка: кто, что с ним происходит
 * (короткими метками) и действия. Всё длинное обрезается многоточием, а не
 * ломает вёрстку.
 *
 * СПИСОК ПОДГРУЖАЕТСЯ СТРАНИЦАМИ (usePaged) — школа растёт, и грузить разом всех
 * клиентов разом с каждым открытием вкладки со временем станет заметно дольше.
 * Поиск идёт на сервере (по нику/имени/ID); фильтры по статусу — на клиенте,
 * внутри уже загруженных страниц.
 */

type Client = {
  id: string;
  igUserId: string;
  username?: string | null;
  name?: string | null;
  channel?: string | null;
  paid: boolean;
  paidAt?: string | null;
  personal: boolean;
  spamBlockedAt?: string | null;
  spamReason?: string | null;
  tags: string[];
  messages: number;
  updatedAt: string;
  lastFunnel?: string | null;
  lastState?: string | null;
  lastStep?: number | null;
  joinedGroupAt?: string | null;
  inGroup?: boolean;
  accessRevokedAt?: string | null;
};

const clientWho = (c: Client) => c.channel === "MANUAL" ? c.name || c.igUserId : shortWho(c.username, c.igUserId);

const STATE_LABEL: Record<string, string> = {
  ACTIVE: "воронка идёт",
  WAITING: "ждёт кнопку",
  DONE: "прошёл воронку",
  FAILED: "сбой воронки",
};

type Filter = "all" | "paid" | "waiting" | "personal" | "spam";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "Все" },
  { id: "paid", label: "Оплатили" },
  { id: "waiting", label: "Не вошли" },
  { id: "personal", label: "Личные" },
  { id: "spam", label: "Спам" },
];

export function ClientsPage({ onOpenStudent }: { onOpenStudent?: (contactId: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  // Не бьём сервер на каждую букву — короткая пауза после того, как человек
  // перестал печатать.
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  const query = debounced ? `q=${encodeURIComponent(debounced)}` : "";
  const { rows, hasMore, loadingMore, err, loadMore, reload } = usePaged<Client>("/admin/contacts", query);

  async function togglePersonal(c: Client) {
    setBusy(c.id);
    try {
      await api(`/admin/contacts/${c.id}/personal`, { method: "POST", body: { personal: !c.personal } });
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Не удалось изменить", "error");
    } finally {
      setBusy(null);
    }
  }

  async function toggleSpam(c: Client) {
    setBusy(c.id);
    try {
      await api(`/admin/contacts/${c.id}/spam`, { method: "POST", body: { blocked: !c.spamBlockedAt } });
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Не удалось изменить", "error");
    } finally {
      setBusy(null);
    }
  }

  async function revoke(c: Client) {
    const who = clientWho(c);
    const ok = await confirmDialog({
      title: `Отобрать доступ у ${who}?`,
      message: "Его выгонит из групп курса, отметка об оплате снимется.",
      confirmLabel: "Отобрать",
      danger: true,
    });
    if (!ok) return;
    setBusy(c.id);
    try {
      await api(`/admin/contacts/${c.id}/revoke`, { method: "POST", body: { reason: "фальшивый чек" } });
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Не удалось отобрать доступ", "error");
    } finally {
      setBusy(null);
    }
  }

  async function restore(c: Client) {
    const who = clientWho(c);
    const ok = await confirmDialog({
      title: `Вернуть доступ ${who}?`,
      message: "Ему уйдёт новая ссылка на купленные курсы.",
      confirmLabel: "Вернуть доступ",
    });
    if (!ok) return;
    setBusy(c.id);
    try {
      await api(`/admin/contacts/${c.id}/restore`, { method: "POST" });
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Не удалось вернуть доступ", "error");
    } finally {
      setBusy(null);
    }
  }

  const visible = (rows ?? []).filter((c) => {
    if (filter === "paid") return c.paid;
    if (filter === "waiting") return c.paid && !c.joinedGroupAt && !c.accessRevokedAt;
    if (filter === "personal") return c.personal;
    if (filter === "spam") return Boolean(c.spamBlockedAt);
    return true;
  });

  return (
    <div className="card">
      <h2>{Icons.clients} Ученицы</h2>
      <p className="hint">Кто писал и на каком она шаге. «Личный» — бот с этим человеком молчит навсегда.</p>
      <ManualEnrollment onSaved={reload} onOpenStudent={onOpenStudent} />

      <label className="field" style={{ marginBottom: 10 }}>
        {/* Плейсхолдер — не замена подписи для программ чтения с экрана (он
            исчезает при вводе, и не все читалки его вообще озвучивают),
            поэтому имя поля задано явно через aria-label. */}
        <input
          type="search"
          aria-label="Поиск клиента по имени, нику или ID"
          placeholder="Поиск по имени, нику или ID…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>

      <div className="seg" style={{ marginBottom: 14 }}>
        {FILTERS.map((f) => (
          <button key={f.id} className={filter === f.id ? "active" : ""} onClick={() => setFilter(f.id)}>
            {f.label}
          </button>
        ))}
      </div>

      {err && !rows && <OfflineState error={err} onRetry={reload} />}
      {err && rows && <div className="msg err">{err}</div>}
      {!rows && !err && <SkeletonList rows={4} height={72} />}

      {rows && visible.length === 0 && (
        <EmptyState
          scene={debounced ? "QuietMorning" : "AllDone"}
          title={debounced ? "Никого не нашлось" : filter === "all" ? "Пока никто не писал" : "В этом списке пусто"}
          hint={debounced ? "Попробуйте ник латиницей или часть имени." : filter === "all" ? "Первая, кто напишет в Instagram или на сайте, появится здесь." : "Смените фильтр — люди есть в других списках."}
        />
      )}

      <div className="list">
        {visible.map((c) => (
          <div className="list-row" key={c.id}>
            <div className="list-main">
              <div className="list-title">
                {/* Тап по нику — карточка ученицы: прогресс, устройства, новая
                    ссылка (StudentPage). Кнопка, а не div: нужна с клавиатуры. */}
                {onOpenStudent ? (
                  <button type="button" className="linklike" onClick={() => onOpenStudent(c.id)} aria-label={`Открыть карточку ${clientWho(c)}`}>
                    {clientWho(c)}
                  </button>
                ) : (
                  clientWho(c)
                )}
              </div>
              <div className="list-sub">
                {c.messages} {plural(c.messages, "сообщение", "сообщения", "сообщений")} · {timeAgo(c.updatedAt)}
                {c.lastState && ` · ${STATE_LABEL[c.lastState] ?? c.lastState}`}
              </div>
              <div className="list-chips">
                {c.personal && <span className="chip">личный</span>}
                {c.spamBlockedAt && <span className="chip chip-err" title={c.spamReason ?? ""}>спам · бот молчит</span>}
                {c.accessRevokedAt && <span className="chip chip-err">доступ отобран</span>}
                {c.paid && !c.accessRevokedAt && <span className="chip chip-ok">оплатил</span>}
                {c.channel === "MANUAL" && c.paid && !c.accessRevokedAt && <span className="chip">платформа курсов</span>}
                {c.channel !== "MANUAL" && c.paid && !c.joinedGroupAt && !c.accessRevokedAt && <span className="chip chip-warn">не вошёл в группу</span>}
                {c.joinedGroupAt && <span className="chip chip-ok">в группе</span>}
              </div>
            </div>
            <div className="list-actions">
              <button className="btn quiet small" disabled={busy === c.id} onClick={() => togglePersonal(c)}>
                {c.personal ? "Вернуть бота" : "Личный"}
              </button>
              <button className="btn quiet small" disabled={busy === c.id} onClick={() => toggleSpam(c)}>
                {c.spamBlockedAt ? "Снять блок" : "Спам"}
              </button>
              {onOpenStudent && c.paid && (
                <button className="btn ghost small" onClick={() => onOpenStudent(c.id)}>
                  Карточка
                </button>
              )}
              {c.accessRevokedAt ? (
                <button className="btn quiet small" disabled={busy === c.id} onClick={() => restore(c)}>
                  Вернуть доступ
                </button>
              ) : (
                c.paid && (
                  <button className="btn danger small" disabled={busy === c.id} onClick={() => revoke(c)}>
                    Отобрать
                  </button>
                )
              )}
            </div>
          </div>
        ))}
      </div>

      {hasMore && (
        <button className="btn ghost wide" style={{ marginTop: 10 }} disabled={loadingMore} onClick={loadMore}>
          {loadingMore ? "Загружаю…" : "Показать ещё"}
        </button>
      )}
    </div>
  );
}
