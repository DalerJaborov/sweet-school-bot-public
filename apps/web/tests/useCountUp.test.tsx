import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { useCountUp } from "../src/hooks/useCountUp";

/**
 * Число плитки: первый показ — сразу итог; смена значения — пробег за 400 мс;
 * prefers-reduced-motion — мгновенно, без requestAnimationFrame.
 */
function Num({ value }: { value: number }) {
  return <output data-testid="n">{useCountUp(value)}</output>;
}

function matchMedia(reduce: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((q: string) => ({ matches: reduce && q.includes("reduce"), media: q, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useCountUp", () => {
  it("первый рендер показывает значение сразу, без пробега от нуля", () => {
    matchMedia(false);
    render(<Num value={120} />);
    expect(screen.getByTestId("n").textContent).toBe("120");
  });

  it("при смене значения число бежит через промежуточные и доходит до цели", async () => {
    matchMedia(false);
    let now = 0;
    vi.stubGlobal("performance", { now: () => now });
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const { rerender } = render(<Num value={0} />);
    rerender(<Num value={100} />);
    const tick = (ms: number) => {
      now = ms;
      const cb = frames.shift();
      act(() => cb?.(now));
    };
    tick(100);
    const mid = Number(screen.getByTestId("n").textContent);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(100);
    tick(200);
    tick(400);
    expect(screen.getByTestId("n").textContent).toBe("100");
    expect(frames).toHaveLength(0);
  });

  it("prefers-reduced-motion: новое значение сразу, кадры анимации не запрашиваются", () => {
    matchMedia(true);
    const raf = vi.fn();
    vi.stubGlobal("requestAnimationFrame", raf);
    const { rerender } = render(<Num value={5} />);
    rerender(<Num value={9} />);
    expect(screen.getByTestId("n").textContent).toBe("9");
    expect(raf).not.toHaveBeenCalled();
  });
});
