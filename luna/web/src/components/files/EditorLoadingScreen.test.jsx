import { Suspense, lazy, useState } from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import FullscreenEditorFrame from "./FullscreenEditorFrame.jsx";
import EditorLoadingScreen, { EditorMountedSignal } from "./EditorLoadingScreen.jsx";

let finishDownload;
const LazyEditor = lazy(
  () => new Promise((resolve) => {
    finishDownload = () => resolve({
      default: function Editor() {
        const [ready, setReady] = useState(false);
        globalThis.__readyEditor = () => setReady(true);
        return ready ? <p>Editor body</p> : <EditorLoadingScreen label="Starting editor…" />;
      },
    });
  }),
);

describe("editor loading screen", () => {
  it("keeps one loader element from download through editor startup", async () => {
    render(
      <ToastProvider>
        <FullscreenEditorFrame name="Letter.docx" sessionKey="a" onClose={vi.fn()}>
          {() => (
            <Suspense fallback={null}>
              <EditorMountedSignal />
              <LazyEditor />
            </Suspense>
          )}
        </FullscreenEditorFrame>
      </ToastProvider>,
    );

    const loader = screen.getByRole("status", { name: "Opening Letter.docx" });
    await act(async () => finishDownload());
    // Same DOM node, new label: no remount, so the animation never restarts.
    expect(screen.getByRole("status", { name: "Starting editor…" })).toBe(loader);

    await act(async () => globalThis.__readyEditor());
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("Editor body")).toBeTruthy();
  });

  describe("animation lifetime", () => {
    afterEach(() => vi.restoreAllMocks());

    it("stops drawing once the loader is gone", async () => {
      // jsdom has no canvas; a stub context lets the loader start its loop.
      const ctx = new Proxy({}, { get: () => () => {}, set: () => true });
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx);
      const raf = vi.spyOn(window, "requestAnimationFrame");
      const caf = vi.spyOn(window, "cancelAnimationFrame");

      render(
        <ToastProvider>
          <FullscreenEditorFrame name="Letter.docx" sessionKey="b" onClose={vi.fn()}>
            {() => (
              <Suspense fallback={null}>
                <EditorMountedSignal />
                <LazyEditor />
              </Suspense>
            )}
          </FullscreenEditorFrame>
        </ToastProvider>,
      );
      await act(async () => finishDownload());
      expect(raf).toHaveBeenCalled();

      await act(async () => globalThis.__readyEditor());
      expect(screen.queryByRole("status")).toBeNull();
      expect(caf).toHaveBeenCalled();

      const callsAfterUnmount = raf.mock.calls.length;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      expect(raf.mock.calls.length).toBe(callsAfterUnmount);
    });
  });
});
