import { useEffect, useState } from "react";
import { api, uploadLibraryFile } from "../api";
import { EmptyState } from "../components/Illustrations";
import { Icons } from "../components/Brand";
import { Lightbox } from "../components/Lightbox";
import { usePaged } from "../hooks/usePaged";

/**
 * ОДОБРЕНИЕ ГОЛОСОВЫХ/ФОТО/ВИДЕО ШИРИН НА ПОВТОР (24.08.2026).
 *
 * Бот сам копит её реальные ответы с вложением — из живого Instagram-директа
 * (StyleExample) и из учебной Telegram-группы (QaExample). Но переслать её
 * настоящий голос клиенту на похожий вопрос можно только из ОДОБРЕННОЙ ею
 * подборки — решение владельца: неверно подобранный файл выглядит страннее,
 * чем обычный текстовый ответ не в тему. Эта страница — единственное место,
 * где что-то из архива переходит в разряд «можно переслать».
 */

type Pool = "style" | "qa";

type MediaExample = {
  pool: Pool;
  id: string;
  studentText: string;
  ownerText: string;
  mediaUrl: string;
  mediaType: "audio" | "image" | "video" | "file";
  source?: string;
  approvedForReuse: boolean;
  createdAt: string;
};

const POOL_LABEL: Record<Pool, string> = {
  style: "директ",
  qa: "группа",
};

function MediaPreview({ url, type, onZoom }: { url: string; type: MediaExample["mediaType"]; onZoom: () => void }) {
  if (type === "audio") return <audio controls src={url} className="media-preview-player" />;
  if (type === "file") return <a className="btn small ghost" href={url} target="_blank" rel="noreferrer">Открыть PDF</a>;
  if (type === "video") return <video controls src={url} className="media-preview-player" style={{ borderRadius: 8 }} />;
  // Раньше .thumb был кликабелен только визуально (курсор zoom-in из общего
  // стиля), а обработчика открыть во весь экран не было вообще — владелец
  // жаловался «фотографии не открываются». Тот же лайтбокс, что у чеков.
  return <img className="thumb" src={url} alt="" loading="lazy" onClick={onZoom} />;
}

