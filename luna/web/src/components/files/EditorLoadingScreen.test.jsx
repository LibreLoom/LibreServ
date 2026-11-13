import { Suspense, lazy, useState } from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import FullscreenEditorFrame from "./FullscreenEditorFrame.jsx";
import EditorLoadingScreen, { EditorMountedSignal } from "./EditorLoadingScreen.jsx";

let finishDownload;
const LazyEditor = lazy(
  () =>
    new Promise(
      /** @param {(value: { default: () => import("react").JSX.Element }) => void} resolve */
      (resolve) => {
        finishDownload = () => resolve({
          default: function Editor() {
            const [ready, setReady] = useState(false);
            globalThis.__readyEditor = () => setReady(true);
            return ready ? <p>Editor body</p> : <EditorLoadingScreen label="Starting editor…" />;
          },
        });
      },
    ),
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
    const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, "animate");
    afterEach(() => {
      vi.restoreAllMocks();
      if (originalAnimate) Object.defineProperty(Element.prototype, "animate", originalAnimate);
      else Reflect.deleteProperty(Element.prototype, "animate");
    });

    it("stops drawing once the loader is gone", async () => {
      // jsdom does not implement the Web Animations API.
      const cancel = vi.fn();
      const animate = vi.fn(() => ({ currentTime: 0, cancel }));
      Object.defineProperty(Element.prototype, "animate", { configurable: true, value: animate });

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
      expect(animate).toHaveBeenCalled();

      await act(async () => globalThis.__readyEditor());
      expect(screen.queryByRole("status")).toBeNull();
      expect(cancel).toHaveBeenCalled();

      const callsAfterUnmount = animate.mock.calls.length;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      expect(animate.mock.calls.length).toBe(callsAfterUnmount);
    });
  });
});
