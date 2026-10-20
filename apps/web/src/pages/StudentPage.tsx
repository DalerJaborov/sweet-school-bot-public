import { useCallback, useEffect, useState } from "react";
import { api, type Student, type StudentCourse, type StudentDevice } from "../api";
import { Icons } from "../components/Brand";
import { confirmDialog } from "../components/ConfirmDialog";
import { EmptyState, OfflineState } from "../components/EmptyState";
import { Illustration } from "../components/Illustration";
import { Skeleton } from "../components/Skeleton";
import { toast } from "../components/Toast";
import { money, plural, timeAgo } from "../format";

/**
 * КАРТОЧКА УЧЕНИЦЫ («Утро Ширин» §7) — заменяет переписку с Далером «у неё
 * не открывается»: прогресс-кольцо по каждому курсу, уроки с отметкой «где
 * остановилась», устройства человеческими словами («Chrome на Android ·
 * Душанбе · вчера») и три действия — новая ссылка, разблокировать устройство,
 * написать.
 *
 * Данные — один запрос GET /admin/metrics/student/:id (apps/api/src/metrics.ts).
 * Ссылка выпускается POST .../link тем же issueCourseLink, что и команда
 * /ссылка в Telegram; устройства — существующим POST /admin/course-devices/:id.
 */
const CHANNEL_LABEL: Record<string, string> = {
  INSTAGRAM: "Instagram",
  MESSENGER: "Messenger",
  WEB: "сайт",
  MANUAL: "вручную",
};

