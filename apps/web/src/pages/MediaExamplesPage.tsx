import { useState } from "react";
import { api } from "../api";
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
  mediaType: "audio" | "image" | "video";
  approvedForReuse: boolean;
  createdAt: string;
};

const POOL_LABEL: Record<Pool, string> = {
  style: "директ",
  qa: "группа",
};

function MediaPreview({ url, type, onZoom }: { url: string; type: MediaExample["mediaType"]; onZoom: () => void }) {
  if (type === "audio") return <audio controls src={url} className="media-preview-player" />;
  if (type === "video") return <video controls src={url} className="media-preview-player" style={{ borderRadius: 8 }} />;
  // Раньше .thumb был кликабелен только визуально (курсор zoom-in из общего
  // стиля), а обработчика открыть во весь экран не было вообще — владелец
  // жаловался «фотографии не открываются». Тот же лайтбокс, что у чеков.
  return <img className="thumb" src={url} alt="" loading="lazy" onClick={onZoom} />;
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
    <div className="card">
      <h2>{Icons.media} Медиа на повтор</h2>
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
                    <span className="chip">{POOL_LABEL[r.pool]}</span>
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
  );
}
