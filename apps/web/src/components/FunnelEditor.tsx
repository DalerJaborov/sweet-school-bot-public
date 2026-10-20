import { useRef, useState } from "react";
import { useUnsavedGuard } from "./UnsavedGuard";
import { uploadFile, type Funnel, type Step } from "../api";

/** То же самое, что сервер реально принимает (apps/api/src/upload.ts,
 *  MIME_TO_KIND) — иначе HEIC с айфона или webm проходят выбор файла и падают
 *  только после долгой загрузки, уже на ответе сервера. */
const ACCEPT_FILE =
  "image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,audio/mpeg,audio/mp4,audio/ogg";

interface FunnelEditorProps {
  funnel: Funnel;
  onSave: (f: Funnel) => void;
  onCancel: () => void;
  saving: boolean;
  error: string | null;
}

export function FunnelEditor(props: FunnelEditorProps) {
  const [f, setF] = useState<Funnel>(props.funnel);
  const [keyword, setKeyword] = useState("");
  const [mediaId, setMediaId] = useState("");
  // Пока редактор открыт, в нём почти всегда есть несохранённое: случайный тап
  // по нижней навигации раньше стирал всё без предупреждения.
  useUnsavedGuard(true);

  function patchStep(i: number, patch: Partial<Step>) {
    const steps = f.steps.slice();
    steps[i] = { ...steps[i], ...patch };
    setF({ ...f, steps });
  }

  function addStep() {
    const nextOrder = Math.max(0, ...f.steps.map((s) => s.order)) + 1;
    setF({
      ...f,
      steps: [...f.steps, { order: nextOrder, delaySeconds: 0, text: "", buttons: [], stopAfter: false }],
    });
  }

  function removeStep(i: number) {
    setF({ ...f, steps: f.steps.filter((_, idx) => idx !== i) });
  }

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadTarget, setUploadTarget] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  function pickFile(stepIndex: number) {
    setUploadTarget(stepIndex);
    fileInputRef.current?.click();
  }

  async function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // тот же файл можно выбрать повторно
    if (!file || uploadTarget === null) return;
    setUploading(true);
    setUploadError(null);
    try {
      const { url, kind } = await uploadFile(file);
      patchStep(uploadTarget, { mediaUrl: url, mediaType: kind as Step["mediaType"] });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Не удалось загрузить файл");
    } finally {
      setUploading(false);
      setUploadTarget(null);
    }
  }

  return (
    <div className="card">
      <h2>{f.id ? "Изменение воронки" : "Новая воронка"}</h2>
      {props.error && <div className="msg err">{props.error}</div>}
      <div className="row" style={{ marginBottom: 12 }}>
        <label className="field">
          <span>Название (видно только тебе)</span>
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </label>
        <label className="toggle">
          <input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />
          Включена
        </label>
      </div>

      <input ref={fileInputRef} type="file" accept={ACCEPT_FILE} style={{ display: "none" }} onChange={onFileChosen} />
      {uploadError && <div className="msg err">{uploadError}</div>}

      {f.trigger === "COMMENT" && (
        <>
          <label className="field">
            <span>Ссылка на публикацию (для памяти, необязательно)</span>
            <input value={f.postUrl ?? ""} onChange={(e) => setF({ ...f, postUrl: e.target.value || null })} />
          </label>
          <label className="field">
            <span>
              Ролики, под которыми работает эта воронка (Enter — добавить ID). Пусто — под ЛЮБЫМ роликом. Если
              указать — под остальными роликами бот просто по-человечески ответит, без кнопок и продажи.
            </span>
            <input
              value={mediaId}
              placeholder="например 17912345678901234"
              onChange={(e) => setMediaId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && mediaId.trim()) {
                  setF({ ...f, mediaIds: [...f.mediaIds, mediaId.trim()] });
                  setMediaId("");
                }
              }}
            />
          </label>
          <div style={{ marginBottom: 12 }}>
            {f.mediaIds.map((id, i) => (
              <span className="chip" key={`${id}-${i}`}>
                {id}
                <button
                  type="button"
                  aria-label={`Убрать ролик ${id}`}
                  onClick={() => setF({ ...f, mediaIds: f.mediaIds.filter((_, idx) => idx !== i) })}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </>
      )}

      <label className="field" style={{ maxWidth: 320 }}>
        <span>Повторять одному человеку не чаще, чем раз в (дней). 0 — только один раз навсегда.</span>
        <input
          type="number"
          value={f.repeatAfterDays}
          onChange={(e) => setF({ ...f, repeatAfterDays: Math.max(0, Number(e.target.value)) })}
        />
      </label>

      <label className="field">
        <span>
          Ключевые слова {f.trigger === "COMMENT" ? "в комментарии" : "в сообщении"} (Enter — добавить). Пусто —
          запускать {f.trigger === "COMMENT" ? "на любой комментарий" : "на любое первое сообщение"}.
        </span>
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && keyword.trim()) {
              setF({ ...f, keywords: [...f.keywords, keyword.trim()] });
              setKeyword("");
            }
          }}
        />
      </label>
      <div style={{ marginBottom: 12 }}>
        {f.keywords.map((k, i) => (
          <span className="chip" key={`${k}-${i}`}>
            {k}
            <button
              type="button"
              aria-label={`Убрать ключевое слово ${k}`}
              onClick={() => setF({ ...f, keywords: f.keywords.filter((_, idx) => idx !== i) })}
            >
              ×
            </button>
          </span>
        ))}
        {f.trigger === "COMMENT" && (
          <label className="toggle" style={{ marginTop: 6 }}>
            <input
              type="checkbox"
              checked={f.anyComment}
              onChange={(e) => setF({ ...f, anyComment: e.target.checked })}
            />
            Отвечать на любой комментарий, без ключевого слова
          </label>
        )}
      </div>

      <h2 style={{ marginTop: 18 }}>Шаги</h2>
      <p className="hint">
        Шаг с кнопками ждёт нажатия — каждая кнопка ведёт на номер шага. Шаг без кнопок отправляется сам после паузы.
        «Конец ветки» останавливает цепочку, чтобы одна ветка не переползла в другую.
      </p>
      {f.steps.map((s, i) => (
        <div className="step" key={i}>
          <div className="step-head">
            <span className="step-num">Шаг {s.order}</span>
            <label className="field" style={{ margin: 0, width: 130 }}>
              <span>Номер шага</span>
              <input
                type="number"
                value={s.order}
                onChange={(e) => patchStep(i, { order: Number(e.target.value) })}
              />
            </label>
            <label className="field" style={{ margin: 0, width: 150 }}>
              <span>Пауза перед ним, сек</span>
              <input
                type="number"
                value={s.delaySeconds}
                onChange={(e) => patchStep(i, { delaySeconds: Math.max(0, Number(e.target.value)) })}
              />
            </label>
            <div className="spacer" />
            <label className="toggle">
              <input
                type="checkbox"
                checked={s.stopAfter}
                onChange={(e) => patchStep(i, { stopAfter: e.target.checked })}
              />
              Конец ветки
            </label>
            <button className="btn small danger" onClick={() => removeStep(i)}>
              Удалить шаг
            </button>
          </div>
          <label className="field">
            <span>Текст сообщения</span>
            <textarea value={s.text} onChange={(e) => patchStep(i, { text: e.target.value })} />
          </label>
          <div className="row" style={{ marginBottom: 10 }}>
            <label className="field">
              <span>
                Ссылка на видео/фото (или загрузи файл кнопкой справа) — лимиты Instagram: фото до 8 МБ, видео до 25
                МБ
              </span>
              <input value={s.mediaUrl ?? ""} onChange={(e) => patchStep(i, { mediaUrl: e.target.value || null })} />
            </label>
            <button
              type="button"
              className="btn small ghost"
              style={{ alignSelf: "flex-end", marginBottom: 12 }}
              disabled={uploading}
              onClick={() => pickFile(i)}
            >
              {uploading && uploadTarget === i ? "Загружаю…" : "Загрузить файл"}
            </button>
            <label className="field" style={{ maxWidth: 140 }}>
              <span>Тип вложения</span>
              <select
                value={s.mediaType ?? ""}
                onChange={(e) => patchStep(i, { mediaType: (e.target.value || null) as Step["mediaType"] })}
              >
                <option value="">нет</option>
                <option value="video">видео</option>
                <option value="image">картинка</option>
                <option value="file">файл</option>
              </select>
            </label>
          </div>
          <div>
            {s.buttons.map((b, bi) => (
              <div className="row" style={{ marginBottom: 6 }} key={bi}>
                <label className="field">
                  <span>Кнопка (до 20 символов)</span>
                  <input
                    value={b.title}
                    maxLength={20}
                    onChange={(e) => {
                      const buttons = s.buttons.slice();
                      buttons[bi] = { ...b, title: e.target.value };
                      patchStep(i, { buttons });
                    }}
                  />
                </label>
                <label className="field" style={{ maxWidth: 150 }}>
                  <span>Ведёт на шаг №</span>
                  <input
                    type="number"
                    value={b.targetOrder}
                    onChange={(e) => {
                      const buttons = s.buttons.slice();
                      buttons[bi] = { ...b, targetOrder: Number(e.target.value) };
                      patchStep(i, { buttons });
                    }}
                  />
                </label>
                <button
                  className="btn small danger"
                  onClick={() => patchStep(i, { buttons: s.buttons.filter((_, idx) => idx !== bi) })}
                >
                  ×
                </button>
              </div>
            ))}
            {s.buttons.length < 3 && (
              <button
                className="btn small ghost"
                onClick={() => patchStep(i, { buttons: [...s.buttons, { title: "", targetOrder: s.order + 1 }] })}
              >
                + Кнопка
              </button>
            )}
          </div>
        </div>
      ))}
      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn ghost" onClick={addStep}>
          + Шаг
        </button>
        <div className="spacer" />
        <button className="btn ghost" onClick={props.onCancel}>
          Отмена
        </button>
        <button className="btn" disabled={props.saving} onClick={() => props.onSave(f)}>
          {props.saving ? "Сохраняю…" : "Сохранить воронку"}
        </button>
      </div>
    </div>
  );
}