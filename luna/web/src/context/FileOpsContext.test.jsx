import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";

import { createFileOpsStore } from "../lib/fileOps/store.js";
import { FileOpsProvider, useFileOps, useFileOpsState } from "./FileOpsContext.jsx";

function Probe() {
  const ops = useFileOps();
  const count = useFileOpsState((state) => state.ops.length);
  return (
    <div className="surface-primary">
      <p>{`${count} tasks`}</p>
      <button
        type="button"
        onClick={() => ops.startRequest({ kind: "purge", title: "a.txt", run: () => new Promise(() => {}) })}
      >
        Start
      </button>
    </div>
  );
}

function renderWithProviders(ui) {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}

describe("FileOpsProvider", () => {
  it("gives components the actions and the state", () => {
    renderWithProviders(
      <FileOpsProvider>
        <Probe />
      </FileOpsProvider>,
    );
    expect(screen.getByText("0 tasks")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(screen.getByText("1 tasks")).toBeTruthy();
  });

  it("keeps the same store across re-renders", () => {
    let seen = [];
    function Grab() {
      seen.push(useFileOps());
      return null;
    }
    const { rerender } = renderWithProviders(
      <FileOpsProvider>
        <Grab />
      </FileOpsProvider>,
    );
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <FileOpsProvider>
            <Grab />
          </FileOpsProvider>
        </ToastProvider>
      </QueryClientProvider>,
    );
    expect(seen.length).toBeGreaterThan(1);
    expect(new Set(seen).size).toBe(1);
  });

  it("asks the browser before leaving only while work would be lost", () => {
    const store = createFileOpsStore({ queryClient: { invalidateQueries: vi.fn() }, addToast: vi.fn(), storage: null });
    renderWithProviders(
      <FileOpsProvider store={store}>
        <Probe />
      </FileOpsProvider>,
    );
    const leave = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(leave()).toBe(false);
    act(() => {
      // Two items: the second is still waiting to be sent, so leaving would drop it.
      store.startRequest({
        kind: "purge",
        items: [
          { name: "a", run: () => new Promise(() => {}) },
          { name: "b", run: async () => {} },
        ],
      });
    });
    expect(store.hasBrowserWork()).toBe(true);
    expect(leave()).toBe(true);
  });

  it("sends keepalive DELETEs for open chunked sessions on pagehide", () => {
    /** @type {any} */
    const store = {
      ...createFileOpsStore({ queryClient: { invalidateQueries: vi.fn() }, addToast: vi.fn(), storage: null }),
      openUploadSessions: () => [
        { source: { cancelUploadUrl: (id) => ({ url: `/api/v1/uploads/${id}`, headers: {} }) }, driveId: "d", uploadId: "u1" },
        { source: { cancelUploadUrl: (id) => ({ url: `/s/tok/upload/${id}`, headers: { "X-Share-Password": "pw" } }) }, driveId: "tok", uploadId: "u2" },
      ],
    };
    /** @type {any} */
    const fetchMock = vi.fn(async (..._args) => ({}));
    vi.stubGlobal("fetch", fetchMock);
    renderWithProviders(
      <FileOpsProvider store={store}>
        <Probe />
      </FileOpsProvider>,
    );
    window.dispatchEvent(new Event("pagehide"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/uploads/u1");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "DELETE", keepalive: true });
    expect(fetchMock.mock.calls[1][1].headers["X-Share-Password"]).toBe("pw");
    vi.unstubAllGlobals();
  });

  it("throws a clear error outside the provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/FileOpsProvider/);
    spy.mockRestore();
  });
});
