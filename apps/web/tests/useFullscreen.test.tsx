import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useFullscreen } from "../src/course/player/useFullscreen";

const env = vi.hoisted(() => ({ platform: "ios", standalone: false }));
vi.mock("../src/course/install/detect", () => ({ environment: () => env }));

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("fullscreen keeps the student watermark", () => {
  it("uses the wrapper on iPhone Safari without handing video to the unmarked native player", async () => {
    env.platform = "ios";
    env.standalone = false;
    const nativeFullscreen = vi.fn();
    const wrapper = document.createElement("div");
    const video = Object.assign(document.createElement("video"), { webkitEnterFullscreen: nativeFullscreen });
    const { result } = renderHook(() => useFullscreen({ current: wrapper }, { current: video }));
    await act(async () => { await result.current.toggle(); });
    expect(result.current.pseudo).toBe(true);
    expect(result.current.active).toBe(true);
    expect(nativeFullscreen).not.toHaveBeenCalled();
    await act(async () => { await result.current.toggle(); });
    expect(result.current.active).toBe(false);
  });

  it("still requests fullscreen for the wrapper on supported browsers", async () => {
    env.platform = "other";
    const requestFullscreen = vi.fn(async () => undefined);
    const wrapper = Object.assign(document.createElement("div"), { requestFullscreen });
    const { result } = renderHook(() => useFullscreen({ current: wrapper }, { current: document.createElement("video") }));
    await act(async () => { await result.current.toggle(); });
    expect(requestFullscreen).toHaveBeenCalledOnce();
    expect(result.current.pseudo).toBe(false);
  });

  it("does not rotate a vertical lesson to landscape, but does rotate a horizontal one", async () => {
    env.platform = "other";
    const lock = vi.fn(async () => undefined);
    Object.defineProperty(screen, "orientation", { configurable: true, value: { lock, unlock: vi.fn() } });
    const requestFullscreen = vi.fn(async () => undefined);
    const wrapper = Object.assign(document.createElement("div"), { requestFullscreen });
    const video = document.createElement("video");

    Object.defineProperty(video, "videoWidth", { configurable: true, value: 720 });
    Object.defineProperty(video, "videoHeight", { configurable: true, value: 1280 });
    const { result } = renderHook(() => useFullscreen({ current: wrapper }, { current: video }));
    await act(async () => { await result.current.toggle(); });
    expect(requestFullscreen).toHaveBeenCalledOnce();
    expect(lock).not.toHaveBeenCalled();

    Object.defineProperty(video, "videoWidth", { configurable: true, value: 1280 });
    Object.defineProperty(video, "videoHeight", { configurable: true, value: 720 });
    await act(async () => { await result.current.toggle(); });
    expect(lock).toHaveBeenCalledWith("landscape");
  });
});
