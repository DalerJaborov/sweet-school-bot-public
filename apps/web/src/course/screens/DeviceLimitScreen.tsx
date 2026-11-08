import { useState } from "react";
import { ContactsBlock } from "../components/ContactsBlock";
import type { DeviceLimitState } from "../hooks/useCourse";
import { formatLastSeen, type Dict } from "../i18n";
import type { TransferStatus } from "../api";

/**
 * КУРС ОТКРЫТ НА ДРУГОМ ТЕЛЕФОНЕ (политика «один телефон», 08.11.2026).
 * Один телефон — любые его браузеры; на другом телефоне курс не открывается,
 * пока человек не перенесёт доступ: код подтверждения приходит в ЕГО чат с
 * ботом, после ввода старый телефон аннулируется. Не чаще раза в месяц —
 * повторный перенос решает владелец, ученица видит, что мы его спросили.
 */
export function DeviceLimitScreen({
  t,
  limit,
  onRequest,
  onConfirm,
}: {
  t: Dict;
  limit: DeviceLimitState;
  onRequest: () => Promise<TransferStatus | "error">;
  onConfirm: (code: string) => Promise<boolean>;
}) {
  const [stage, setStage] = useState<"idle" | "code" | "owner" | "failed">("idle");
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [bad, setBad] = useState(false);

  const request = async () => {
    setBusy(true);
    const status = await onRequest();
    setBusy(false);
    setBad(false);
    setStage(status === "sent" || status === "cooldown" ? "code" : status === "owner_asked" ? "owner" : "failed");
  };
  const confirm = async () => {
    setBusy(true);
    const ok = await onConfirm(code.trim());
    setBusy(false);
    setBad(!ok);
  };

  return (
    <div className="center devices-screen" role="alert">
      <h1>{t.deviceLimitTitle}</h1>
      <p>{t.deviceLimitText(limit.devices.length)}</p>
      <ul className="devices">
        {limit.devices.map((d) => {
          const seen = formatLastSeen(d.lastSeenAt, t);
          return (
            <li key={d.id} className="device">
              <span className="device-icon" aria-hidden="true">
                <DeviceGlyph label={d.label} />
              </span>
              <span className="device-body">
                <span className="device-title">
                  {t.deviceLabel(d.label)}
                  {d.city ? ` · ${d.city}` : ""}
                </span>
                <span className="device-sub">
                  {seen && t.deviceLastSeen(seen)}
                  {d.blocked && <span className="chip chip-danger">{t.deviceBlocked}</span>}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
      {(stage === "idle" || stage === "failed") && (
        <button type="button" className="btn btn-big" onClick={() => void request()} disabled={busy}>
          {t.transferButton}
        </button>
      )}
      {stage === "code" && (
        <>
          <p>{t.transferSent}</p>
          <label>
            <span className="muted">{t.transferCodeLabel}</span>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            />
          </label>
          {bad && <p role="alert">{t.transferBadCode}</p>}
          <button type="button" className="btn btn-big" onClick={() => void confirm()} disabled={busy || code.length !== 6}>
            {t.transferConfirm}
          </button>
        </>
      )}
      {stage === "owner" && <p>{t.transferOwnerAsked}</p>}
      {stage === "failed" && (
        <>
          <p>{t.transferSendFailed}</p>
          {limit.school && <ContactsBlock t={t} school={limit.school} />}
        </>
      )}
    </div>
  );
}

/** Телефон или монитор — по подписи сервера; неизвестное — телефон. */
function DeviceGlyph({ label }: { label: string }) {
  // Подписи сервера по-русски, сравнивать их тут нельзя (i18n-тест); телефон
  // узнаём по латинским «iPhone»/«Android», всё остальное рисуем монитором.
  const desktop = !/iphone|android|phone/i.test(label);
  const common = { width: 24, height: 24, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2 };
  if (desktop) {
    return (
      <svg {...common} aria-hidden="true" focusable="false">
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M8 20h8M12 16v4" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg {...common} aria-hidden="true" focusable="false">
      <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
      <path d="M11 18h2" strokeLinecap="round" />
    </svg>
  );
}
