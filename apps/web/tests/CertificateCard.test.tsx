import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { CertificateCard } from "../src/course/components/CertificateCard";
import { dict } from "../src/course/i18n";
import type { CourseCertificate } from "../src/course/api";

afterEach(cleanup);

const t = dict("ru");

function cert(over: Partial<CourseCertificate> = {}): CourseCertificate {
  return { eligible: true, done: 5, total: 5, fullName: null, lang: null, issuedAt: null, number: null, ...over };
}

const profile = { firstName: "Мадина", lastName: "Рахимова", language: "ru" as const };

/**
 * СЕРТИФИКАТ (03.09.2026). Форма показывается только пройденному курсу, имя
 * предзаполнено из профиля, после выписки PDF открывается новой вкладкой.
 */
describe("CertificateCard", () => {
  let open: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    open = vi.fn();
    vi.stubGlobal("open", open);
  });

  it("не пройден — карточки нет", () => {
    const { container } = render(
      <CertificateCard t={t} lang="ru" courseId="c1" certificate={cert({ eligible: false, done: 2 })} profile={profile} />
    );
    expect(container.innerHTML).toBe("");
  });

  it("пройден — форма с именем из профиля; отправка выписывает и открывает PDF", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, fullName: "Мадина Рахимова", lang: "tg", number: 7, issuedAt: "2026-09-03T10:00:00Z" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<CertificateCard t={t} lang="ru" courseId="c1" certificate={cert()} profile={profile} />);
    expect(screen.getByText(t.certificateReady)).toBeTruthy();
    expect((screen.getByLabelText(t.firstName) as HTMLInputElement).value).toBe("Мадина");
    expect((screen.getByLabelText(t.lastName) as HTMLInputElement).value).toBe("Рахимова");

    // Язык сертификата — отдельный от языка экрана.
    fireEvent.click(screen.getByLabelText("Тоҷикӣ"));
    fireEvent.click(screen.getByRole("button", { name: t.downloadCertificate }));

    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/course/certificate");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ courseId: "c1", firstName: "Мадина", lastName: "Рахимова", lang: "tg" });
    expect(open).toHaveBeenCalledWith("/api/course/certificate/c1.pdf?lang=tg", "_blank", "noopener");

    // После выписки — номер и кнопка «Исправить имя», возвращающая форму.
    expect(screen.getByText(/№ 7/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t.fixName }));
    expect(screen.getByLabelText(t.firstName)).toBeTruthy();
  });

  it("уже выписан — сразу номер и скачивание без формы; имя из сертификата при правке", () => {
    render(
      <CertificateCard
        t={t}
        lang="ru"
        courseId="c1"
        certificate={cert({ fullName: "Мадинахон Рахимова", lang: "ru", number: 3, issuedAt: "2026-09-01T00:00:00Z" })}
        profile={profile}
      />
    );
    expect(screen.queryByLabelText(t.firstName)).toBeNull();
    expect(screen.getByText(/№ 3/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t.downloadCertificate }));
    expect(open).toHaveBeenCalledWith("/api/course/certificate/c1.pdf?lang=ru", "_blank", "noopener");

    fireEvent.click(screen.getByRole("button", { name: t.fixName }));
    expect((screen.getByLabelText(t.firstName) as HTMLInputElement).value).toBe("Мадинахон");
  });

  it("пустое имя — ошибка без запроса", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<CertificateCard t={t} lang="ru" courseId="c1" certificate={cert()} profile={{ ...profile, firstName: null }} />);
    fireEvent.click(screen.getByRole("button", { name: t.downloadCertificate }));
    expect(screen.getByRole("alert").textContent).toBe(t.nameRequired);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * PNG ДЛЯ INSTAGRAM (§6 визуальной системы 04.09.2026) — вторая кнопка рядом
 * с PDF, не вместо него: тот же выписанный сертификат, другой формат. Ведёт
 * себя как shareOrOpenImage — системный лист «Поделиться», если браузер умеет
 * Web Share с файлами, иначе честно открывает картинку новой вкладкой.
 */
describe("CertificateCard — PNG для Instagram", () => {
  afterEach(() => {
    // @ts-expect-error — точечно убираем то, что точечно добавили ниже.
    delete navigator.share;
    // @ts-expect-error
    delete navigator.canShare;
  });

  it("Web Share с файлами недоступен — кнопка честно открывает PNG новой вкладкой", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    render(
      <CertificateCard
        t={t}
        lang="ru"
        courseId="c1"
        certificate={cert({ fullName: "Мадина Рахимова", lang: "ru", number: 3, issuedAt: "2026-09-01T00:00:00Z" })}
        profile={profile}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: t.shareCertificatePng }));
    await waitFor(() => expect(open).toHaveBeenCalledWith("/api/course/certificate/c1.png?lang=ru", "_blank", "noopener"));
  });

  it("Web Share с файлами доступен — уходит в системный лист «Поделиться», без window.open", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    const blob = new Blob(["png"], { type: "image/png" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(blob, { status: 200 })));
    const share = vi.fn().mockResolvedValue(undefined);
    const canShare = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, "share", { value: share, configurable: true });
    Object.defineProperty(navigator, "canShare", { value: canShare, configurable: true });

    render(
      <CertificateCard
        t={t}
        lang="ru"
        courseId="c1"
        certificate={cert({ fullName: "Мадина Рахимова", lang: "tg", number: 3, issuedAt: "2026-09-01T00:00:00Z" })}
        profile={profile}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: t.shareCertificatePng }));
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    expect(share).toHaveBeenCalledWith(expect.objectContaining({ title: t.certificate }));
    expect(open).not.toHaveBeenCalled();
  });
});
