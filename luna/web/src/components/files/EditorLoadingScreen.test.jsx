import { Suspense, lazy, useState } from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import FullscreenEditorFrame from "./FullscreenEditorFrame.jsx";
import EditorLoadingScreen, { EditorMountedSignal } from "./EditorLoadingScreen.jsx";

function createLazyEditor() {
  let finishDownload;
  let markEditorReady;
  const LazyEditor = lazy(
    () =>
      new Promise(
        /** @param {(value: { default: () => import("react").JSX.Element }) => void} resolve */
        (resolve) => {
          finishDownload = () => resolve({
            default: function Editor() {
              const [ready, setReady] = useState(false);
              markEditorReady = () => setReady(true);
              return ready ? <p>Editor body</p> : <EditorLoadingScreen label="Starting editor…" />;
            },
          });
        },
      ),
  );

  return {
    LazyEditor,
    finishDownload: () => finishDownload(),
    markEditorReady: () => markEditorReady(),
  };
}

describe("editor loading screen", () => {
  it("keeps one loader element from download through editor startup", async () => {
    const editor = createLazyEditor();
    const LazyEditor = editor.LazyEditor;
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
    await act(async () => editor.finishDownload());
    // Same DOM node, new label: no remount, so the animation never restarts.
    expect(screen.getByRole("status", { name: "Starting editor…" })).toBe(loader);

    await act(async () => editor.markEditorReady());
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("Editor body")).toBeTruthy();
  });

  describe("animation lifetime", () => {
    let restoreAnimate;

    afterEach(() => {
      vi.restoreAllMocks();
      restoreAnimate?.();
      restoreAnimate = undefined;
    });

    it("cancels the loading animation when editor startup completes", async () => {
      const editor = createLazyEditor();
      const LazyEditor = editor.LazyEditor;
      const animateDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
      const cancel = vi.fn();
      const animate = vi.fn(() => ({ cancel, currentTime: 0 }));
      Object.defineProperty(HTMLElement.prototype, "animate", {
        configurable: true,
        writable: true,
        value: animate,
      });
      restoreAnimate = () => {
        if (animateDescriptor) {
          Object.defineProperty(HTMLElement.prototype, "animate", animateDescriptor);
        } else {
          delete HTMLElement.prototype.animate;
        }
      };

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
      expect(animate).toHaveBeenCalled();

      const loader = screen.getByRole("status", { name: "Opening Letter.docx" });
      await act(async () => editor.finishDownload());
      expect(screen.getByRole("status", { name: "Starting editor…" })).toBe(loader);
      expect(animate).toHaveBeenCalledTimes(1);
      expect(cancel).not.toHaveBeenCalled();

      await act(async () => editor.markEditorReady());
      expect(screen.queryByRole("status")).toBeNull();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(animate).toHaveBeenCalledTimes(1);

      const callsAfterUnmount = animate.mock.calls.length;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      expect(animate).toHaveBeenCalledTimes(callsAfterUnmount);
    });
  });
});
