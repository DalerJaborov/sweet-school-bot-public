import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, act, within } from "@testing-library/react";
import { StudentPage } from "../src/pages/StudentPage";
import { ConfirmHost } from "../src/components/ConfirmDialog";
import type { Student } from "../src/api";

/**
 * Карточка ученицы: кольцо и уроки — из /admin/metrics/student/:id; «Новая
 * ссылка» зовёт POST .../link, устройство — существующий
 * POST /admin/course-devices/:id; «Написать» ведёт в Instagram, а для сайта —
 * в WhatsApp, если номер известен.
 */
const student: Student = {
  contact: {
    id: "c1",
    handle: "@madina",
    name: "Мадина",
    studentName: "Мадина Р.",
    channel: "INSTAGRAM",
    instagramUrl: "https://www.instagram.com/madina/",
    whatsappUrl: null,
    paidAt: "2026-09-01T10:00:00Z",
    accessRevokedAt: null,
    accessIssuedAt: "2026-09-01T10:01:00Z",
    personal: false,
  },
  courses: [
    {
      purchaseId: "p1",
      code: "COURSE70",
      title: "21 рецепт",
      amount: 70,
      channel: "INSTAGRAM",
      boughtAt: "2026-09-01T10:00:00Z",
      revoked: false,
      firstOpenedAt: "2026-09-01T12:00:00Z",
      percent: 50,
      lessonsTotal: 2,
      lessonsDone: 1,
      finishedAt: null,
      certificate: null,
      lessons: [
        { id: "l1", title: "Урок 1", order: 1, ready: true, done: true, percent: 100, positionSec: 600, durationSec: 600 },
        { id: "l2", title: "Урок 2", order: 2, ready: true, done: false, percent: 40, positionSec: 360, durationSec: 900 },
        { id: "l3", title: "Урок 3", order: 3, ready: false, done: false, percent: 0, positionSec: 0, durationSec: null },
      ],
    },
  ],
  devices: [
    { id: "d1", label: "Chrome на Android", city: "Душанбе", lastSeenAt: "2026-09-04T09:00:00Z", blocked: false, blockedReason: null },
    { id: "d2", label: "Instagram на iPhone", city: null, lastSeenAt: "2026-09-02T09:00:00Z", blocked: true, blockedReason: "Заблокировано владельцем" },
  ],
  unansweredQuestions: 1,
};

const calls: { url: string; method: string; body?: unknown }[] = [];

function mockFetch(data: Student = student) {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === "/admin/metrics/student/c1/link") return new Response(JSON.stringify({ url: "https://school.tj/course?t=new" }), { status: 200 });
      if (url.startsWith("/admin/metrics/student/")) return new Response(JSON.stringify(data), { status: 200 });
      if (url.startsWith("/admin/course-devices/")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response(JSON.stringify({ error: "нет такого" }), { status: 404 });
    })
  );
}

beforeEach(() => {
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn(async () => undefined) } });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("StudentPage — карточка ученицы", () => {
  it("рисует кольцо, уроки с «где остановилась», устройства человеческими словами и ссылку в Instagram", async () => {
    mockFetch();
    render(<StudentPage contactId="c1" onBack={vi.fn()} />);
    await screen.findByText("Мадина Р.");

    expect(screen.getByRole("img", { name: "21 рецепт: 50%" })).toBeTruthy();
    const course = screen.getByTestId("course-COURSE70");
    expect(within(course).getByText(/1 из 2 уроков/)).toBeTruthy();
    expect(within(course).getByText("пройден")).toBeTruthy();
    expect(within(course).getByText("остановилась на 40%")).toBeTruthy();
    expect(within(course).getByText("видео готовится")).toBeTruthy();

    expect(screen.getByText("Chrome на Android")).toBeTruthy();
    expect(screen.getByText(/Душанбе ·/)).toBeTruthy();
    expect(screen.getByText("Instagram на iPhone")).toBeTruthy();
    expect(screen.getByText("1 вопрос без ответа")).toBeTruthy();

    expect(screen.getByRole("link", { name: "Написать в Instagram" }).getAttribute("href")).toBe("https://www.instagram.com/madina/");
  });

  it("«Новая ссылка» — подтверждение, POST /link, ссылка показана и скопирована", async () => {
    mockFetch();
    render(
      <>
        <StudentPage contactId="c1" onBack={vi.fn()} />
        <ConfirmHost />
      </>
    );
    await screen.findByText("Мадина Р.");
    fireEvent.click(screen.getByRole("button", { name: "Новая ссылка" }));
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Выдать" }));
    });
    expect(calls.find((c) => c.url === "/admin/metrics/student/c1/link")?.method).toBe("POST");
    expect((await screen.findByTestId("new-link")).textContent).toContain("https://school.tj/course?t=new");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("https://school.tj/course?t=new");
  });

  it("«Разблокировать» зовёт существующий /admin/course-devices/:id и перечитывает карточку", async () => {
    mockFetch();
    render(<StudentPage contactId="c1" onBack={vi.fn()} />);
    await screen.findByText("Мадина Р.");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Разблокировать" }));
    });
    expect(calls.find((c) => c.url === "/admin/course-devices/d2")).toMatchObject({ method: "POST", body: { blocked: false } });
    expect(calls.filter((c) => c.url === "/admin/metrics/student/c1").length).toBe(2);
  });

  it("сайт без Instagram: WhatsApp, если номер есть; иначе — скопировать ник", async () => {
    mockFetch({
      ...student,
      contact: { ...student.contact, channel: "WEB", instagramUrl: null, whatsappUrl: "https://wa.me/992901234567" },
    });
    render(<StudentPage contactId="c1" onBack={vi.fn()} />);
    await screen.findByText("Мадина Р.");
    expect(screen.getByRole("link", { name: "Написать в WhatsApp" }).getAttribute("href")).toBe("https://wa.me/992901234567");
    cleanup();

    mockFetch({ ...student, contact: { ...student.contact, channel: "WEB", instagramUrl: null, whatsappUrl: null, studentName: null, name: null } });
    render(<StudentPage contactId="c1" onBack={vi.fn()} />);
    await screen.findByText("@madina", { selector: ".student-title" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Скопировать ник" }));
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("@madina");
  });

  it("«← Ученицы» возвращает к списку", async () => {
    mockFetch();
    const onBack = vi.fn();
    render(<StudentPage contactId="c1" onBack={onBack} />);
    await screen.findByText("Мадина Р.");
    fireEvent.click(screen.getByRole("button", { name: "← Ученицы" }));
    expect(onBack).toHaveBeenCalled();
  });
});
