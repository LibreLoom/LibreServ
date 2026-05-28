import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useScriptStream } from "./useScriptStream.jsx";

let onopen, onmessage, onerror;

function createMockEventSource() {
  let closed = false;

  // @ts-ignore
  const MockEventSource = class {
    constructor() {
      this.close = () => { closed = true; };
      this.readyState = 0;
    }
    get onopen() { return onopen; }
    set onopen(fn) { onopen = fn; }
    get onmessage() { return onmessage; }
    set onmessage(fn) { onmessage = fn; }
    get onerror() { return onerror; }
    set onerror(fn) { onerror = fn; }
  };
  MockEventSource.CONNECTING = 0;
  MockEventSource.OPEN = 1;
  MockEventSource.CLOSED = 2;
  // @ts-expect-error — mock doesn't match EventSource constructor signature
  globalThis.EventSource = MockEventSource;

  const triggerOpen = () => { if (onopen) onopen(); };
  const triggerMessage = (data) => { if (onmessage) onmessage({ data: JSON.stringify(data) }); };
  const triggerError = () => { if (onerror) onerror(new Event("error")); };

  return { triggerOpen, triggerMessage, triggerError, getClosed: () => closed };
}

describe("useScriptStream", () => {
  let mock;

  beforeEach(() => {
    vi.restoreAllMocks();
    mock = createMockEventSource();
  });

  afterEach(() => {
    delete globalThis.EventSource;
    onopen = null;
    onmessage = null;
    onerror = null;
  });

  it("starts with idle status", () => {
    const { result } = renderHook(() => useScriptStream());
    expect(result.current.status).toBe("idle");
    expect(result.current.lines).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(result.current.exitCode).toBeNull();
  });

  it("connects and transitions to streaming", () => {
    const { result } = renderHook(() => useScriptStream());
    act(() => result.current.connect("/test/stream"));
    expect(result.current.status).toBe("connecting");

    act(() => mock.triggerOpen());
    expect(result.current.status).toBe("streaming");
  });

  it("receives lines via onmessage", () => {
    const { result } = renderHook(() => useScriptStream());
    act(() => result.current.connect("/test/stream"));
    act(() => mock.triggerOpen());

    act(() => mock.triggerMessage({ type: "line", text: "hello" }));
    expect(result.current.lines).toHaveLength(1);
    expect(result.current.lines[0].text).toBe("hello");
  });

  it("handles complete message with success exit code", () => {
    const { result } = renderHook(() => useScriptStream());
    act(() => result.current.connect("/test/stream"));
    act(() => mock.triggerMessage({ type: "complete", exit_code: 0 }));
    expect(result.current.status).toBe("complete");
    expect(result.current.exitCode).toBe(0);
  });

  it("handles complete message with error exit code", () => {
    const { result } = renderHook(() => useScriptStream());
    act(() => result.current.connect("/test/stream"));
    act(() => mock.triggerMessage({ type: "complete", exit_code: 1 }));
    expect(result.current.status).toBe("error");
    expect(result.current.exitCode).toBe(1);
  });

  it("handles error message type", () => {
    const { result } = renderHook(() => useScriptStream());
    act(() => result.current.connect("/test/stream"));
    act(() => mock.triggerMessage({ type: "error", error: "Something broke" }));
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("Something broke");
  });

  it("handles connection error", () => {
    const { result } = renderHook(() => useScriptStream());
    act(() => result.current.connect("/test/stream"));
    act(() => mock.triggerError());
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("Connection to server lost");
  });

  it("disconnect closes EventSource", () => {
    const { result } = renderHook(() => useScriptStream());
    act(() => result.current.connect("/test/stream"));
    act(() => result.current.disconnect());
    expect(mock.getClosed()).toBe(true);
  });

  it("reconnect resets state and creates new EventSource", () => {
    const { result } = renderHook(() => useScriptStream());
    act(() => result.current.connect("/first"));
    act(() => mock.triggerOpen());
    act(() => mock.triggerMessage({ type: "line", text: "data" }));
    expect(result.current.lines).toHaveLength(1);

    createMockEventSource();
    act(() => result.current.connect("/second"));
    expect(result.current.lines).toEqual([]);
    expect(result.current.status).toBe("connecting");
  });
});
