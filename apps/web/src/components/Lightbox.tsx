import { useEffect } from "react";
import { Icons } from "./Brand";

/**
 * ФОТО ВО ВЕСЬ ЭКРАН — один компонент на чеки, отзывы и медиа-архив.
 *
 * Раньше та же разметка (оверлей, картинка, кнопка «Закрыть») и тот же
 * обработчик Esc были скопированы в три страницы. Когда в лайтбоксе чека
 * чинили выход по Esc для клавиатуры, остальные два ещё какое-то время
 * оставались без него — ровно та беда, ради которой дубли и сводят в одно.
 *
 * `src` null — ничего не рисуем: страницы держат состояние «что открыто» у
 * себя, компонент только показывает.
 */
export function Lightbox(props: { src: string | null; label: string; alt: string; onClose: () => void }) {
  const { src, label, alt, onClose } = props;

  // Esc — стандартный способ закрыть модальное окно, ожидаемый и для мыши, и
  // для клавиатуры; без него клавиатурный и экранный читалка-пользователь не
  // мог выйти иначе как кликом мимо.
  useEffect(() => {
    if (!src) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [src, onClose]);

  if (!src) return null;
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={label} onClick={onClose}>
      <img src={src} alt={alt} />
      <button
        type="button"
        className="lightbox-close"
        aria-label="Закрыть"
        onClick={(e) => {
          // Иначе клик доходит и до оверлея — onClose дважды.
          e.stopPropagation();
          onClose();
        }}
      >
        {Icons.close}
      </button>
    </div>
  );
}