export function StudentPage({ contactId, onBack }: { contactId: string; onBack: () => void }) {
  const [s, setS] = useState<Student | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    setErr(null);
    api<Student>(`/admin/metrics/student/${contactId}`)
      .then((d) => !cancelled && setS(d))
      .catch((e) => !cancelled && setErr((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [contactId]);

  useEffect(() => load(), [load]);

  async function newLink() {
    if (!s) return;
    const ok = await confirmDialog({
      title: `Выдать новую ссылку ${s.contact.handle}?`,
      message: "Прошлая ссылка с этой минуты перестанет работать — если она у кого-то чужого, это и нужно.",
      confirmLabel: "Выдать",
    });
    if (!ok) return;
    setBusy("link");
    try {
      const r = await api<{ url: string }>(`/admin/metrics/student/${contactId}/link`, { method: "POST" });
      setLink(r.url);
      try {
        await navigator.clipboard?.writeText(r.url);
        toast("Новая ссылка скопирована — перешлите её ученице");
      } catch {
        toast("Ссылка готова — скопируйте её ниже");
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : "Не удалось выдать ссылку", "error");
    } finally {
      setBusy(null);
    }
  }

  async function toggleDevice(d: StudentDevice) {
    setBusy(d.id);
    try {
      await api(`/admin/course-devices/${d.id}`, {
        method: "POST",
        body: d.blocked ? { blocked: false } : { blocked: true, reason: "Заблокировано владельцем" },
      });
      toast(d.blocked ? `${d.label} разблокировано` : `${d.label} заблокировано`);
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Не удалось изменить устройство", "error");
    } finally {
      setBusy(null);
    }
  }

  async function copyHandle() {
    if (!s) return;
    try {
      await navigator.clipboard?.writeText(s.contact.handle);
      toast(`${s.contact.handle} скопирован — найдите её в переписке`);
    } catch {
      toast("Не удалось скопировать", "error");
    }
  }

  if (err && !s) {
    return (
      <div className="card">
        <BackRow onBack={onBack} />
        <OfflineState error={err} onRetry={() => void load()} />
      </div>
    );
  }
  if (!s) {
    return (
      <div className="card">
        <BackRow onBack={onBack} />
        <Skeleton height={64} radius={16} />
        <Skeleton height={44} className="skeleton-text" />
        <Skeleton height={140} />
      </div>
    );
  }

  const c = s.contact;
  const title = c.studentName ?? c.name ?? c.handle;
  const write = c.instagramUrl
    ? { href: c.instagramUrl, label: "Написать в Instagram" }
    : c.whatsappUrl
      ? { href: c.whatsappUrl, label: "Написать в WhatsApp" }
      : null;
  const activeCourses = s.courses.filter((k) => !k.revoked).length;

  return (
    <>
      <section className="card">
        <BackRow onBack={onBack} />
        <div className="student-head">
          <span className="icon-circle pink">{Icons.clients}</span>
          <div style={{ minWidth: 0 }}>
            <div className="student-title">{title}</div>
            <div className="student-sub">
              {title !== c.handle && `${c.handle} · `}
              {CHANNEL_LABEL[c.channel] ?? c.channel}
              {c.paidAt && ` · оплатила ${timeAgo(c.paidAt)}`}
            </div>
          </div>
        </div>
        <div className="list-chips">
          {c.accessRevokedAt && <span className="chip chip-err">доступ отобран</span>}
          {c.personal && <span className="chip">личный контакт</span>}
          {s.unansweredQuestions > 0 && (
            <span className="chip chip-warn">
              {s.unansweredQuestions} {plural(s.unansweredQuestions, "вопрос без ответа", "вопроса без ответа", "вопросов без ответа")}
            </span>
          )}
          {c.accessIssuedAt && <span className="chip">ссылка выдана {timeAgo(c.accessIssuedAt)}</span>}
        </div>

        <div className="student-actions">
          <button type="button" className="btn" disabled={busy === "link" || activeCourses === 0 || Boolean(c.accessRevokedAt)} onClick={() => void newLink()}>
            {busy === "link" ? "Выдаю…" : "Новая ссылка"}
          </button>
          {write ? (
            <a className="btn ghost" href={write.href} target="_blank" rel="noreferrer">
              {write.label}
            </a>
          ) : (
            <button type="button" className="btn ghost" onClick={() => void copyHandle()}>
              Скопировать ник
            </button>
          )}
        </div>
        {link && (
          <div className="link-box" data-testid="new-link">
            Новая ссылка: <code>{link}</code>
          </div>
        )}
      </section>

      <section className="card">
        <h2>{Icons.media} Курсы</h2>
        {s.courses.length === 0 ? (
          <EmptyState scene="QuietMorning" title="Курсов пока нет" hint="Оплаты ещё не было — после подтверждения чека курс появится здесь." size={96} />
        ) : (
          s.courses.map((k) => <CourseBlock key={k.purchaseId} course={k} />)
        )}
      </section>

      <section className="card">
        <h2>{Icons.settings} Устройства</h2>
        {s.devices.length === 0 ? (
          <p className="hint" style={{ margin: 0 }}>Ещё ни разу не открывала уроки — устройств нет.</p>
        ) : (
          <div className="list">
            {s.devices.map((d) => (
              <div className="list-row" key={d.id}>
                <div className="list-main">
                  <div className="list-title">{d.label}</div>
                  <div className="list-sub">
                    {[d.city, timeAgo(d.lastSeenAt)].filter(Boolean).join(" · ")}
                    {d.blocked && d.blockedReason && ` · ${d.blockedReason}`}
                  </div>
                  <div className="list-chips">{d.blocked && <span className="chip chip-err">заблокировано</span>}</div>
                </div>
                <div className="list-actions">
                  <button type="button" className={`btn small ${d.blocked ? "" : "quiet"}`} disabled={busy === d.id} onClick={() => void toggleDevice(d)}>
                    {d.blocked ? "Разблокировать" : "Заблокировать"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function BackRow({ onBack }: { onBack: () => void }) {
  return (
    <button type="button" className="btn quiet small" onClick={onBack} style={{ marginBottom: 10 }}>
      ← Ученицы
    </button>
  );
}

function CourseBlock({ course: k }: { course: StudentCourse }) {
  const status = k.revoked
    ? "доступ отобран"
    : k.certificate
      ? `сертификат №${k.certificate.number} · ${timeAgo(k.certificate.issuedAt)}`
      : k.finishedAt
        ? `прошла курс ${timeAgo(k.finishedAt)}`
        : k.firstOpenedAt
          ? `${k.lessonsDone} из ${k.lessonsTotal} ${plural(k.lessonsTotal, "урока", "уроков", "уроков")} · открыла ${timeAgo(k.firstOpenedAt)}`
          : "ещё не открывала";
  return (
    <div className="student-course" data-testid={`course-${k.code}`}>
      <div className="student-course-head">
        <Ring percent={k.percent} done={k.lessonsTotal > 0 && k.lessonsDone === k.lessonsTotal} label={`${k.title}: ${k.percent}%`} />
        <div style={{ minWidth: 0 }}>
          <div className="student-course-title">
            {k.title}
            {k.certificate && (
              <span className="student-cert" title="Сертификат выдан">
                <Illustration scene="FirstCertificate" size={28} />
              </span>
            )}
          </div>
          <div className="list-sub">
            {status} · {money(k.amount)} · {CHANNEL_LABEL[k.channel]}
          </div>
        </div>
      </div>
      {k.lessons.length > 0 && (
        <ul className="lesson-rows">
          {k.lessons.map((l) => {
            const part = !l.done && l.percent > 0;
            return (
              <li key={l.id} className={`lesson-row ${l.ready ? "" : "not-ready"}`}>
                <span className={`lesson-mark ${l.done ? "done" : part ? "part" : ""}`} aria-hidden="true">
                  {l.done ? "✓" : l.order}
                </span>
                <span className="lesson-row-title">{l.title}</span>
                <span className="lesson-row-note">
                  {!l.ready ? "видео готовится" : l.done ? "пройден" : part ? `остановилась на ${l.percent}%` : "не начат"}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Кольцо прогресса — своё, а не из приложения ученицы: там оно 28px и без
 *  цифры внутри, здесь — 56px и с процентом, чтобы читалось на телефоне. */
function Ring({ percent, done, label }: { percent: number; done: boolean; label: string }) {
  const size = 56;
  const stroke = 5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const value = Math.max(0, Math.min(100, percent));
  return (
    <svg className={`sring ${done ? "sring-done" : ""}`} width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label}>
      <circle className="sring-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" />
      <circle
        className="sring-value"
        cx={size / 2}
        cy={size / 2}
        r={r}
        strokeWidth={stroke}
        fill="none"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - value / 100)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text className="sring-text" x="50%" y="50%" dominantBaseline="central" textAnchor="middle">
        {value}%
      </text>
    </svg>
  );
}
