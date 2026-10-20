import { useRef, useState } from "react";
import { api, uploadFile, type Testimonial } from "../api";
import { Icons } from "../components/Brand";
import { EmptyState } from "../components/Illustrations";
import { Lightbox } from "../components/Lightbox";
import { toast } from "../components/Toast";
import { usePaged } from "../hooks/usePaged";

const ACCEPT_IMAGE = "image/jpeg,image/png,image/webp,image/gif";

/**
 * ОТЗЫВЫ — реальные скриншоты благодарностей учениц, которые бот кладёт прямо
 * в директ сомневающемуся клиенту (см. apps/api/src/ai/testimonials.ts), а не
 * только даёт ссылку на актуальное в Instagram. Загрузка — тот же общий
 * /admin/upload, что у фото шагов воронки, здесь только список и подписи.
 */
export function TestimonialsPage() {
  const { rows, hasMore, loadingMore, err: pagedErr, loadMore, reload } = usePaged<Testimonial>(
    "/admin/testimonials",
    "",
    24
  );
  const [err, setErr] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const load = reload;

  async function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // тот же файл можно выбрать повторно
    if (!file) return;
    setUploading(true);
    setErr(null);
    try {
      const { url } = await uploadFile(file);
      await api("/admin/testimonials", { method: "POST", body: { imageUrl: url } });
      toast("Отзыв добавлен");
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Не удалось загрузить файл");
    } finally {
      setUploading(false);
    }
  }

  async function saveCaption(row: Testimonial, caption: string) {
    setBusyId(row.id);
    try {
      await api(`/admin/testimonials/${row.id}`, { method: "PUT", body: { caption: caption.trim() || null } });
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Не удалось сохранить подпись");
    } finally {
      setBusyId(null);
    }
  }

  async function toggleActive(row: Testimonial) {
    setBusyId(row.id);
    try {
      await api(`/admin/testimonials/${row.id}`, { method: "PUT", body: { active: !row.active } });
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Не удалось изменить");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(row: Testimonial) {
    setBusyId(row.id);
    try {
      await api(`/admin/testimonials/${row.id}`, { method: "DELETE" });
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Не удалось удалить");
    } finally {
      setBusyId(null);
    }
  }

  async function runArchiveImport() {
    setErr(null);
    try {
      const r = await api<{ started: boolean; note: string }>("/admin/testimonials/import-archive", { method: "POST" });
      toast(r.note);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Ошибка");
    }
  }

  return (
    <div className="card">
      <h2>{Icons.testimonials} Отзывы</h2>
      <p className="hint">
        Скриншоты настоящих отзывов учениц. Когда клиент в переписке сомневается («не уверена, что получится»,
        «дорого» и похожее), бот сам кладёт в директ один из них — по кругу, без повторов одному и тому же
        человеку. Загрузи хотя бы один, чтобы это заработало.
      </p>
      <p className="hint">
        Кнопка «Разобрать архив» сама найдёт в учебной Telegram-группе благодарности учениц и сделает из них
        карточки — они появятся здесь ВЫКЛЮЧЕННЫМИ (черновик), включай вручную те, что подходят.
      </p>

      {(err || pagedErr) && <div className="msg err">{err || pagedErr}</div>}

      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT_IMAGE}
        style={{ display: "none" }}
        onChange={onFileChosen}
      />
      <div className="row" style={{ marginBottom: 14 }}>
        <button className="btn ghost" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
          {uploading ? "Загружаю…" : "Загрузить скриншот"}
        </button>
        <button className="btn ghost" onClick={runArchiveImport}>Разобрать архив учебной группы</button>
        <button className="btn ghost" onClick={load}>Обновить</button>
      </div>

      {!rows && <div className="skeleton" style={{ height: 140, marginTop: 14 }} />}
      {rows && rows.length === 0 && (
        <div style={{ marginTop: 14 }}>
          <EmptyState text="Пока пусто — загрузи первый скриншот отзыва" />
        </div>
      )}

      <div className="list" style={{ marginTop: 14 }}>
        {rows?.map((r) => (
          <div className="list-row" key={r.id} style={{ opacity: r.active ? 1 : 0.5 }}>
            <div className="list-main" style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              <img
                className="thumb"
                src={r.imageUrl}
                alt="Отзыв"
                onClick={() => setZoom(r.imageUrl)}
                loading="lazy"
              />
              <div style={{ minWidth: 0, flex: 1 }}>
                <input
                  defaultValue={r.caption ?? ""}
                  placeholder="Подпись (необязательно) — например «вот отзыв одной из наших учениц»"
                  onBlur={(e) => e.target.value !== (r.caption ?? "") && saveCaption(r, e.target.value)}
                  style={{ width: "100%" }}
                />
                <div className="list-chips" style={{ marginTop: 6 }}>
                  {!r.active && <span className="chip">выключен</span>}
                </div>
                {r.lastShownAt && (
                  <div className="list-sub" style={{ marginTop: 6 }}>
                    Последний раз показан {new Date(r.lastShownAt).toLocaleString("ru-RU")}
                  </div>
                )}
              </div>
            </div>
            <div className="list-actions">
              <button className="btn small ghost" disabled={busyId === r.id} onClick={() => toggleActive(r)}>
                {r.active ? "Выкл" : "Вкл"}
              </button>
              <button className="btn danger small" disabled={busyId === r.id} onClick={() => remove(r)}>
                ×
              </button>
            </div>
          </div>
        ))}
      </div>

      {hasMore && (
        <button className="btn ghost wide" style={{ marginTop: 10 }} disabled={loadingMore} onClick={loadMore}>
          {loadingMore ? "Загружаю…" : "Показать ещё"}
        </button>
      )}

      <Lightbox src={zoom} label="Отзыв целиком" alt="Отзыв целиком, увеличено" onClose={() => setZoom(null)} />
    </div>
  );
}
