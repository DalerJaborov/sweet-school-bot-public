import { useRef, useState } from "react";
import { toPng } from "html-to-image";
import type { RecipeCardData } from "../api";
import type { Dict } from "../i18n";

/**
 * КАРТОЧКА РЕЦЕПТА v2 (визуальная система 04.09.2026, scratchpad/visual-ideas.md
 * §2). Та же композиция, что в оригинальных карточках Telegram-канала школы, но
 * из структурированных данных (Lesson.recipeData — components/items из
 * cardOcr.ts), а не с картинки: кремовый фон, малиновые «капли» по углам, жёлтая
 * плашка номера, группы жирным, строки с эмодзи и граммовкой.
 *
 * Рецепты, вписанные владельцем текстом (recipeData нет — распознавание не
 * проводилось или сразу вписан текст), эта же карточка показывает как раньше:
 * простым текстом, без чекбоксов и пересчёта. Структура — бонус там, где есть,
 * а не требование к каждому уроку.
 *
 * НЕ ИНВЕРТИРУЕТСЯ В ТЁМНОЙ ТЕМЕ (§9 визуальной системы): цвета — литералы, а
 * не тема-зависимые токены, потому что карточка «бумажная», как и PDF
 * сертификата, и должна выглядеть одинаково на скриншотах школы независимо от
 * темы телефона ученицы.
 */

const PORTIONS = [0.5, 1, 2] as const;
type Portion = (typeof PORTIONS)[number];

/** Целое число как строка («250», «2») — единственное, что можно масштабировать
 *  не гадая. Дробь («1/2») или диапазон («2-3») не трогаем: разрезать их
 *  молча значило бы придумать число, которого владелец не писал. */
function parsePlainNumber(raw: string | null): number | null {
  if (!raw) return null;
  const normalized = raw.trim().replace(",", ".");
  return /^\d+(\.\d+)?$/.test(normalized) ? Number(normalized) : null;
}

/** «Целые граммы, целые яйца» (§2): округляем до ближайшего целого, но не до
 *  нуля — если исходно что-то было, после масштабирования остаётся хотя бы
 *  единица, а не «0 г», выглядящее как ошибка. */
export function scaleAmount(amount: string | null, factor: Portion): string | null {
  if (factor === 1) return amount;
  const n = parsePlainNumber(amount);
  if (n === null) return amount;
  const scaled = Math.round(n * factor);
  return String(n > 0 && scaled === 0 ? 1 : scaled);
}

/** data:image/png;base64,... → Blob, без похода в fetch: fetch() у некоторых
 *  движков не умеет схему data:, а тут только декодирование base64. */
function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(",");
  const header = dataUrl.slice(0, comma);
  const mimeMatch = /data:(.*?);base64/.exec(header);
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeMatch?.[1] || "image/png" });
}

type ShareState = "idle" | "busy" | "error";

