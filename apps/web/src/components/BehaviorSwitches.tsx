import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Switch } from "./Switch";
import { toast } from "./Toast";

/**
 * ПОВЕДЕНИЕ ПОМОЩНИКА — рубильники простыми словами («Ещё → Для опытных»).
 * Каждый тумблер = одна настройка на сервере, по умолчанию всё включено
 * (значение «false» выключает). Меняются без пересборки и перезапуска.
 */
const SWITCHES: { key: string; label: string; hint: string }[] = [
  {
    key: "smartTakeoverEnabled",
    label: "Бот возвращается после ручного ответа Ширин",
    hint: "Пока Ширин пишет сама (25 минут), бот молчит. Не ответила за 12 минут или прошли сутки: бот отвечает сам. Выключите, чтобы бот молчал, пока вы его не вернёте.",
  },
  {
    key: "replyGateEnabled",
    label: "Не отвечать, если пишут не про курсы",
    hint: "Курьерам, знакомым, магазинам помощник молчит. Выключите, если он молчит зря: тогда ответит всем.",
  },
  {
    key: "reactionsEnabled",
    label: "Сердечко вместо ответа на «спасибо»",
    hint: "Помощник ставит реакцию, а не пишет ещё одно сообщение.",
  },
  {
    key: "readReceiptsEnabled",
    label: "Отмечать «прочитано»",
    hint: "Перед ответом человек видит, что сообщение прочитано.",
  },
  {
    key: "warmEmojiEnabled",
    label: "Редкие смайлики в ответах",
    hint: "Иногда ❤️ или 🌸 в конце, как у Ширин.",
  },
  {
    key: "replySplitInstagram",
    label: "Делить длинный ответ на части: Instagram",
    hint: "Несколько коротких сообщений вместо одного длинного. Номер оплаты — отдельным.",
  },
  {
    key: "replySplitWhatsapp",
    label: "Делить длинный ответ на части: WhatsApp",
    hint: "То же для WhatsApp (не больше двух сообщений, чтобы не упереться в защиту от блокировки).",
  },
  {
    key: "replySplitWeb",
    label: "Делить длинный ответ на части: чат на сайте",
    hint: "То же для чата на сайте.",
  },
];

export function BehaviorSwitches() {
  const [values, setValues] = useState<Record<string, boolean> | null>(null);
  const busy = useRef(new Set<string>());

  useEffect(() => {
    api<Record<string, string | null>>("/admin/settings")
      .then((s) => setValues(Object.fromEntries(SWITCHES.map((x) => [x.key, s[x.key] !== "false"]))))
      .catch(() => setValues(null));
  }, []);

  if (!values) return null;

  async function flip(key: string, next: boolean) {
    if (busy.current.has(key)) return;
    busy.current.add(key);
    setValues((prev) => ({ ...(prev ?? {}), [key]: next }));
    try {
      await api("/admin/settings", { method: "PUT", body: { [key]: String(next) } });
    } catch (e) {
      setValues((prev) => ({ ...(prev ?? {}), [key]: !next }));
      toast(e instanceof Error ? e.message : "Не удалось сохранить", "error");
    } finally {
      busy.current.delete(key);
    }
  }

  return (
    <div className="behavior-switches" data-testid="behavior-switches">
      <h4 className="more-title">Поведение помощника</h4>
      {SWITCHES.map((s) => (
        <Switch
          key={s.key}
          checked={values[s.key] !== false}
          onChange={(next) => void flip(s.key, next)}
          label={s.label}
          hint={s.hint}
          testId={`switch-${s.key}`}
        />
      ))}
    </div>
  );
}
