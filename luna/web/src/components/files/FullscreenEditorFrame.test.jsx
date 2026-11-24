import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import FullscreenEditorFrame from "./FullscreenEditorFrame.jsx";
import { collabPresenceLabel } from "./collabPresence.js";

/**
 * The chrome picks desktop or mobile from matchMedia (the test setup's stub
 * matches min-width queries, so a plain render is desktop). This flips it to
 * the phone branch, the same way FileViewer.test.jsx does. Reduced motion
 * stays off, so the pill's width animation is the code path under test.
 */
function stubPhoneViewport() {
  vi.stubGlobal("matchMedia", (query) => ({
    matches:
      !String(query).includes("min-width: 768px") &&
      !String(query).includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

/**
 * Mount the frame with a stub editor body. `api` collects the save contract
 * the frame hands its child, so a test can report dirty state and register a
 * save thunk.
 */
function renderFrame({
  canWrite = true,
  onClose = vi.fn(),
  presence = "",
  name = "Letter.docx",
  sessionKey = "session-1",
} = {}) {
  /** @type {Record<string, any>} */
  const api = {};
  const view = render(
    <ToastProvider>
      <FullscreenEditorFrame
        name={name}
        sessionKey={sessionKey}
        canWrite={canWrite}
        presence={presence}
        onClose={onClose}
      >
        {(editorApi) => {
          Object.assign(api, editorApi);
          return <div data-testid="editor-body" />;
        }}
      </FullscreenEditorFrame>
    </ToastProvider>,
  );
  return { ...view, api, onClose };
}

/** The mobile save pill's animated wrapper, or null when it isn't drawn. */
function savePill() {
  return document.querySelector('[data-slot="save-status"]');
}

/** The mobile topbar. */
function topbar() {
  return /** @type {HTMLElement} */ (document.querySelector('[data-slot="editor-topbar"]'));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FullscreenEditorFrame save pill", () => {
  it("shows exactly Saved, Unsaved or Saving… — never a clock time", () => {
    stubPhoneViewport();
    const { api } = renderFrame();

    // A clean file reads "Saved": no "just now" window, no clock time.
    expect(savePill()).toHaveTextContent(/^Saved$/);

    act(() => api.onSaveStateChange(true));
    expect(savePill()).toHaveTextContent(/^Unsaved$/);

    act(() => api.onSaveStateChange(false));
    expect(savePill()).toHaveTextContent(/^Saved$/);

    expect(savePill()?.textContent).not.toMatch(/\d{1,2}:\d{2}|just now/i);
  });

  it("reads Saving… while a save is in flight, then Saved", async () => {
    stubPhoneViewport();
    const { api, onClose } = renderFrame();

    /** @type {(value?: unknown) => void} */
    let finishSave = () => {};
    const save = vi.fn(
      () =>
        new Promise((resolve) => {
          finishSave = resolve;
        }),
    );
    act(() => api.onRegisterSave(save));
    act(() => api.onSaveStateChange(true));
    expect(savePill()).toHaveTextContent(/^Unsaved$/);

    // The phone bar has no Save button (every editor autosaves); the guard
    // modal's "Save and close" is the save path that runs the thunk here.
    await userEvent.click(within(topbar()).getByRole("button", { name: "Close editor" }));
    await userEvent.click(await screen.findByRole("button", { name: "Save and close" }));

    expect(save).toHaveBeenCalledTimes(1);
    // The thunk is still pending, so the pill holds "Saving…".
    expect(savePill()).toHaveTextContent(/^Saving…$/);

    await act(async () => finishSave(true));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the pill in the topbar, capped at 40% so a long filename still reads", () => {
    stubPhoneViewport();
    renderFrame();

    const pill = /** @type {HTMLElement} */ (savePill());
    expect(topbar()).toContainElement(pill);
    expect(pill.className).toContain("max-w-[40%]");
    expect(within(topbar()).getByText("Letter.docx")).toBeInTheDocument();
    // The status still wears the badge, and its words sit inside it.
    const badge = pill.querySelector('[data-slot="badge"]');
    expect(badge).not.toBeNull();
    expect(badge).toHaveTextContent("Saved");
  });

  it("shows a failed save's message in the pill instead of the three states", async () => {
    stubPhoneViewport();
    const { api } = renderFrame();

    act(() =>
      api.onRegisterSave(
        vi.fn(async () => {
          throw new Error("EuroOffice couldn't save this file.");
        }),
      ),
    );
    act(() => api.onSaveStateChange(true));

    await userEvent.click(within(topbar()).getByRole("button", { name: "Close editor" }));
    await userEvent.click(await screen.findByRole("button", { name: "Save and close" }));

    // An error is not a fourth state — it takes the pill's place, and the
    // guard modal stays open so the change is not lost.
    await waitFor(() =>
      expect(
        within(/** @type {HTMLElement} */ (savePill())).getByText(
          "EuroOffice couldn't save this file.",
        ),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("Document unsaved")).toBeInTheDocument();
  });

  it("hides the pill in a view-only session", () => {
    stubPhoneViewport();
    renderFrame({ canWrite: false });
    expect(savePill()).toBeNull();
    expect(within(topbar()).queryByText("Saved")).not.toBeInTheDocument();
  });
});

describe("FullscreenEditorFrame mobile bar", () => {
  it("keeps the filename, the save status and a Close button — and no menu", () => {
    stubPhoneViewport();
    renderFrame();

    const bar = within(topbar());
    expect(bar.getByText("Letter.docx")).toBeInTheDocument();
    expect(savePill()).not.toBeNull();
    expect(bar.getByRole("button", { name: "Close editor" })).toBeInTheDocument();

    // The ellipsis menu is gone: no trigger, no menu, no "Editor options".
    expect(screen.queryByRole("button", { name: "Editor options" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
  });

  it("closes through the unsaved-changes guard from the Close button", async () => {
    stubPhoneViewport();
    const { api, onClose } = renderFrame();

    act(() => api.onSaveStateChange(true));
    await userEvent.click(within(topbar()).getByRole("button", { name: "Close editor" }));

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Document unsaved")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Close anyway" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes straight away when there is nothing unsaved", async () => {
    stubPhoneViewport();
    const { onClose } = renderFrame();

    await userEvent.click(within(topbar()).getByRole("button", { name: "Close editor" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Document unsaved")).not.toBeInTheDocument();
  });
});

describe("FullscreenEditorFrame desktop rail", () => {
  it("keeps the book-spine rail with Save, Close and the filename", () => {
    renderFrame();

    const rail = /** @type {HTMLElement} */ (document.querySelector('[data-slot="editor-rail"]'));
    expect(rail).toBeInTheDocument();
    expect(within(rail).getByText("Letter.docx")).toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: "Close editor" })).toBeInTheDocument();
    // The phone bar (and its pill) is not drawn on desktop.
    expect(document.querySelector('[data-slot="editor-topbar"]')).not.toBeInTheDocument();
    expect(savePill()).toBeNull();
  });

  it("shows the full filename in the shared tooltip, not a native title", async () => {
    renderFrame();

    const rail = /** @type {HTMLElement} */ (document.querySelector('[data-slot="editor-rail"]'));
    const filename = within(rail).getByText("Letter.docx");
    expect(filename).not.toHaveAttribute("title");
    await userEvent.hover(filename);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Letter.docx");
  });

  it("puts the save state in the Save button's tooltip", async () => {
    const { api } = renderFrame();

    // Register a save thunk first: without one the button stays disabled and
    // a disabled button cannot take focus to open its tooltip.
    act(() => api.onRegisterSave(vi.fn(async () => true)));
    act(() => api.onSaveStateChange(true));

    const saveButton = screen.getByRole("button", { name: "Save" });
    expect(saveButton).toBeEnabled();

    // Tooltip opens on *keyboard* focus only — mouse focus must never pop a
    // hint — and it decides that from the last input modality, so a bare
    // .focus() is deliberately not enough. Press a key first, as a person
    // tabbing to the button would.
    fireEvent.keyDown(document, { key: "Tab" });
    act(() => saveButton.focus());
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Unsaved");
  });
});

describe("FullscreenEditorFrame Ctrl+S", () => {
  it("saves instead of opening the browser's Save page dialog, even from a typing field", async () => {
    const { api } = renderFrame();
    const save = vi.fn(async () => true);
    act(() => api.onRegisterSave(save));
    act(() => api.onSaveStateChange(true));

    // Dispatch from a text field: CodeMirror's keymap is not allowed to win
    // this key, so the frame's capture listener has to catch it first.
    const field = document.createElement("textarea");
    document.body.appendChild(field);
    const event = new KeyboardEvent("keydown", {
      key: "s", ctrlKey: true, bubbles: true, cancelable: true,
    });
    act(() => field.dispatchEvent(event));
    field.remove();

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  });

  it("does the same for Cmd+S", async () => {
    const { api } = renderFrame();
    const save = vi.fn(async () => true);
    act(() => api.onRegisterSave(save));

    const event = new KeyboardEvent("keydown", {
      key: "S", metaKey: true, bubbles: true, cancelable: true,
    });
    act(() => window.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  });

  it("lets only the topmost editor save when one is opened over another", async () => {
    // A database editor opened from a form: both frames listen on window in
    // capture phase, so the parent must bow out before stopping the key.
    const parent = renderFrame({ name: "Form.form", sessionKey: "parent" });
    const child = renderFrame({ name: "Data.db", sessionKey: "child" });
    const parentSave = vi.fn(async () => true);
    const childSave = vi.fn(async () => true);
    act(() => parent.api.onRegisterSave(parentSave));
    act(() => child.api.onRegisterSave(childSave));

    const overlays = document.querySelectorAll('[data-slot="file-viewer-overlay"]');
    expect(overlays).toHaveLength(2);

    const event = new KeyboardEvent("keydown", {
      key: "s", ctrlKey: true, bubbles: true, cancelable: true,
    });
    act(() => window.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(childSave).toHaveBeenCalledTimes(1));
    expect(parentSave).not.toHaveBeenCalled();
  });
});

describe("FullscreenEditorFrame presence", () => {
  it("draws the presence line in the desktop rail", () => {
    renderFrame({ presence: "Live · Sam" });
    const rail = /** @type {HTMLElement} */ (document.querySelector('[data-slot="editor-rail"]'));
    expect(within(rail).getByText("Live · Sam")).toBeInTheDocument();
  });

  it("draws the presence line in the mobile topbar", () => {
    stubPhoneViewport();
    renderFrame({ presence: "Live · only you" });
    expect(within(topbar()).getByText("Live · only you")).toBeInTheDocument();
  });

  it("banners an offline presence line instead of hiding it in a tooltip", () => {
    const offline = collabPresenceLabel("collab-offline", [], true);
    renderFrame({ presence: offline });
    const banner = document.querySelector('[data-slot="editor-presence-banner"]');
    expect(banner).toHaveTextContent(offline);
  });

  it("shows the offline line once on mobile — in the banner, not the topbar", () => {
    stubPhoneViewport();
    const offline = collabPresenceLabel("collab-offline", [], true);
    renderFrame({ presence: offline });
    expect(document.querySelector('[data-slot="editor-presence-banner"]')).toHaveTextContent(
      offline,
    );
    expect(topbar().querySelector('[data-slot="editor-presence"]')).toBeNull();
  });

  it("does not banner a failed open, which reports no presence", () => {
    // "error" also covers a bad file type, a start timeout and a crash. The
    // error card says what happened; a "changes still save" banner would lie.
    renderFrame({ presence: collabPresenceLabel("error", [], true) });
    expect(document.querySelector('[data-slot="editor-presence-banner"]')).toBeNull();
  });
});