export function RecipeCard({
  t,
  title,
  number,
  recipeData,
  fallbackText,
}: {
  t: Dict;
  title: string;
  number: number;
  recipeData: RecipeCardData | null;
  fallbackText: string | null;
}) {
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [portion, setPortion] = useState<Portion>(1);
  const [sharing, setSharing] = useState<ShareState>("idle");
  const exportRef = useRef<HTMLDivElement>(null);

  const toggle = (key: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Без структуры — рецепт как раньше: обычный текст владельца, переносы
  // строк сохраняются (recipe-text уже есть в course.css).
  if (!recipeData) {
    return fallbackText ? <p className="recipe-text">{fallbackText}</p> : <p className="muted">{t.noRecipe}</p>;
  }

  const badge = t.lessonBadge(number);

  /**
   * ОТПРАВКА В WHATSAPP. WhatsApp Web не принимает картинку через ссылку
   * wa.me — только текст. Честный путь на телефоне — Web Share API с файлом
   * (`navigator.share({files})`): тогда открывается системный лист «Поделиться»
   * с WhatsApp среди приложений. Не поддерживается — картинка скачивается, и
   * человек сам прикладывает её к сообщению; выдавать несуществующий «прямой»
   * шаринг там, где браузер его не умеет, было бы враньём об успехе.
   */
  async function share() {
    const node = exportRef.current;
    if (!node) return;
    setSharing("busy");
    try {
      const dataUrl = await toPng(node, { width: 1080, height: 1920, pixelRatio: 1, cacheBust: true });
      const blob = dataUrlToBlob(dataUrl);
      const fileName = `${(title || "recipe").replace(/[^\p{L}\p{N}\- ]+/gu, "").trim() || "recipe"}.png`;
      const file = new File([blob], fileName, { type: "image/png" });
      const nav = navigator as Navigator & {
        canShare?: (data: { files: File[] }) => boolean;
        share?: (data: ShareData) => Promise<void>;
      };
      if (nav.share && nav.canShare?.({ files: [file] })) {
        await nav.share({ files: [file], title });
        setSharing("idle");
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setSharing("idle");
    } catch {
      setSharing("error");
    }
  }

  return (
    <div className="recipe-card-wrap">
      {/* Скрытая копия строго 1080×1920 — то же дерево, что видимая карточка
          ниже, просто без адаптива: экспорт должен совпасть с оригиналом из
          архива школы пиксель в пиксель, а не с тем, что уместилось на узком
          экране телефона. */}
      <RecipeCardFace
        forwardRef={exportRef}
        title={title}
        badge={badge}
        recipeData={recipeData}
        portion={portion}
        checked={checked}
        onToggle={toggle}
        interactive={false}
        exportSize
      />
      <RecipeCardFace
        title={title}
        badge={badge}
        recipeData={recipeData}
        portion={portion}
        checked={checked}
        onToggle={toggle}
        interactive
      />

      <div className="recipe-actions">
        <div className="portion-toggle" role="group" aria-label={t.portionLabel}>
          {PORTIONS.map((p) => (
            <button
              key={p}
              type="button"
              className={p === portion ? "portion-btn on" : "portion-btn"}
              onClick={() => setPortion(p)}
            >
              ×{p}
            </button>
          ))}
        </div>
        <button type="button" className="btn" disabled={sharing === "busy"} onClick={() => void share()}>
          {sharing === "busy" ? t.preparingImage : t.sendToWhatsapp}
        </button>
        {sharing === "error" && <p className="muted">{t.imageShareFailed}</p>}
      </div>
    </div>
  );
}

function RecipeCardFace({
  forwardRef,
  title,
  badge,
  recipeData,
  portion,
  checked,
  onToggle,
  interactive,
  exportSize = false,
}: {
  forwardRef?: React.Ref<HTMLDivElement>;
  title: string;
  badge: string;
  recipeData: RecipeCardData;
  portion: Portion;
  checked: Set<string>;
  onToggle: (key: string) => void;
  interactive: boolean;
  exportSize?: boolean;
}) {
  return (
    <div
      ref={forwardRef}
      className={exportSize ? "recipe-card recipe-card-export" : "recipe-card"}
      aria-hidden={exportSize || undefined}
    >
      <CornerBlobs />
      <span className="recipe-badge">{badge}</span>
      <h2 className="recipe-card-title">{title}</h2>
      {recipeData.components.map((component, ci) => (
        <section className="recipe-group" key={ci}>
          {component.name && <h3 className="recipe-group-h">{component.name}</h3>}
          <ul className="recipe-items">
            {component.items.map((item, ii) => {
              const key = `${ci}-${ii}`;
              const isChecked = checked.has(key);
              const amount = scaleAmount(item.amount, portion);
              const qty = [amount, item.unit].filter(Boolean).join(" ");
              const rowClass = isChecked ? "ingredient-row is-checked" : "ingredient-row";
              const body = (
                <>
                  <span className="ingredient-emoji" aria-hidden="true">
                    {item.emoji || "•"}
                  </span>
                  <span className="ingredient-name">{item.ingredient}</span>
                  {qty && <span className="ingredient-amount">{qty}</span>}
                  {item.note && <span className="ingredient-note">({item.note})</span>}
                </>
              );
              return (
                <li key={key}>
                  {interactive ? (
                    <label className={rowClass}>
                      <input type="checkbox" checked={isChecked} onChange={() => onToggle(key)} />
                      {body}
                    </label>
                  ) : (
                    <span className={rowClass}>{body}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <span className="recipe-watermark">SHIRIN SWEETS</span>
    </div>
  );
}

/** Малиновые скруглённые «капли» в углах — одна форма, четыре отражения. */
function CornerBlobs() {
  const path = "M0 55C0 20 20 0 55 0C90 0 120 15 120 50C120 85 95 120 55 120C20 120 0 90 0 55Z";
  const corners = ["tl", "tr", "bl", "br"] as const;
  return (
    <>
      {corners.map((corner) => (
        <svg
          key={corner}
          className={`recipe-corner recipe-corner-${corner}`}
          width="120"
          height="120"
          viewBox="0 0 120 120"
          aria-hidden="true"
          focusable="false"
        >
          <path d={path} fill="#c9376b" />
        </svg>
      ))}
    </>
  );
}
