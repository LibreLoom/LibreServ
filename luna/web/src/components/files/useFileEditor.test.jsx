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

  it("renders a markdown table as the editable table widget", async () => {
    const sync = makeSync();
    sync.ytext.insert(0, "intro\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n");
    render(<Surface sync={sync} />);
    // The parse finishes off the first frame — wait for the widget.
    await vi.waitFor(() => {
      if (!document.querySelector(".md-table-grid")) {
        throw new Error("table widget not rendered yet");
      }
    });
    expect(cmText()).toContain("| A | B |");
  });

  function cmView() {
    const host = document.querySelector("[data-slot$='-editor-surface']");
    return /** @type {any} */ (host).__cmView;
  }

  async function mountedTable(sync, canWrite = true) {
    const utils = render(<Surface sync={sync} canWrite={canWrite} />);
    await vi.waitFor(() => {
      if (!document.querySelector(".md-table-grid")) {
        throw new Error("table not rendered yet");
      }
    });
    const view = cmView();
    const [ctrl] = tableControllers(view);
    if (!ctrl) throw new Error("no table controller");
    return { view, ctrl, ...utils };
  }

  /** Click a cell and wait for its text box to take the caret. */
  async function openCell(view, r, c) {
    const cell = view.dom.querySelector(`[data-cell="${r},${c}"]`);
    fireEvent.mouseDown(cell, { button: 0 });
    return vi.waitFor(() => {
      const ta = cell.querySelector("textarea");
      if (!ta || document.activeElement !== ta) throw new Error("cell not open");
      return /** @type {HTMLTextAreaElement} */ (ta);
    });
  }

  it("table edits undo and redo through the shared Yjs undo manager", async () => {
    const sync = makeSync();
    sync.ytext.insert(0, "intro\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n");
    const { ctrl } = await mountedTable(sync);

    ctrl.addRowAfter(ctrl.rows);
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

  it("cell typing lands in the shared doc and undoes with Ctrl+Z", async () => {
    const sync = makeSync();
    sync.ytext.insert(0, "| A |\n| --- |\n| 1 |\n");
    const { view } = await mountedTable(sync);
    const ta = await openCell(view, 1, 0);
    fireEvent.change(ta, { target: { value: "12" } });
    expect(sync.ytext.toString()).toBe("| A |\n| --- |\n| 12 |\n");
    fireEvent.keyDown(ta, { key: "z", ctrlKey: true });
    await vi.waitFor(() => {
      if (sync.ytext.toString() !== "| A |\n| --- |\n| 1 |\n") {
        throw new Error(`undo not applied: ${sync.ytext.toString()}`);
      }
    });
    await vi.waitFor(() => {
      const open = view.dom.querySelector("textarea.md-table-input");
      if (open && open.value !== "1") throw new Error("text box not refreshed");
    });
  });

  it("formatting actions route into the open table cell, not the document", async () => {
    const sync = makeSync();
    sync.ytext.insert(0, "para\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n");
    const { view } = await mountedTable(sync);
    const ta = await openCell(view, 1, 0);
    ta.setSelectionRange(0, 1);
    runMarkdownAction(view, "bold");
    expect(cmText()).toContain("| **1** | 2 |");

    // Block-level actions do nothing inside a cell — paragraph untouched.
    runMarkdownAction(view, "heading");
    expect(cmText()).not.toContain("#");
  });

  it("losing write permission closes the open cell and hides the menus", async () => {
    const sync = makeSync();
    sync.ytext.insert(0, "intro\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n");
    const { view, ctrl, rerender } = await mountedTable(sync);
    await openCell(view, 1, 0);

    rerender(<Surface sync={sync} canWrite={false} />);
    await vi.waitFor(() => {
      if (ctrl.editable) throw new Error("still editable");
    });
    await vi.waitFor(() => {
      if (view.dom.querySelector("textarea, .md-table-actions")) {
        throw new Error("cell or menus still showing");
      }
    });
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

  it("heading levels do nothing while a table cell is open", async () => {
    const sync = makeSync();
    const source = "intro\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n";
    sync.ytext.insert(0, source);
    const view = mountEditor(sync);
    await vi.waitFor(() => {
      if (!document.querySelector(".md-table-grid")) {
        throw new Error("table not rendered yet");
      }
    });
    const cell = view.dom.querySelector('[data-cell="1,0"]');
    fireEvent.mouseDown(cell, { button: 0 });
    await vi.waitFor(() => {
      if (!cell.querySelector("textarea")) throw new Error("cell not open");
    });
    fireEvent.click(screen.getByRole("button", { name: "Heading level" }));
    fireEvent.click(
      await screen.findByRole("option", { name: "Heading 6 (H6)" }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(cmText()).toBe(source);
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

describe("Table toolbar button", () => {
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

  it("inserts a 3×3 table right away and opens its first heading cell", async () => {
    const sync = makeSync();
    sync.ytext.insert(0, "Hello\n\nbody text");
    const view = mountEditor(sync);
    view.dispatch({ selection: { anchor: 5 } });
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    expect(sync.ytext.toString()).toBe(
      "Hello\n\n|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |\n\nbody text",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    await vi.waitFor(() => {
      const open = document.activeElement?.closest("[data-cell]");
      if (open?.getAttribute("data-cell") !== "0,0") {
        throw new Error("first cell not focused");
      }
    });
  });

  it("row deletion from the row menu undoes and redoes with prose intact", async () => {
    const sync = makeSync();
    const source = "intro\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nafter";
    sync.ytext.insert(0, source);
    const view = mountEditor(sync);
    await vi.waitFor(() => {
      if (!document.querySelector(".md-table-grid")) {
        throw new Error("table not rendered yet");
      }
    });
    fireEvent.click(within(view.dom).getByRole("button", { name: "Row 1 options" }));
    fireEvent.click(await screen.findByRole("option", { name: "Delete this row" }));
    const deleted = "intro\n\n| A | B |\n| --- | --- |\n\nafter";
    expect(sync.ytext.toString()).toBe(deleted);
    const [ctrl] = tableControllers(view);
    ctrl.undoManager.undo();
    await vi.waitFor(() => {
      if (sync.ytext.toString() !== source) {
        throw new Error("undo did not restore the row");
      }
    });
    tableControllers(view)[0].undoManager.redo();
    await vi.waitFor(() => {
      if (sync.ytext.toString() !== deleted) {
        throw new Error("redo did not re-delete the row");
      }
    });
  });
});
