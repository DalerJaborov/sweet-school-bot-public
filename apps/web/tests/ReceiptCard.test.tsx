import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { ReceiptCard } from "../src/components/ReceiptCard";
import { ToastHost } from "../src/components/Toast";
import { ChoiceHost } from "../src/components/ChoiceSheet";
import { useReceiptDecision } from "../src/hooks/useReceiptDecision";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// jsdom не знает PointerEvent: без него fireEvent.pointerDown шлёт голый Event
// без button/clientX, и обработчик свайпа его отбрасывает. Минимальный
// полифилл поверх MouseEvent — ровно те поля, что читает компонент.
if (!("PointerEvent" in window)) {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    pointerType: string;
    constructor(type: string, init: MouseEventInit & { pointerId?: number; pointerType?: string } = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? "touch";
    }
  }
  (window as unknown as { PointerEvent: typeof PointerEventPolyfill }).PointerEvent = PointerEventPolyfill;
}

const receipt = {
  id: "r1",
  handle: "@madina",
  imageUrl: "/media/r.jpg",
  amount: 70,
  courseGuess: "21 рецепт",
  reason: "похож",
  confidence: 61,
  createdAt: new Date().toISOString(),
};

/** Свайп pointer-событиями: нажал, повёл, отпустил. jsdom не двигает
 *  курсор сам, поэтому координаты задаём руками. */
function swipe(el: HTMLElement, dx: number) {
  fireEvent.pointerDown(el, { clientX: 200, clientY: 100, pointerId: 1, button: 0 });
  fireEvent.pointerMove(el, { clientX: 200 + dx / 2, clientY: 102, pointerId: 1 });
  fireEvent.pointerMove(el, { clientX: 200 + dx, clientY: 104, pointerId: 1 });
  fireEvent.pointerUp(el, { clientX: 200 + dx, clientY: 104, pointerId: 1 });
}

describe("ReceiptCard — свайп", () => {
  it("вправо дальше порога — подтвердить, влево — отклонить, короткий — ничего", () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(<ReceiptCard receipt={receipt} onApprove={onApprove} onReject={onReject} />);
    const card = screen.getByText("@madina").closest(".receipt-card") as HTMLElement;

    swipe(card, 140);
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onReject).not.toHaveBeenCalled();

    swipe(card, -140);
    expect(onReject).toHaveBeenCalledTimes(1);

    swipe(card, 40);
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("вертикальный жест — это прокрутка, решение не принимается", () => {
    const onApprove = vi.fn();
    render(<ReceiptCard receipt={receipt} onApprove={onApprove} onReject={vi.fn()} />);
    const card = screen.getByText("@madina").closest(".receipt-card") as HTMLElement;
    fireEvent.pointerDown(card, { clientX: 200, clientY: 100, pointerId: 1, button: 0 });
    fireEvent.pointerMove(card, { clientX: 220, clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(card, { clientX: 400, clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(card, { clientX: 400, clientY: 300, pointerId: 1 });
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("сумма и курс, прочитанные ИИ, — крупно и чипом; кнопки на месте для ПК", () => {
    render(<ReceiptCard receipt={receipt} onApprove={vi.fn()} onReject={vi.fn()} />);
    expect(screen.getByText("70 с.")).toBeTruthy();
    expect(screen.getByText("21 рецепт")).toBeTruthy();
    expect(screen.getByText("ИИ уверен на 61%")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Подтвердить" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Отклонить" })).toBeTruthy();
  });
});

/** Страница-обёртка: карточка + хук решения, как в ReceiptsPage. */
function Harness({ amount = 70, onSettled }: { amount?: number | null; onSettled?: () => void }) {
  const decision = useReceiptDecision({ onSettled });
  const r = { ...receipt, amount };
  if (decision.pending.has(r.id)) return <div>скрыта</div>;
  return (
    <ReceiptCard
      receipt={r}
      onApprove={() => void decision.approve({ id: r.id, handle: r.handle, amount: r.amount })}
      onReject={() => void decision.reject({ id: r.id, handle: r.handle, amount: r.amount })}
    />
  );
}

function mockDecide() {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ message: "Готово" }), { status: 200 });
    })
  );
  return calls;
}

describe("useReceiptDecision — тост «Отменить» вместо окна «Точно?»", () => {
  it("подтверждение уходит на сервер через 5 с, не раньше; карточка скрыта сразу", async () => {
    vi.useFakeTimers();
    try {
      const calls = mockDecide();
      const onSettled = vi.fn();
      render(
        <>
          <Harness onSettled={onSettled} />
          <ToastHost />
          <ChoiceHost />
        </>
      );
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Подтвердить" }));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText("скрыта")).toBeTruthy();
      expect(screen.getByText("Ссылка ушла @madina")).toBeTruthy();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(4900);
      });
      expect(calls).toHaveLength(0);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(calls).toEqual([{ url: "/admin/receipts/r1/decide", body: { action: "approve" } }]);
      expect(onSettled).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("«Отменить» в тосте гасит отсчёт — запроса нет, карточка возвращается", async () => {
    vi.useFakeTimers();
    try {
      const calls = mockDecide();
      render(
        <>
          <Harness />
          <ToastHost />
          <ChoiceHost />
        </>
      );
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Подтвердить" }));
        await vi.advanceTimersByTimeAsync(1000);
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Отменить" }));
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(calls).toHaveLength(0);
      expect(screen.getByRole("button", { name: "Подтвердить" })).toBeTruthy();
      expect(screen.queryByText("Ссылка ушла @madina")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("отклонение спрашивает причину чипом и шлёт её в журнал", async () => {
    vi.useFakeTimers();
    try {
      const calls = mockDecide();
      render(
        <>
          <Harness />
          <ToastHost />
          <ChoiceHost />
        </>
      );
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Отклонить" }));
        await vi.advanceTimersByTimeAsync(0);
      });
      const sheet = screen.getByRole("dialog", { name: "Почему отклоняем?" });
      expect(sheet).toBeTruthy();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Чужой чек/ }));
        await vi.advanceTimersByTimeAsync(5100);
      });
      expect(calls).toEqual([{ url: "/admin/receipts/r1/decide", body: { action: "reject", reason: "чужой чек" } }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("сумма не прочиталась — сначала выбор курса, и он уходит в запрос", async () => {
    vi.useFakeTimers();
    try {
      const calls = mockDecide();
      render(
        <>
          <Harness amount={null} />
          <ToastHost />
          <ChoiceHost />
        </>
      );
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Подтвердить" }));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByRole("dialog", { name: /какой курс открыть/ })).toBeTruthy();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Оба курса/ }));
        await vi.advanceTimersByTimeAsync(5100);
      });
      expect(calls).toEqual([{ url: "/admin/receipts/r1/decide", body: { action: "approve", course: "BOTH" } }]);
    } finally {
      vi.useRealTimers();
    }
  });
});
