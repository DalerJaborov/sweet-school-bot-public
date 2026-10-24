import { afterEach, describe, expect, it } from "vitest";
import { LANG_STORAGE_KEY } from "../../src/site/i18n";
import { bindLangSwitch, pageLang, storedLang, syncLangOnEntry } from "../../src/site/lang";

afterEach(() => {
  localStorage.clear();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

describe("explicit locale links", () => {
  it.each([["ru", "tg"], ["tg", "ru"]])("keeps URL locale %s when remembered choice is %s", (current, saved) => {
    document.documentElement.lang = current;
    localStorage.setItem(LANG_STORAGE_KEY, saved);
    document.head.innerHTML = `<link rel="alternate" hreflang="${saved}" href="https://shirinsweets.online/${saved === "tg" ? "tg/" : ""}faq">`;
    expect(syncLangOnEntry()).toBe(false);
    expect(pageLang()).toBe(current);
    expect(storedLang()).toBe(saved);
  });

  it("remembers only a deliberate switch", () => {
    document.body.innerHTML = '<a href="/tg/faq" data-lang="tg">TG</a>';
    bindLangSwitch();
    const link = document.querySelector("a")!;
    link.addEventListener("click", event => event.preventDefault());
    link.click();
    expect(storedLang()).toBe("tg");
  });
});
