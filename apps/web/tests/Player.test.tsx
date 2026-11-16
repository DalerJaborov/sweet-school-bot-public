import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { dict } from "../src/course/i18n";
import { Player } from "../src/course/player/Player";
import { HOLD_MS } from "../src/course/player/useGestures";

/**
 * ПЛЕЕР: жесты как в YouTube, спиннер вместо ошибки, память скорости,
 * подсказка один раз. hls.js подменён: нам важно не как он качает, а как
 * плеер реагирует на его события.
 */
type Handler = (event: string, data: unknown) => void;

const { FakeHls, instances } = vi.hoisted(() => {
  const instances: FakeHls[] = [];
  class FakeHls {
    static isSupported = () => true;
    static Events = { MANIFEST_PARSED: "mp", LEVEL_SWITCHED: "ls", FRAG_BUFFERED: "fb", ERROR: "err" };
    static ErrorTypes = { NETWORK_ERROR: "networkError", MEDIA_ERROR: "mediaError" };
    static ErrorDetails = { BUFFER_STALLED_ERROR: "bufferStalledError" };
    levels: { width?: number; height: number }[] = [{ height: 480 }, { height: 720 }, { height: 1080 }];
    bandwidthEstimate = 2_400_000;
    currentLevel = -1;
    startLevel = -1;
    handlers: Record<string, Handler[]> = {};
    loadSource = () => undefined;
    attachMedia = () => undefined;
    destroy = () => undefined;
    recoverMediaError = () => undefined;
    startLoad = (_pos?: number) => undefined;
    constructor(public config: Record<string, unknown>) {
      instances.push(this);
    }
    on(event: string, fn: Handler) {
      (this.handlers[event] ??= []).push(fn);
    }
    emit(event: string, data: unknown) {
      for (const fn of this.handlers[event] ?? []) fn(event, data);
    }
  }
  return { FakeHls, instances };
});

vi.mock("hls.js", () => ({ default: FakeHls }));

const t = dict("ru");
let paused = true;

// В jsdom нет PointerEvent — fireEvent.pointerDown шлёт голый Event без
// button/clientX, и жесты его честно игнорируют. Подменяем на MouseEvent с pointerId.
if (typeof window.PointerEvent === "undefined") {
  class FakePointerEvent extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  Object.defineProperty(window, "PointerEvent", { configurable: true, value: FakePointerEvent });
}