/** Загрузка своего файла и озвучка текста голосом Ширин. */
function LibraryAdd({ onAdded }: { onAdded: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [caption, setCaption] = useState("");
  const [keywords, setKeywords] = useState("");
  const [approved, setApproved] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  type VoiceStatus = { voiceConfigured: boolean; voiceEnabled: boolean; voiceSwitch: boolean; voiceReplySwitch: boolean; maxVoiceText: number };
  const [voice, setVoice] = useState<VoiceStatus | null>(null);
  const [speech, setSpeech] = useState("");

  useEffect(() => {
    api<VoiceStatus>("/admin/media-library/status")
      .then(setVoice)
      .catch(() => setVoice(null));
  }, []);

  async function add() {
    if (!file) return;
    setBusy(true);
    setMsg(null);
    try {
      await uploadLibraryFile(file, caption, keywords, approved);
      setFile(null);
      setCaption("");
      setKeywords("");
      setMsg({ ok: true, text: "Файл добавлен в библиотеку" });
      onAdded();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Не удалось загрузить" });
    } finally {
      setBusy(false);
    }
  }

  async function flipSwitch(key: "voiceCloneEnabled" | "voiceReplyEnabled", next: boolean) {
    try {
      await api("/admin/settings", { method: "PUT", body: { [key]: String(next) } });
      const fresh = await api<VoiceStatus>("/admin/media-library/status");
      setVoice(fresh);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Не удалось переключить" });
    }
  }

  async function speak() {
    setBusy(true);
    setMsg(null);
    try {
      await api("/admin/media-library/synthesize", { method: "POST", body: { text: speech, keywords } });
      setSpeech("");
      setMsg({ ok: true, text: "Озвучка готова — прослушайте её ниже и нажмите «Одобрить», если всё хорошо" });
      onAdded();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Не удалось озвучить" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <h3>Добавить в библиотеку</h3>
      <p className="hint">
        Фото, видео (mp4), голосовое или PDF до 8 МБ. В «словах» через пробел напишите, о чём спрашивают клиенты
        («цена курс оплата»): по ним бот находит файл.
      </p>
      <input type="file" accept="image/jpeg,image/png,image/webp,video/mp4,audio/mpeg,audio/mp4,audio/ogg,audio/aac,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <input className="input" placeholder="Подпись (необязательно)" value={caption} maxLength={1000} onChange={(e) => setCaption(e.target.value)} style={{ marginTop: 8 }} />
      <input className="input" placeholder="Слова для подбора: курс цена оплата" value={keywords} maxLength={500} onChange={(e) => setKeywords(e.target.value)} style={{ marginTop: 8 }} />
      <label style={{ display: "block", marginTop: 8 }}>
        <input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} /> Сразу разрешить боту отправлять
      </label>
      <button className="btn wide" style={{ marginTop: 8 }} disabled={!file || busy} onClick={add}>
        {busy ? "Загружаю…" : "Добавить"}
      </button>
      {/* Вне блока озвучки: рубильник глушит и живые одобренные голосовые из
          библиотеки, поэтому нужен и без настроенного ElevenLabs (12.11.2026). */}
      {voice && (
        <label style={{ display: "block", marginTop: 16 }}>
          <input type="checkbox" checked={voice.voiceReplySwitch} onChange={(e) => void flipSwitch("voiceReplyEnabled", e.target.checked)} /> Бот отправляет голосовые
          <span className="hint" style={{ display: "block" }}>
            Выключено — бот не шлёт голосовые совсем: ни озвучку, ни одобренные записи Ширин из библиотеки. Отвечает текстом.
          </span>
        </label>
      )}
      {voice?.voiceConfigured && (
        <div style={{ marginTop: 16 }}>
          <h3>Озвучить голосом Ширин</h3>
          <p className="hint">
            Короткая реплика (до {voice.maxVoiceText} знаков). Озвучка попадает в список неодобренной: сначала вы её слушаете,
            потом решаете, можно ли боту её отправлять.
            {!voice.voiceEnabled && " Сейчас озвучка выключена в настройках."}
          </p>
          <label style={{ display: "block", marginBottom: 6 }}>
            <input type="checkbox" checked={voice.voiceSwitch} onChange={(e) => void flipSwitch("voiceCloneEnabled", e.target.checked)} /> Озвучка голосом Ширин включена
          </label>
          <textarea className="input" rows={3} value={speech} maxLength={voice.maxVoiceText} onChange={(e) => setSpeech(e.target.value)} placeholder="Что должна сказать Ширин" />
          <button className="btn wide" style={{ marginTop: 8 }} disabled={!speech.trim() || busy || !voice.voiceEnabled} onClick={speak}>
            Озвучить
          </button>
        </div>
      )}
      {msg && <div className={msg.ok ? "msg" : "msg err"} style={{ marginTop: 8 }}>{msg.text}</div>}
    </div>
  );
}

export function MediaExamplesPage() {
  const { rows, hasMore, loadingMore, err: pagedErr, loadMore, reload } = usePaged<MediaExample>(
    "/admin/media-examples",
    "",
    24
  );
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  const load = reload;


  async function approve(row: MediaExample) {
    setBusy(row.pool + row.id);
    try {
      await api(`/admin/media-examples/${row.pool}/${row.id}/approve`, {
        method: "POST",
        body: { approvedForReuse: !row.approvedForReuse },
      });
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Не удалось изменить");
    } finally {
      setBusy(null);
    }
  }

  async function remove(row: MediaExample) {
    setBusy(row.pool + row.id);
    try {
      await api(`/admin/media-examples/${row.pool}/${row.id}`, { method: "DELETE" });
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Не удалось удалить");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
    <LibraryAdd onAdded={load} />
    <div className="card">
      <h2>{Icons.media} Фото и видео для ответов</h2>
      <p className="hint">
        Голосовые, фото и видео, которыми Ширин реально отвечала — из директа и из учебной группы. Отметьте
        «Одобрить» только там, где файл подходит для похожего вопроса от другого человека — бот пересылает клиенту
        ТОЛЬКО одобренные (и только из директа, группа пока просто копится).
      </p>
      {(err || pagedErr) && <div className="msg err">{err || pagedErr}</div>}
      {!rows && <div className="skeleton" style={{ height: 180 }} />}
      {rows && rows.length === 0 && <EmptyState text="Пока пусто — появится само, как только Ширин ответит голосом, фото или видео." />}

      <div className="list">
        {rows?.map((r) => {
          const rowBusy = busy === r.pool + r.id;
          return (
            <div className="list-row" key={r.pool + r.id} style={{ opacity: r.approvedForReuse ? 1 : 0.8 }}>
              <div className="list-main media-row">
                <MediaPreview url={r.mediaUrl} type={r.mediaType} onZoom={() => setZoom(r.mediaUrl)} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="funnel-meta">Вопрос: {r.studentText || "—"}</div>
                  {r.ownerText && <div style={{ marginTop: 4 }}>{r.ownerText}</div>}
                  <div className="list-chips" style={{ marginTop: 6 }}>
                    <span className="chip">{r.source === "LIBRARY" ? "библиотека" : POOL_LABEL[r.pool]}</span>
                    {r.approvedForReuse && <span className="chip chip-ok">одобрено</span>}
                  </div>
                </div>
              </div>
              <div className="list-actions">
                <button className="btn small ghost" disabled={rowBusy} onClick={() => approve(r)}>
                  {r.approvedForReuse ? "Снять одобрение" : "Одобрить"}
                </button>
                <button className="btn small danger" disabled={rowBusy} onClick={() => remove(r)}>
                  ×
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {hasMore && (
        <button className="btn ghost wide" style={{ marginTop: 10 }} disabled={loadingMore} onClick={loadMore}>
          {loadingMore ? "Загружаю…" : "Показать ещё"}
        </button>
      )}

      <Lightbox src={zoom} label="Фото целиком" alt="Фото целиком, увеличено" onClose={() => setZoom(null)} />
    </div>
    </>
  );
}
