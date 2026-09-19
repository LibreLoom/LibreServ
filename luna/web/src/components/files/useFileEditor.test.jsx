import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { CollabDocSync } from "./collabDocSync.js";
import { useFileEditor, runMarkdownAction } from "./useFileEditor.js";
import { tableControllers } from "./markdownTables.js";
import MarkdownEditor from "./MarkdownEditor.jsx";

/** Minimal host using the shared editor mount, like PlainTextSurface. */
function Surface({ sync, canWrite = true }) {
  const { attachHost } = useFileEditor({
    ytext: sync.ytext,
    awareness: sync.awareness,
    canWrite,
    markdown: true,
    livePreview: true,
    ariaLabel: "Contents",
  });
  return <div ref={attachHost} data-slot="markdown-editor-surface" />;
}

function cmText() {
  const host = document.querySelector("[data-slot$='-editor-surface']");
  if (!host) throw new Error("no editor surface mounted");
  return /** @type {any} */ (host).__cmView.state.doc.toString();
}

function makeSync() {
  // No socket injection needed — the doc works standalone offline.
  return new CollabDocSync({ driveId: "d1", path: "a.md" });
}

describe("useFileEditor", () => {
  it("renders content already in the shared doc when the view mounts late", () => {
    const sync = makeSync();
    sync.ytext.insert(0, "# already here\n\nbody text");
    render(<Surface sync={sync} />);
    expect(cmText()).toBe("# already here\n\nbody text");
  });

  it("keeps the document across an unmount/remount (Read → Write flip)", () => {
    const sync = makeSync();
    const { unmount } = render(<Surface sync={sync} />);
    sync.ytext.insert(0, "persisted");
    expect(cmText()).toBe("persisted");
    unmount();
    render(<Surface sync={sync} />);
    expect(cmText()).toBe("persisted");
  });

  it("renders a markdown table as the interactive grid widget", async () => {
    const sync = makeSync();
    sync.ytext.insert(0, "intro\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n");
    render(<Surface sync={sync} />);
    // The parse finishes off the first frame — wait for the widget.
    await vi.waitFor(() => {
      if (!document.querySelector(".cm-lp-table")) {
        throw new Error("table widget not rendered yet");
      }
    });
    expect(cmText()).toContain("| A | B |");
  });

  function cmView() {
    const host = document.querySelector("[data-slot$='-editor-surface']");
    return /** @type {any} */ (host).__cmView;
  }

  async function mountedTable(sync) {
    render(<Surface sync={sync} />);
    await vi.waitFor(() => {
      if (!document.querySelector(".md-table-grid")) {
        throw new Error("table grid not rendered yet");
      }
    });
    const view = cmView();
    const [ctrl] = tableControllers(view);
    if (!ctrl) throw new Error("no table controller");
    return { view, ctrl };
  }

  it("grid structural edits undo and redo through the shared Yjs undo manager", async () => {
    const sync = makeSync();
    sync.ytext.insert(0, "intro\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n");
    const { ctrl } = await mountedTable(sync);

    ctrl.appendRow();
    expect(cmText()).toContain("| 1 | 2 |\n|  |  |");

    // The Yjs UndoManager useFileEditor wired in — not CM history.
    ctrl.undoManager.undo();
    await vi.waitFor(() => {
      if (cmText().includes("|  |  |")) throw new Error("undo not applied");
    });
    ctrl.undoManager.redo();
    await vi.waitFor(() => {
      if (!cmText().includes("| 1 | 2 |\n|  |  |")) {
        throw new Error("redo not applied");
      }
    });
  });

  it("formatting actions route into the focused table cell, not the document", async () => {
    const sync = makeSync();
    sync.ytext.insert(0, "para\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n");
    const { view, ctrl } = await mountedTable(sync);

    ctrl.select({ r: 1, c: 0 });
    runMarkdownAction(view, "bold");
    expect(cmText()).toContain("| **1** | 2 |");

    // Block-level actions are refused inside the grid — paragraph untouched.
    runMarkdownAction(view, "heading");
    expect(cmText()).not.toContain("##");
  });

  it("losing write permission mid-draft keeps the draft without writing", async () => {
    const sync = makeSync();
    sync.ytext.insert(0, "intro\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n");
    const { rerender } = render(<Surface sync={sync} canWrite />);
    await vi.waitFor(() => {
      if (!document.querySelector(".md-table-grid")) {
        throw new Error("table grid not rendered yet");
      }
    });
    const view = cmView();
    const [ctrl] = tableControllers(view);
    ctrl.startEdit(1, 0);
    ctrl.setDraft("mine");

    rerender(<Surface sync={sync} canWrite={false} />);
    await vi.waitFor(() => {
      if (ctrl.editable) throw new Error("still editable");
    });
    // No write happened — the draft stays buffered, read-only and copyable.
    expect(sync.ytext.toString()).not.toContain("mine");
    expect(ctrl.draft?.text).toBe("mine");
    const ta = /** @type {HTMLTextAreaElement | null} */ (
      document.querySelector("textarea.md-table-editor")
    );
    expect(ta?.readOnly).toBe(true);
  });

  it("a remote table deletion surfaces the draft in the editor recovery panel", async () => {
    const sync = makeSync();
    sync.ytext.insert(0, "| A |\n| --- |\n| 1 |\n");
    render(
      <MarkdownEditor
        sync={sync}
        driveId="d1"
        path="a.md"
        name="a.md"
        mode="write"
      />,
    );
    await vi.waitFor(() => {
      if (!document.querySelector(".md-table-grid")) {
        throw new Error("table grid not rendered yet");
      }
    });
    const host = document.querySelector("[data-slot='markdown-editor-surface']");
    const [ctrl] = tableControllers(/** @type {any} */ (host).__cmView);
    ctrl.startEdit(1, 0);
    ctrl.setDraft("rescue me");
    // A peer deletes the whole table — no new grid ever mounts.
    sync.ytext.delete(0, sync.ytext.length);
    await vi.waitFor(() => {
      const ta = /** @type {HTMLTextAreaElement | null} */ (
        screen.queryByLabelText("Recovered cell text")
      );
      if (!ta || ta.value !== "rescue me") {
        throw new Error("recovered draft not shown");
      }
    });
    expect(document.querySelector(".md-table-grid")).toBeNull();
    expect(sync.ytext.toString()).toBe("");
  });

  it("a Write→Read flip with a live draft surfaces it in the recovery panel", async () => {
    const sync = makeSync();
    sync.ytext.insert(0, "| A |\n| --- |\n| 1 |\n");
    const { rerender } = render(
      <MarkdownEditor
        sync={sync}
        driveId="d1"
        path="a.md"
        name="a.md"
        mode="write"
      />,
    );
    await vi.waitFor(() => {
      if (!document.querySelector(".md-table-grid")) {
        throw new Error("table grid not rendered yet");
      }
    });
    const host = document.querySelector("[data-slot='markdown-editor-surface']");
    const [ctrl] = tableControllers(/** @type {any} */ (host).__cmView);
    ctrl.startEdit(1, 0);
    ctrl.setDraft("keep me");
    rerender(
      <MarkdownEditor
        sync={sync}
        driveId="d1"
        path="a.md"
        name="a.md"
        mode="read"
      />,
    );
    await vi.waitFor(() => {
      const ta = /** @type {HTMLTextAreaElement | null} */ (
        screen.queryByLabelText("Recovered cell text")
      );
      if (!ta || ta.value !== "keep me") {
        throw new Error("recovered draft not shown in Read mode");
      }
    });
    // The draft was never committed into the document.
    expect(sync.ytext.toString()).not.toContain("keep me");
  });

  it("a refused clipboard write keeps the recovered text on screen", async () => {
    const sync = makeSync();
    sync.ytext.insert(0, "| A |\n| --- |\n| 1 |\n");
    render(
      <MarkdownEditor
        sync={sync}
        driveId="d1"
        path="a.md"
        name="a.md"
        mode="write"
      />,
    );
    await vi.waitFor(() => {
      if (!document.querySelector(".md-table-grid")) {
        throw new Error("table grid not rendered yet");
      }
    });
    const host = document.querySelector("[data-slot='markdown-editor-surface']");
    const [ctrl] = tableControllers(/** @type {any} */ (host).__cmView);
    ctrl.startEdit(1, 0);
    ctrl.setDraft("keep me");
    sync.ytext.delete(0, sync.ytext.length);
    await vi.waitFor(() => {
      if (!screen.queryByLabelText("Recovered cell text")) {
        throw new Error("recovered draft not shown");
      }
    });
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("denied")) },
    });
    try {
      fireEvent.click(screen.getByRole("button", { name: "Copy text" }));
      await new Promise((r) => setTimeout(r, 20));
      const ta = /** @type {HTMLTextAreaElement | null} */ (
        screen.queryByLabelText("Recovered cell text")
      );
      expect(ta?.value).toBe("keep me");
    } finally {
      delete /** @type {any} */ (window.navigator).clipboard;
    }
  });
});