beforeEach(() => {
  instances.length = 0;
  paused = true;
  localStorage.clear();
  // jsdom не умеет play/pause/load — подменяем, чтобы плеер не падал.
  Object.defineProperty(HTMLMediaElement.prototype, "play", { configurable: true, value: () => Promise.resolve() });
  Object.defineProperty(HTMLMediaElement.prototype, "pause", { configurable: true, value: () => undefined });
  Object.defineProperty(HTMLMediaElement.prototype, "load", { configurable: true, value: () => undefined });
  Object.defineProperty(HTMLMediaElement.prototype, "paused", { configurable: true, get: () => paused });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderPlayer(props: Partial<Parameters<typeof Player>[0]> = {}) {
  const onProgress = vi.fn();
  const utils = render(
    <Player
      t={t}
      src="/m3u8"
      title="Урок"
      watermark="Зухра · 12"
      startAt={0}
      nonce={1}
      showQuality
      onProgress={onProgress}
      {...props}
    />,
  );
  const video = utils.container.querySelector("video") as HTMLVideoElement;
  const gesture = screen.getByTestId("player-gesture");
  gesture.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 300, height: 170, right: 300, bottom: 170, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  return { ...utils, video, gesture, onProgress };
}

/** Дождаться динамического import("hls.js") и его подписок. */
async function hlsReady(): Promise<FakeHls> {
  await act(async () => {});
  expect(instances.length).toBeGreaterThan(0);
  return instances[instances.length - 1];
}

describe("Плеер: жесты", () => {
  it("зажать ≥400 мс во время игры — 2× и бейдж; отпустить — прежняя скорость", () => {
    vi.useFakeTimers();
    localStorage.setItem("ssb_rate", "1.25");
    paused = false;
    const { video, gesture } = renderPlayer();
    fireEvent.click(screen.getByRole("button", { name: t.hintDismiss }));
    expect(video.playbackRate).toBe(1.25);

    fireEvent.pointerDown(gesture, { button: 0, pointerId: 1, clientX: 150, clientY: 80 });
    act(() => {
      vi.advanceTimersByTime(HOLD_MS - 1);
    });
    expect(video.playbackRate).toBe(1.25);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(video.playbackRate).toBe(2);
    expect(screen.getByRole("status")).toHaveTextContent("2×");

    fireEvent.pointerUp(gesture, { button: 0, pointerId: 1, clientX: 150, clientY: 80 });
    expect(video.playbackRate).toBe(1.25);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("двойное касание по правой трети — +10 секунд и всплеск; по левой — −10", () => {
    const { video, gesture } = renderPlayer();
    fireEvent.click(screen.getByRole("button", { name: t.hintDismiss }));

    const tap = (x: number) => {
      fireEvent.pointerDown(gesture, { button: 0, pointerId: 1, clientX: x, clientY: 80 });
      fireEvent.pointerUp(gesture, { button: 0, pointerId: 1, clientX: x, clientY: 80 });
    };
    tap(250);
    tap(250);
    expect(video.currentTime).toBe(10);
    expect(gesture.parentElement?.querySelector(".player-ripple.is-right")?.textContent).toBe("+10");

    tap(20);
    tap(20);
    expect(video.currentTime).toBe(0);
    expect(gesture.parentElement?.querySelector(".player-ripple.is-left")?.textContent).toBe("−10");
  });
});

describe("Плеер: подсказка", () => {
  it("показана один раз: после касания записана в localStorage и больше не появляется", () => {
    const first = renderPlayer();
    expect(screen.getByText(t.hintHold)).toBeTruthy();
    expect(screen.getByText(t.hintDoubleTap)).toBeTruthy();
    expect(screen.getByText(t.hintButtons)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t.hintDismiss }));
    expect(screen.queryByText(t.hintHold)).toBeNull();
    expect(localStorage.getItem("ssb_player_hint")).toBe("1");
    first.unmount();

    renderPlayer();
    expect(screen.queryByText(t.hintHold)).toBeNull();
  });
});

describe("Плеер: качество и скорость", () => {
  it("в подписи «Авто · 720p» — что играет ABR; ручной выбор уходит в hls.currentLevel", async () => {
    localStorage.setItem("ssb_player_hint", "1");
    renderPlayer();
    const hls = await hlsReady();
    act(() => {
      hls.emit("mp", {});
      hls.emit("ls", { level: 1 });
    });
    const label = t.qualityAutoWith("720p");
    const btn = screen.getByRole("button", { name: `${t.quality}: ${label}` });
    expect(btn).toHaveTextContent(label);

    fireEvent.click(btn);
    fireEvent.click(screen.getByRole("button", { name: "1080p" }));
    expect(hls.currentLevel).toBe(2);
    expect(screen.getByRole("button", { name: `${t.quality}: 1080p` })).toBeTruthy();
    expect(screen.queryByRole("group", { name: t.quality })).toBeNull();
  });

  it("скорость из меню применяется к видео и запоминается в ssb_rate", () => {
    localStorage.setItem("ssb_player_hint", "1");
    const first = renderPlayer();
    fireEvent.click(screen.getByRole("button", { name: `${t.speed}: 1×` }));
    fireEvent.click(screen.getByRole("button", { name: "1.5×" }));
    expect(first.video.playbackRate).toBe(1.5);
    expect(localStorage.getItem("ssb_rate")).toBe("1.5");
    first.unmount();

    const second = renderPlayer();
    expect(second.video.playbackRate).toBe(1.5);
    expect(screen.getByRole("button", { name: `${t.speed}: 1.5×` })).toBeTruthy();
  });
});

describe("Плеер: экран не гаснет (Wake Lock)", () => {
  type Lock = { release: ReturnType<typeof vi.fn>; addEventListener: ReturnType<typeof vi.fn> };
  const locks: Lock[] = [];
  const request = vi.fn(async (_type: "screen") => {
    const lock: Lock = { release: vi.fn(async () => undefined), addEventListener: vi.fn() };
    locks.push(lock);
    return lock;
  });
  let hidden = false;

  beforeEach(() => {
    locks.length = 0;
    hidden = false;
    request.mockClear();
    localStorage.setItem("ssb_player_hint", "1");
    Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  });
  afterEach(() => {
    delete (navigator as { wakeLock?: unknown }).wakeLock;
    delete (document as { hidden?: unknown }).hidden;
  });

  const flush = () => act(async () => {});

  it("ГЛАВНОЕ: play — просим «screen»; pause — отпускаем; ended — тоже отпускаем", async () => {
    const { video } = renderPlayer();
    expect(request).not.toHaveBeenCalled();

    fireEvent.play(video);
    await flush();
    expect(request).toHaveBeenCalledWith("screen");
    expect(locks).toHaveLength(1);

    fireEvent.pause(video);
    await flush();
    expect(locks[0].release).toHaveBeenCalledTimes(1);

    fireEvent.play(video);
    await flush();
    expect(locks).toHaveLength(2);
    fireEvent.ended(video);
    await flush();
    expect(locks[1].release).toHaveBeenCalledTimes(1);
  });

  it("свернули вкладку — отпускаем; вернулись, а видео играет — просим снова", async () => {
    paused = false;
    const { video } = renderPlayer();
    fireEvent.play(video);
    await flush();
    expect(locks).toHaveLength(1);

    hidden = true;
    fireEvent(document, new Event("visibilitychange"));
    await flush();
    expect(locks[0].release).toHaveBeenCalledTimes(1);

    hidden = false;
    fireEvent(document, new Event("visibilitychange"));
    await flush();
    expect(locks).toHaveLength(2);
  });

  it("API нет — плеер работает как раньше, ничего не бросает", async () => {
    delete (navigator as { wakeLock?: unknown }).wakeLock;
    const { video } = renderPlayer();
    fireEvent.play(video);
    await flush();
    expect(request).not.toHaveBeenCalled();
  });

  it("отказ браузера (низкий заряд) — тихо, без ошибки", async () => {
    request.mockRejectedValueOnce(new Error("NotAllowedError"));
    const { video } = renderPlayer();
    fireEvent.play(video);
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(locks).toHaveLength(0);
  });
});

describe("Плеер: сбои связи", () => {
  it("застревание буфера — спиннер без оверлея; фатальная сеть — 3 тихих повтора, потом оверлей", async () => {
    localStorage.setItem("ssb_player_hint", "1");
    renderPlayer();
    const hls = await hlsReady();
    vi.useFakeTimers();
    // Повтор перечитывает манифест (свежие ссылки на сегменты), а не startLoad.
    const startLoad = vi.spyOn(hls, "loadSource");

    act(() => {
      hls.emit("err", { fatal: false, details: "bufferStalledError", type: "mediaError" });
    });
    expect(screen.getByTestId("player-spinner")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();

    act(() => {
      hls.emit("fb", {});
    });
    expect(screen.queryByTestId("player-spinner")).toBeNull();

    const fatal = () => act(() => hls.emit("err", { fatal: true, type: "networkError", details: "fragLoadError" }));
    fatal();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(startLoad).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(startLoad).toHaveBeenCalledTimes(1);

    fatal();
    fatal();
    expect(screen.queryByRole("alert")).toBeNull();
    fatal();
    expect(screen.getByRole("alert")).toHaveTextContent(t.playerNetwork);

    fireEvent.click(screen.getByRole("button", { name: t.retry }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(startLoad).toHaveBeenCalledTimes(2);
  });

  it("настройки hls.js под слабую связь", async () => {
    localStorage.setItem("ssb_player_hint", "1");
    renderPlayer();
    const hls = await hlsReady();
    expect(hls.config).toMatchObject({
      lowLatencyMode: false,
      startLevel: -1,
      maxBufferLength: 60,
      maxMaxBufferLength: 120,
      backBufferLength: 30,
      capLevelToPlayerSize: true,
      enableWorker: true,
    });
  });

  // 16.11.2026: ученицы на Android видели вечный спиннер. Хранилище (R2) не
  // отвечает Allow-Credentials, и запрос сегмента «с куками» браузер рубит.
  it("куки только своему серверу: сегменты из хранилища — без них", async () => {
    localStorage.setItem("ssb_player_hint", "1");
    renderPlayer();
    const hls = await hlsReady();
    const xhrSetup = hls.config.xhrSetup as (xhr: { withCredentials: boolean }, url: string) => void;
    const own = { withCredentials: false };
    xhrSetup(own, `${location.origin}/api/course/lessons/l1/key`);
    expect(own.withCredentials).toBe(true);
    const relative = { withCredentials: false };
    xhrSetup(relative, "/api/course/lessons/l1/variant/480p");
    expect(relative.withCredentials).toBe(true);
    const segment = { withCredentials: true };
    xhrSetup(
      segment,
      "https://acc.r2.cloudflarestorage.com/sweet-school/courses/c/l/480p/seg_000.ts?X-Amz-Signature=abc",
    );
    expect(segment.withCredentials).toBe(false);
  });
});

describe("Плеер: слабая связь (перенос из аудита скорости, 15.11.2026)", () => {
  it("вертикальный урок 720×1280: в меню «720p», а не «1280p»; 360p в списке", async () => {
    localStorage.setItem("ssb_player_hint", "1");
    renderPlayer();
    const hls = await hlsReady();
    hls.levels = [
      { width: 720, height: 1280 },
      { width: 480, height: 854 },
      { width: 360, height: 640 },
    ];
    act(() => {
      hls.emit("mp", {});
      hls.emit("ls", { level: 0 });
    });
    const btn = screen.getByRole("button", { name: `${t.quality}: ${t.qualityAutoWith("720p")}` });
    fireEvent.click(btn);
    expect(screen.getByRole("button", { name: "360p" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "1280p" })).toBeNull();
  });

  it("слабая связь на вертикальном уроке: старт с 480p (по короткой стороне)", async () => {
    Object.defineProperty(navigator, "connection", { configurable: true, value: { effectiveType: "3g" } });
    try {
      renderPlayer();
      const hls = await hlsReady();
      hls.levels = [
        { width: 720, height: 1280 },
        { width: 480, height: 854 },
        { width: 360, height: 640 },
      ];
      act(() => hls.emit("mp", {}));
      expect(hls.startLevel).toBe(1);
    } finally {
      Object.defineProperty(navigator, "connection", { configurable: true, value: undefined });
    }
  });

  it("скорость канала запоминается и следующий урок стартует с неё", async () => {
    const first = renderPlayer();
    const hls = await hlsReady();
    expect(hls.config.abrEwmaDefaultEstimate).toBe(500_000);
    act(() => {
      for (let i = 0; i < 4; i += 1) hls.emit("fb", {});
    });
    expect(JSON.parse(localStorage.getItem("ssb_bw") ?? "null")).toMatchObject({ bps: 2_400_000 });
    first.unmount();

    renderPlayer();
    const next = await hlsReady();
    expect(next.config.abrEwmaDefaultEstimate).toBe(2_400_000);
  });

  it("сеть вернулась во время тихого повтора — грузим сразу, отложенный повтор отменён", async () => {
    renderPlayer();
    const hls = await hlsReady();
    vi.useFakeTimers();
    const start = vi.spyOn(hls, "loadSource");
    act(() => hls.emit("err", { fatal: true, type: "networkError", details: "fragLoadError" }));
    expect(start).not.toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(start).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(start).toHaveBeenCalledTimes(1);
  });
  // 16.11.2026: ссылки на сегменты истекали через 5 минут, а hls.js плейлист
  // записи не перечитывает. 403 от хранилища — сразу новый манифест с той же секунды.
  it("403 на сегменте — сразу перечитываем манифест и продолжаем с той же секунды", async () => {
    localStorage.setItem("ssb_player_hint", "1");
    const { video } = renderPlayer();
    const hls = await hlsReady();
    vi.useFakeTimers();
    const reload = vi.spyOn(hls, "loadSource");
    Object.defineProperty(video, "currentTime", { configurable: true, value: 312, writable: true });
    act(() => {
      video.dispatchEvent(new Event("timeupdate"));
    });
    act(() =>
      hls.emit("err", { fatal: true, type: "networkError", details: "fragLoadError", response: { code: 403 } })
    );
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(hls.config.startPosition).toBe(312);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});