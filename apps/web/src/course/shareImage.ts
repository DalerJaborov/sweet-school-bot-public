/**
 * ДЕЛИТЬСЯ ФАЙЛОМ — Web Share API с честным откатом (визуальная система
 * 04.09.2026, §4 «Поделиться» на геройском экране урока и §6 PNG-сертификат
 * для Instagram — оба шарят готовую картинку с сервера, а не голую ссылку).
 *
 * navigator.share({ files }) — сравнительно новая часть API: на части
 * Android и на iOS до недавних версий её нет вовсе, а там, где есть,
 * navigator.canShare может отказать конкретному файлу. Молчаливая кнопка
 * хуже честного отката: если поделиться нельзя, открываем картинку в новой
 * вкладке — человек сохранит и отправит её сам, привычным способом браузера.
 */

export type ShareImageResult = "shared" | "opened" | "cancelled";

type ShareCapableNavigator = Navigator & {
  canShare?: (data?: ShareData) => boolean;
  share?: (data: ShareData) => Promise<void>;
};

export async function shareOrOpenImage(
  url: string,
  fileName: string,
  meta: { title: string; text?: string },
): Promise<ShareImageResult> {
  const nav = navigator as ShareCapableNavigator;
  if (typeof nav.share === "function" && typeof nav.canShare === "function") {
    try {
      const res = await fetch(url, { credentials: "include" });
      if (res.ok) {
        const blob = await res.blob();
        const file = new File([blob], fileName, { type: blob.type || "image/jpeg" });
        if (nav.canShare({ files: [file] })) {
          await nav.share({ files: [file], title: meta.title, text: meta.text });
          return "shared";
        }
      }
    } catch (err) {
      // Человек сам закрыл системный лист «Поделиться» — это не ошибка и не
      // повод следом ещё и открывать вкладку с картинкой.
      if (err instanceof DOMException && err.name === "AbortError") return "cancelled";
      // Любая другая ошибка (сеть, декодирование) — открываем как честный откат ниже.
    }
  }
  window.open(url, "_blank", "noopener");
  return "opened";
}