describe("heading level dropdown", () => {
  /** @param {CollabDocSync} sync @param {object} [props] */
  function mountEditor(sync, props = {}) {
    render(
      <MarkdownEditor
        sync={sync}
        driveId="d1"
        path="a.md"
        name="a.md"
        mode="write"
        {...props}
      />,
    );
    const host = document.querySelector(
      "[data-slot='markdown-editor-surface']",
    );
    return /** @type {any} */ (host).__cmView;
  }

  it("renders the heading trigger as an icon button with a tooltip", async () => {
    const sync = makeSync();
    sync.ytext.insert(0, "Title\n\nbody");
    mountEditor(sync);
    const trigger = screen.getByRole("button", { name: "Heading level" });
    expect(trigger.querySelector("svg")).toBeTruthy();
    expect(trigger.textContent).toBe("");
    const wrap = trigger.closest("[data-slot='tooltip']");
    expect(wrap).toBeTruthy();
    fireEvent.pointerOver(/** @type {Element} */ (wrap));
    await vi.waitFor(() => {
      const popup = document.querySelector("[data-slot='tooltip-popup']");
      if (!popup || popup.textContent !== "Heading") {
        throw new Error("heading tooltip not shown");
      }
    });
  });

  it.each([1, 2, 3, 4, 5, 6])(
    "Heading %i applies through the toolbar menu and refocuses",
    async (level) => {
      const sync = makeSync();
      sync.ytext.insert(0, "Title\n\nbody");
      const view = mountEditor(sync);
      view.dispatch({ selection: { anchor: 0, head: 5 } });
      fireEvent.click(screen.getByRole("button", { name: "Heading level" }));
      await vi.waitFor(() => {
        for (let n = 1; n <= 6; n += 1) {
          if (!screen.queryByRole("option", { name: `Heading ${n} (H${n})` })) {
            throw new Error(`missing option H${n}`);
          }
        }
      });
      fireEvent.click(
        screen.getByRole("option", { name: `Heading ${level} (H${level})` }),
      );
      const marker = `${"#".repeat(level)} `;
      await vi.waitFor(() => {
        if (!sync.ytext.toString().startsWith(`${marker}Title`)) {
          throw new Error("heading not applied");
        }
        if (!view.hasFocus) throw new Error("editor not refocused");
      });
      const sel = view.state.selection.main;
      expect(view.state.sliceDoc(sel.from, sel.to)).toBe("Title");
    },
  );

  it("keyboard: arrows pick a level, Escape alone edits nothing", async () => {
    const sync = makeSync();
    sync.ytext.insert(0, "Title\n\nbody");
    const view = mountEditor(sync);
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    const trigger = screen.getByRole("button", { name: "Heading level" });
    trigger.focus();
    fireEvent.click(trigger);
    await vi.waitFor(() => {
      if (!document.querySelector("[data-slot='dropdown-menu']")) {
        throw new Error("menu not open");
      }
    });
    for (let i = 0; i < 3; i += 1) {
      fireEvent.keyDown(trigger, { key: "ArrowDown" });
    }
    fireEvent.keyDown(trigger, { key: "Enter" });
    await vi.waitFor(() => {
      if (!sync.ytext.toString().startsWith("### Title")) {
        throw new Error("H3 not applied");
      }
    });
    await vi.waitFor(() => {
      expect(document.querySelector("[data-slot='dropdown-menu']")).toBeNull();
    });
    fireEvent.click(trigger);
    await vi.waitFor(() => {
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      expect(
        screen.getByRole("option", { name: "Heading 6 (H6)" }),
      ).toBeTruthy();
    });
    fireEvent.keyDown(document, { key: "Escape" });
    await vi.waitFor(() => {
      if (document.querySelector("[data-slot='dropdown-menu']")) {
        throw new Error("menu still open");
      }
    });
    expect(sync.ytext.toString()).toBe("### Title\n\nbody");
  });

  it("is hidden in Read mode and when canWrite is false", () => {
    const sync = makeSync();
    sync.ytext.insert(0, "Title\n\nbody");
    const { rerender } = render(
      <MarkdownEditor
        sync={sync}
        driveId="d1"
        path="a.md"
        name="a.md"
        mode="read"
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Heading level" }),
    ).toBeNull();
    rerender(
      <MarkdownEditor
        sync={sync}
        driveId="d1"
        path="a.md"
        name="a.md"
        mode="write"
        canWrite={false}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Heading level" }),
    ).toBeNull();
  });

  it("Source mode still offers the menu and shows raw syntax", async () => {
    const sync = makeSync();
    sync.ytext.insert(0, "Title\n\nbody");
    const view = mountEditor(sync, { mode: "source" });
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    fireEvent.click(screen.getByRole("button", { name: "Heading level" }));
    await vi.waitFor(() => {
      if (!screen.queryByRole("option", { name: "Heading 2 (H2)" })) {
        throw new Error("menu not open");
      }
    });
    fireEvent.click(screen.getByRole("option", { name: "Heading 2 (H2)" }));
    await vi.waitFor(() => {
      if (!sync.ytext.toString().startsWith("## Title")) {
        throw new Error("heading not applied");
      }
    });
    expect(view.dom.querySelector(".cm-lp-h2")).toBeNull();
    expect(view.dom.textContent).toContain("## Title");
  });

  it("heading levels are refused inside an active table grid", async () => {
    const sync = makeSync();
    sync.ytext.insert(0, "intro\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n");
    const view = mountEditor(sync);
    await vi.waitFor(() => {
      if (!document.querySelector(".md-table-grid")) {
        throw new Error("table grid not rendered yet");
      }
    });
    const [ctrl] = tableControllers(view);
    ctrl.select({ r: 1, c: 0 });
    ctrl.startEdit(1, 0);
    ctrl.setDraft("unfinished");
    await vi.waitFor(() => {
      expect(view.dom.querySelector("textarea.md-table-editor")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Heading level" }));
    fireEvent.click(
      await screen.findByRole("option", { name: "Heading 6 (H6)" }),
    );
    await vi.waitFor(() => {
      expect(view.dom.querySelector(".md-table-note")?.textContent).toContain(
        "isn't available inside a table",
      );
    });
    expect(cmText()).toBe(
      "intro\n\n| A | B |\n| --- | --- |\n| unfinished | 2 |\n",
    );
    expect(ctrl.draft).toBeNull();
  });
});

describe("live preview heading marks", () => {
  /** @param {string} source */
  function mountSurface(source) {
    const sync = makeSync();
    sync.ytext.insert(0, source);
    render(<Surface sync={sync} />);
    const host = document.querySelector(
      "[data-slot='markdown-editor-surface']",
    );
    return /** @type {any} */ (host).__cmView;
  }

  it.each([1, 2, 3, 4, 5, 6])(
    "h%i hides hashes and separator space while inactive, reveals them when active",
    async (n) => {
      const source = `${"#".repeat(n)} Title\n\nbody`;
      const view = mountSurface(source);
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      await vi.waitFor(() => {
        const h = view.dom.querySelector(`.cm-lp-h${n}`);
        if (!h || h.textContent !== "Title") {
          throw new Error(`inactive render: ${JSON.stringify(h?.textContent)}`);
        }
      });
      expect(cmText()).toBe(source);
      view.dispatch({ selection: { anchor: 1 } });
      await vi.waitFor(() => {
        const h = view.dom.querySelector(`.cm-lp-h${n}`);
        if (!h || !h.textContent.includes(`${"#".repeat(n)} Title`)) {
          throw new Error("syntax not revealed on the active line");
        }
      });
    },
  );

  it("inactive indented heading with closing marks renders only the title", async () => {
    const view = mountSurface("  ##    Title ##  \n\nbody");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    await vi.waitFor(() => {
      const h = view.dom.querySelector(".cm-lp-h2");
      if (!h || h.textContent !== "Title") {
        throw new Error(`got ${JSON.stringify(h?.textContent)}`);
      }
    });
  });

  it("a tab after the marker is still a heading; tab hides with the mark", async () => {
    const view = mountSurface("## \tTitle\n\nbody");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    await vi.waitFor(() => {
      const h = view.dom.querySelector(".cm-lp-h2");
      if (!h || h.textContent !== "Title") {
        throw new Error(`got ${JSON.stringify(h?.textContent)}`);
      }
    });
  });

  it("an empty closing-hash heading shows no text and no decoration errors", async () => {
    const view = mountSurface("## ###\n\nbody");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    await vi.waitFor(() => {
      const h = view.dom.querySelector(".cm-lp-h2");
      if (!h) throw new Error("no heading line");
    });
    expect(view.dom.querySelector(".cm-lp-h2")?.textContent).toBe("");
  });

  it("'#tag' is a paragraph, not a heading", async () => {
    const view = mountSurface("#tag\n\nbody");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    await new Promise((r) => setTimeout(r, 30));
    expect(view.dom.querySelector(".cm-lp-h1")).toBeNull();
    expect(view.dom.textContent).toContain("#tag");
  });

  it("Setext headings still render their title", async () => {
    const view = mountSurface("Title\n---\n\nbody");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    await vi.waitFor(() => {
      const h = view.dom.querySelector(".cm-lp-h2");
      if (!h || h.textContent !== "Title") {
        throw new Error(`got ${JSON.stringify(h?.textContent)}`);
      }
    });
  });
});

describe("insert table dialog", () => {
  /** @param {CollabDocSync} sync */
  function mountEditor(sync) {
    render(
      <MarkdownEditor
        sync={sync}
        driveId="d1"
        path="a.md"
        name="a.md"
        mode="write"
      />,
    );
    const host = document.querySelector(
      "[data-slot='markdown-editor-surface']",
    );
    return /** @type {any} */ (host).__cmView;
  }

  it("renders its overlay above the fullscreen file viewer (z-[80])", async () => {
    const sync = makeSync();
    sync.ytext.insert(0, "Hello\n\nbody text");
    mountEditor(sync);
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    await screen.findByRole("dialog");
    const overlay = document.querySelector("[data-slot='dialog-overlay']");
    // Without the nested overlay class the default z-50 portal sits under
    // the z-[80] editor frame — the dialog paints but real clicks land on
    // the editor, so "Insert" never fires.
    expect(overlay?.className).toContain("z-[90]");
  });

  it("clicking Insert writes a pipe table, mounts the grid, selects the first cell", async () => {
    const sync = makeSync();
    sync.ytext.insert(0, "Hello\n\nbody text");
    const view = mountEditor(sync);
    view.dispatch({ selection: { anchor: 5 } });
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Insert" }));
    await vi.waitFor(() => {
      if (!sync.ytext.toString().includes("| --- |")) {
        throw new Error(`no table inserted: ${sync.ytext.toString()}`);
      }
    });
    await vi.waitFor(() => {
      if (!view.dom.querySelector(".md-table-grid")) {
        throw new Error("table grid not rendered");
      }
    });
    const [ctrl] = tableControllers(view);
    expect(ctrl.getSnapshot().sel).toMatchObject({
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
    });
  });
});

describe("dock Delete through shared Yjs undo", () => {
  it("menu row deletion undoes and redoes with prose intact", async () => {
    const sync = makeSync();
    sync.ytext.insert(
      0,
      "intro\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nafter",
    );
    render(
      <MarkdownEditor
        sync={sync}
        driveId="d1"
        path="a.md"
        name="a.md"
        mode="write"
      />,
    );
    const host = document.querySelector(
      "[data-slot='markdown-editor-surface']",
    );
    const view = /** @type {any} */ (host).__cmView;
    await vi.waitFor(() => {
      if (!document.querySelector(".md-table-grid")) {
        throw new Error("table grid not rendered yet");
      }
    });
    const [ctrl] = tableControllers(view);
    ctrl.select({ r: 1, c: 0 }, { r: 1, c: 1 });
    const host2 = document.querySelector(
      "[data-slot='markdown-editor-surface'] .md-table-dock",
    );
    if (!(host2 instanceof HTMLElement)) throw new Error("no dock");
    const dock = host2;
    fireEvent.click(within(dock).getByRole("button", { name: "Delete" }));
    await vi.waitFor(() => {
      if (!document.querySelector("[data-slot='dropdown-menu']")) {
        throw new Error("delete menu not open");
      }
    });
    const menus = document.querySelectorAll("[data-slot='dropdown-menu']");
    const menu = /** @type {HTMLElement} */ (menus[menus.length - 1]);
    fireEvent.click(within(menu).getByRole("option", { name: "Delete row" }));
    const deleted = "intro\n\n| A | B |\n| --- | --- |\n\nafter";
    await vi.waitFor(() => {
      if (sync.ytext.toString() !== deleted) {
        throw new Error(`delete not committed: ${sync.ytext.toString()}`);
      }
    });
    ctrl.undoManager.undo();
    await vi.waitFor(() => {
      if (!sync.ytext.toString().includes("| 1 | 2 |")) {
        throw new Error("undo did not restore the row");
      }
    });
    expect(sync.ytext.toString()).toBe(
      "intro\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nafter",
    );
    ctrl.undoManager.redo();
    await vi.waitFor(() => {
      if (sync.ytext.toString() !== deleted) {
        throw new Error("redo did not re-delete the row");
      }
    });
  });
});
