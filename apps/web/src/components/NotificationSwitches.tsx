import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Switch } from "./Switch";
import { toast } from "./Toast";

/**
 * УВЕДОМЛЕНИЯ В TELEGRAM — ТУМБЛЕРЫ ПО ВИДАМ (11.11.2026).
 *
 * Два столбца смысла: «Мне» (владелец) и «Ширин». Ширин приходит только
 * «главное» (оплата, офлайн, итог дня): строки со служебными видами для неё
 * не показываем. Те же настройки меняются в Telegram: кнопка «🔕 Не присылать
 * такое» под сообщением или слова «не присылай мне оплаты».
 * Сервер: apps/api/src/controlRoutes.ts (GET/PUT /admin/v1/notifications).
 */
type Kind = { id: string; label: string; hint: string; audience: "main" | "owner"; owner: boolean; shirin: boolean | null };
type Data = { shirinEnabled: boolean; kinds: Kind[] };

export function NotificationSwitches() {
  const [data, setData] = useState<Data | null>(null);
  const busy = useRef(new Set<string>());

  useEffect(() => {
    api<Data>("/admin/v1/notifications").then(setData).catch(() => setData(null));
  }, []);
  if (!data) return null;

  async function put(key: string, body: Record<string, unknown>, optimistic: (d: Data) => Data) {
    if (busy.current.has(key)) return;
    busy.current.add(key);
    const before = data;
    setData((d) => (d ? optimistic(d) : d));
    try {
      setData(await api<Data>("/admin/v1/notifications", { method: "PUT", body }));
    } catch (e) {
      setData(before);
      toast(e instanceof Error ? e.message : "Не удалось сохранить", "error");
    } finally {
      busy.current.delete(key);
    }
  }

  return (
    <div className="behavior-switches" data-testid="notification-switches">
      <h4 className="more-title">Мне в Telegram</h4>
      {data.kinds.map((k) => (
        <Switch
          key={`o:${k.id}`}
          checked={k.owner}
          onChange={(next) =>
            void put(`o:${k.id}`, { role: "owner", kind: k.id, enabled: next }, (d) => ({
              ...d,
              kinds: d.kinds.map((x) => (x.id === k.id ? { ...x, owner: next } : x)),
            }))
          }
          label={k.label}
          hint={k.hint}
          testId={`switch-notify-owner-${k.id}`}
        />
      ))}
      <h4 className="more-title">Ширин в Telegram</h4>
      <Switch
        checked={data.shirinEnabled}
        onChange={(next) => void put("sh", { shirinEnabled: next }, (d) => ({ ...d, shirinEnabled: next }))}
        label="Присылать Ширин главное"
        hint="Оплаты, записи на офлайн и итог дня. Служебное ей не приходит никогда."
        testId="switch-notify-shirin"
      />
      {data.shirinEnabled &&
        data.kinds
          .filter((k) => k.shirin !== null)
          .map((k) => (
            <Switch
              key={`s:${k.id}`}
              checked={k.shirin === true}
              onChange={(next) =>
                void put(`s:${k.id}`, { role: "shirin", kind: k.id, enabled: next }, (d) => ({
                  ...d,
                  kinds: d.kinds.map((x) => (x.id === k.id ? { ...x, shirin: next } : x)),
                }))
              }
              label={`Ширин: ${k.label}`}
              testId={`switch-notify-shirin-${k.id}`}
            />
          ))}
    </div>
  );
}
