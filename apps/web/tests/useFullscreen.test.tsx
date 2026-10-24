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
});
