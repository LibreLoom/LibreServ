import { describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { fireEvent, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { render } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { markdownLivePreview } from "./markdownLivePreview.js";
import { TableController, tableControllers } from "./markdownTables.js";

const TABLE_DOC = "intro\n\n| A | B |\n| --- | ---: |\n| 1 | 2 |\n\nafter";

function mount(doc, cursor = 0, editable = true) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: [
        EditorView.editable.of(editable),
        markdown({ extensions: [GFM] }),
        markdownLivePreview(),
      ],
    }),
  });
}

async function settled(view) {
  await vi.waitFor(() => {
    view.requestMeasure();
    if (!view.dom.querySelector(".md-table-grid")) {
      throw new Error("table grid not rendered yet");
    }
  });
}

function controller(view, index = 0) {
  const ctrls = tableControllers(view);
  if (!ctrls[index]) throw new Error("no table controller mounted");
  return ctrls[index];
}

/** @param {ParentNode} root @param {string} sel @returns {HTMLElement} */
function qs(root, sel) {
  const el = root.querySelector(sel);
  if (!(el instanceof HTMLElement)) throw new Error(`missing ${sel}`);
  return el;
}

function cell(view, r, c) {
  return qs(view.dom, `[data-cell="${r},${c}"]`);
}

function keydown(el, key, init = {}) {
  el.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
  );
}

function pointer(el, type, init = {}) {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true });
  for (const [k, v] of Object.entries(init)) {
    Object.defineProperty(ev, k, { value: v });
  }
  el.dispatchEvent(ev);
  return ev;
}

function clipEvent(el, type, store = {}) {
  const data = {
    store,
    setData(t, v) {
      this.store[t] = v;
    },
    getData(t) {
      return this.store[t] ?? "";
    },
  };
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clipboardData", { value: data });
  el.dispatchEvent(ev);
  return data;
}

async function openMenu(root, label) {
  const trigger = within(root).getByRole("button", { name: label });
  fireEvent.click(trigger);
  await vi.waitFor(() => {
    if (!document.querySelector("[data-slot='dropdown-menu']")) {
      throw new Error("menu not open");
    }
  });
  return document.querySelector("[data-slot='dropdown-menu']");
}

function menuOptions() {
  return [...document.querySelectorAll("[data-slot='dropdown-menu'] [role='option']")].map(
    (b) => b.textContent,
  );
}

async function closeMenus() {
  fireEvent.keyDown(document, { key: "Escape" });
  await vi.waitFor(() => {
    if (document.querySelector("[data-slot='dropdown-menu']")) {
      throw new Error("menu still closing");
    }
  });
}

async function chooseOption(label) {
  const opt = screen.getByRole("option", { name: label });
  fireEvent.click(opt);
  // The dropdown plays a short close animation before unmounting.
  await vi.waitFor(() => {
    if (document.querySelector("[data-slot='dropdown-menu']")) {
      throw new Error("menu still open");
    }
  });
}

describe("MarkdownTableEditor UI", () => {
  it("renders the full dock: actions, format controls, menus, expand and help", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const root = qs(view.dom, ".md-table-root");
    const dock = qs(root, ".md-table-dock");
    expect(dock).toBeTruthy();
    for (const name of [
      "Add row",
      "Add column",
      "Bold",
      "Italic",
      "Strikethrough",
      "Code",
      "Link",
      "Column alignment",
      "Row",
      "Column",
      "Table",
      "Delete",
      "Expand table workspace",
      "Table keyboard shortcuts",
    ]) {
      expect(
        within(dock).getByRole("button", { name }),
        `missing dock control ${name}`,
      ).toBeTruthy();
    }
    view.destroy();
  });

  it("one roving tab stop: only the selection head is tabbable", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.select({ r: 1, c: 1 });
    await vi.waitFor(() => {
      const tabbable = /** @type {HTMLElement[]} */ ([
        ...view.dom.querySelectorAll("[data-cell]"),
      ]).filter((el) => el.tabIndex === 0);
      if (tabbable.length !== 1 || tabbable[0].dataset.cell !== "1,1") {
        throw new Error(`tab stops: ${tabbable.map((t) => t.dataset.cell)}`);
      }
    });
    view.destroy();
  });

  it("only the ACTIVE table paints a selection or hints", async () => {
    const doc = `${TABLE_DOC}\n\n| X |\n| --- |\n| 9 |\n`;
    const view = mount(doc, 0);
    await settled(view);
    let roots = [];
    await vi.waitFor(() => {
      roots = [...view.dom.querySelectorAll(".md-table-root")];
      if (roots.length !== 2) throw new Error(`tables mounted: ${roots.length}`);
    });
    const first = controller(view, 0);
    first.select({ r: 0, c: 0 });
    await vi.waitFor(() => {
      if (!roots[0].querySelector(".md-sel, .md-head")) {
        throw new Error("active table has no selection paint");
      }
    });
    expect(roots[1].querySelector(".md-sel, .md-head")).toBeNull();
    expect(roots[1].querySelector(".md-table-hint")).toBeNull();
    view.destroy();
  });

  it("row, column and corner selectors are real labeled buttons", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    const root = qs(view.dom, ".md-table-root");
    fireEvent.click(within(root).getByRole("button", { name: "Select row 1" }));
    expect(ctrl.selRect()).toEqual({ top: 1, bottom: 1, left: 0, right: 1 });
    fireEvent.click(
      within(root).getByRole("button", { name: "Select column 2" }),
    );
    expect(ctrl.selRect()).toEqual({ top: 0, bottom: 1, left: 1, right: 1 });
    fireEvent.click(
      within(root).getByRole("button", { name: "Select whole table" }),
    );
    expect(ctrl.selRect()).toEqual({ top: 0, bottom: 1, left: 0, right: 1 });
    view.destroy();
  });

  it("gutter keys don't leak into grid navigation", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.select({ r: 1, c: 0 });
    const gutter = within(qs(view.dom, ".md-table-root")).getByRole(
      "button",
      { name: "Select row 1" },
    );
    keydown(gutter, "ArrowUp");
    keydown(gutter, "ArrowLeft");
    expect(ctrl.selection.head).toEqual({ r: 1, c: 0 });
    view.destroy();
  });

  it("clicks inside the open textarea are caret placement, not selection", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.startEdit(1, 0);
    await vi.waitFor(() => {
      if (!view.dom.querySelector("textarea.md-table-editor")) {
        throw new Error("editor not open");
      }
    });
    const ta = view.dom.querySelector("textarea.md-table-editor");
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    ta.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(ctrl.editing).toEqual({ r: 1, c: 0 });
    view.destroy();
  });

  it("a horizontal touch swipe scrolls instead of editing; a clean tap edits", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    const c = cell(view, 1, 0);
    pointer(c, "pointerdown", { pointerType: "touch", clientX: 10, clientY: 10, button: 0 });
    pointer(c, "pointerup", { pointerType: "touch", clientX: 90, clientY: 12, button: 0 });
    expect(ctrl.editing).toBeNull();
    expect(ctrl.selection.head).toEqual({ r: 0, c: 0 });
    pointer(c, "pointerdown", { pointerType: "touch", clientX: 10, clientY: 10, button: 0 });
    pointer(c, "pointerup", { pointerType: "touch", clientX: 12, clientY: 11, button: 0 });
    await vi.waitFor(() => {
      if (ctrl.editing?.r !== 1 || ctrl.editing?.c !== 0) {
        throw new Error("tap did not open the cell editor");
      }
    });
    view.destroy();
  });

  it("double-click opens the cell editor", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    fireEvent.doubleClick(cell(view, 1, 1));
    await vi.waitFor(() => {
      if (ctrl.editing?.c !== 1 || !view.dom.querySelector("textarea")) {
        throw new Error("editor not open");
      }
    });
    view.destroy();
  });

  it("F6 moves grid → dock → grid", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.select({ r: 0, c: 0 });
    const head = cell(view, 0, 0);
    head.focus();
    keydown(head, "F6");
    await vi.waitFor(() => {
      const active = document.activeElement;
      if (!active?.closest?.(".md-table-dock")) {
        throw new Error("dock not focused");
      }
    });
    keydown(document.activeElement, "F6");
    await vi.waitFor(() => {
      const active = /** @type {HTMLElement | null} */ (document.activeElement);
      if (active?.dataset?.cell !== "0,0") {
        throw new Error("cell not refocused");
      }
    });
    view.destroy();
  });

  it("Ctrl+B on a multi-cell selection bolds every selected cell", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.select({ r: 0, c: 0 }, { r: 1, c: 1 });
    keydown(cell(view, 0, 0), "b", { ctrlKey: true });
    const doc = view.state.doc.toString();
    expect(doc).toContain("| **A** | **B** |");
    expect(doc).toContain("| **1** | **2** |");
    view.destroy();
  });

  it("dock Bold wraps the live textarea selection while editing", async () => {
    const doc = "intro\n\n| A |\n| --- |\n| hello world |\n\nafter";
    const view = mount(doc, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.startEdit(1, 0);
    await vi.waitFor(() => {
      if (!view.dom.querySelector("textarea.md-table-editor")) {
        throw new Error("editor not open");
      }
    });
    const ta = view.dom.querySelector("textarea.md-table-editor");
    if (!(ta instanceof HTMLTextAreaElement)) {
      throw new Error("no editor textarea");
    }
    ta.setSelectionRange(6, 11); // "world"
    const dock = qs(view.dom, ".md-table-dock");
    // The dock's mousedown is preventDefault'd so the textarea selection survives.
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    dock.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    fireEvent.click(within(dock).getByRole("button", { name: "Bold" }));
    expect(ctrl.draft?.text).toBe("hello **world**");
    view.destroy();
  });

  it("a block-level toolbar action refuses inside the table with a notice", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.select({ r: 0, c: 0 });
    ctrl.toolbarAction("heading");
    await vi.waitFor(() => {
      const note = view.dom.querySelector(".md-table-note");
      if (!note || !/isn't available inside a table/.test(note.textContent)) {
        throw new Error("no refusal notice");
      }
    });
    expect(view.state.doc.toString()).toBe(TABLE_DOC);
    view.destroy();
  });

  it("menus filter impossible operations instead of offering silent no-ops", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    const root = view.dom.querySelector(".md-table-root");

    // Header-only selection: no row delete/move/duplicate.
    ctrl.select({ r: 0, c: 0 });
    await openMenu(root, "Row");
    let labels = menuOptions();
    expect(labels).toContain("Insert row below");
    expect(labels).not.toContain("Delete row(s)");
    expect(labels).not.toContain("Move row up");
    await closeMenus();

    // All columns selected: no delete, no single-column sort.
    ctrl.selectAll();
    await openMenu(root, "Column");
    labels = menuOptions();
    expect(labels).not.toContain("Delete column(s)");
    expect(labels).not.toContain("Sort rows A→Z by this column");
    await closeMenus();

    // One column selected: sort appears; a boundary column loses move-left.
    ctrl.select({ r: 0, c: 0 }, { r: 1, c: 0 });
    await openMenu(root, "Column");
    labels = menuOptions();
    expect(labels).toContain("Sort rows A→Z by this column");
    expect(labels).not.toContain("Move column left");
    await closeMenus();
    view.destroy();
  });

  it("the column menu drives real document changes", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.select({ r: 0, c: 0 });
    const root = view.dom.querySelector(".md-table-root");
    await openMenu(root, "Column");
    await chooseOption("Insert column right");
    expect(view.state.doc.toString()).toContain("| A |  | B |");
    view.destroy();
  });

  it("mixed column alignment shows a Mixed placeholder", async () => {
    const view = mount(TABLE_DOC, 0); // col A default, col B right
    await settled(view);
    const ctrl = controller(view);
    const root = qs(view.dom, ".md-table-root");
    ctrl.select({ r: 0, c: 0 });
    await vi.waitFor(() => {
      const dd = within(root).getByRole("button", { name: "Column alignment" });
      if (!/Align: default/.test(dd.textContent)) throw new Error(dd.textContent);
    });
    ctrl.selectAll();
    await vi.waitFor(() => {
      const dd = within(root).getByRole("button", { name: "Column alignment" });
      if (!/Align: Mixed/.test(dd.textContent)) throw new Error(dd.textContent);
    });
    view.destroy();
  });

  it("Escape closes the shortcuts popover and focus returns to the cell", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.select({ r: 0, c: 0 });
    ctrl.setDialog("help");
    await vi.waitFor(() => {
      if (!document.querySelector(".md-table-help")) throw new Error("no help");
    });
    fireEvent.keyDown(document, { key: "Escape" });
    await vi.waitFor(() => {
      if (ctrl.dialog !== null) throw new Error("help still open");
      const active = /** @type {HTMLElement | null} */ (document.activeElement);
      if (active?.dataset?.cell !== "0,0") {
        throw new Error("focus not restored to cell");
      }
    });
    view.destroy();
  });

  it("import dialog: malformed CSV errors and a clean paste lands at the selection", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.select({ r: 1, c: 0 });
    const root = view.dom.querySelector(".md-table-root");
    await openMenu(root, "Table");
    await chooseOption("Import CSV / TSV…");
    const ta = await vi.waitFor(() => {
      const el = screen.queryByLabelText("Data to import");
      if (!el) throw new Error("import dialog not open");
      return el;
    });
    // Unmatched quote surfaces an error; nothing is written.
    fireEvent.change(ta, { target: { value: '"unclosed,b\nc,d' } });
    await vi.waitFor(() => {
      if (!screen.queryByRole("alert")?.textContent?.match(/unmatched/i)) {
        throw new Error("no quote error");
      }
    });
    fireEvent.change(ta, { target: { value: "x,y\nz,w" } });
    fireEvent.click(screen.getByRole("button", { name: "Paste at selection" }));
    await vi.waitFor(() => {
      const doc = view.state.doc.toString();
      if (!doc.includes("| x | y |") || !doc.includes("| z | w |")) {
        throw new Error(doc);
      }
    });
    view.destroy();
  });

  it("source dialog validates, applies, and refuses after a remote change", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    const root = view.dom.querySelector(".md-table-root");
    await openMenu(root, "Table");
    await chooseOption("Markdown source…");
    const ta = await vi.waitFor(() => {
      const el = screen.queryByLabelText("Table Markdown source");
      if (!(el instanceof HTMLTextAreaElement)) {
        throw new Error("source dialog not open");
      }
      return el;
    });
    expect(ta.value).toContain("| A | B |");

    // Invalid source keeps the dialog open and the document untouched.
    fireEvent.change(ta, { target: { value: "a\n---\nb" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await vi.waitFor(() => {
      if (!screen.queryByRole("alert")) throw new Error("no validation error");
    });
    expect(view.state.doc.toString()).toBe(TABLE_DOC);

    // A remote change while the dialog is open makes Apply refuse.
    const from = TABLE_DOC.indexOf("| 1 |") + 2;
    view.dispatch({ changes: { from, to: from + 1, insert: "9" } });
    await vi.waitFor(() => {
      if (ctrl.dialogSource == null) throw new Error("dialog closed early");
    });
    fireEvent.change(ta, {
      target: { value: "| A | B |\n| --- | ---: |\n| 9 | 2 |" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(ctrl.dialog).toBe("source");
    view.destroy();
  });

  it("delete confirmation rechecks the table after a remote change", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    const root = view.dom.querySelector(".md-table-root");
    await openMenu(root, "Table");
    await chooseOption("Delete table…");
    await vi.waitFor(() => {
      if (ctrl.dialog !== "delete") throw new Error("dialog not open");
    });
    // Peer edits the table while the confirm sits open.
    const from = TABLE_DOC.indexOf("| 1 |") + 2;
    view.dispatch({ changes: { from, to: from + 1, insert: "9" } });
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.click(screen.getByRole("button", { name: "Delete table" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(view.state.doc.toString()).toContain("| A | B |");
    expect(view.state.doc.toString()).toContain("| 9 |");
    view.destroy();
  });

  it("copy puts TSV and the table JSON on the clipboard; cut clears only after success", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.select({ r: 0, c: 0 }, { r: 1, c: 0 });
    const grid = view.dom.querySelector(".md-table-scroll");
    const copied = clipEvent(grid, "copy");
    expect(copied.store["text/plain"]).toBe("A\n1");
    const payload = JSON.parse(copied.store["application/x-luna-table+json"]);
    expect(payload.rows).toEqual([["A"], ["1"]]);

    const cut = clipEvent(grid, "cut");
    expect(view.state.doc.toString()).toContain("|  | B |");
    expect(cut.store["text/plain"]).toBe("A\n1");
    view.destroy();
  });

  it("a failing clipboard keeps the cut from deleting", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.select({ r: 0, c: 0 }, { r: 1, c: 0 });
    const grid = view.dom.querySelector(".md-table-scroll");
    const ev = new Event("cut", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", {
      value: {
        setData() {
          throw new Error("denied");
        },
        getData() {
          return "";
        },
      },
    });
    grid.dispatchEvent(ev);
    expect(view.state.doc.toString()).toBe(TABLE_DOC);
    view.destroy();
  });

  it("pasting the in-app JSON lands one column as rows, not a blob", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.select({ r: 1, c: 0 });
    const grid = view.dom.querySelector(".md-table-scroll");
    clipEvent(grid, "paste", {
      "application/x-luna-table+json": JSON.stringify({
        version: 1,
        rows: [["x"], ["y"], ["z"]],
      }),
    });
    const doc = view.state.doc.toString();
    expect(doc).toContain("| x | 2 |");
    expect(doc).toContain("| y |");
    expect(doc).toContain("| z |");
    view.destroy();
  });

  it("the conflict bar keeps the draft when Copy is used", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const prev = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    try {
      const view = mount(TABLE_DOC, 0);
      await settled(view);
      const ctrl = controller(view);
      ctrl.startEdit(1, 0);
      ctrl.setDraft("mine");
      const from = TABLE_DOC.indexOf("| 1 |") + 2;
      view.dispatch({ changes: { from, to: from + 1, insert: "remote" } });
      await vi.waitFor(() => {
        if (!view.dom.querySelector(".md-table-conflict")) {
          throw new Error("no conflict bar");
        }
      });
      fireEvent.click(screen.getByRole("button", { name: "Copy my text" }));
      await vi.waitFor(() => {
        if (!writeText.mock.calls.length) throw new Error("copy not called");
      });
      // Copy is not a resolution — the draft and the bar stay put.
      expect(ctrl.draft?.text).toBe("mine");
      expect(ctrl.conflict).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Use updated" }));
      expect(ctrl.draft).toBeNull();
      expect(ctrl.conflict).toBeNull();
      view.destroy();
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: prev,
      });
    }
  });

  it("a torn-down widget's draft is offered back as recoverable text", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.startEdit(1, 0);
    ctrl.setDraft("rescue me");
    // The table is deleted outright (remote rewrite to prose) — the widget
    // is destroyed and its draft moves to the view's recovery store. When a
    // table reappears, the new grid offers the text back for copying.
    const tFrom = TABLE_DOC.indexOf("| A |");
    const tTo = TABLE_DOC.indexOf("| 1 | 2 |") + "| 1 | 2 |".length;
    view.dispatch({ changes: { from: tFrom, to: tTo, insert: "not a table" } });
    await vi.waitFor(() => {
      view.requestMeasure();
      if (view.dom.querySelector(".md-table-grid")) {
        throw new Error("grid still mounted");
      }
    });
    const at = view.state.doc.toString().indexOf("not a table");
    view.dispatch({
      changes: {
        from: at,
        to: at + "not a table".length,
        insert: "| N |\n| --- |\n| 7 |",
      },
    });
    await vi.waitFor(() => {
      view.requestMeasure();
      const bar = view.dom.querySelector(".md-table-recovery");
      if (!bar || !bar.textContent.includes("rescue me")) {
        throw new Error("no recovery bar");
      }
    });
    view.destroy();
  });

  it("F6 in the expanded workspace focuses the dock inside the dialog", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.select({ r: 0, c: 0 });
    ctrl.setExpanded(true);
    const dlgCell = await vi.waitFor(() => {
      const el = /** @type {HTMLElement | null} */ (
        document.querySelector("[role='dialog'] [data-cell='0,0']")
      );
      if (!el) throw new Error("expanded grid not rendered");
      return el;
    });
    dlgCell.focus();
    keydown(dlgCell, "F6");
    await vi.waitFor(() => {
      const active = document.activeElement;
      if (
        !active?.closest?.(".md-table-dock") ||
        !active.closest("[role='dialog']")
      ) {
        throw new Error("dock inside dialog not focused");
      }
    });
    view.destroy();
  });

  it("Paste at selection refuses and says so when the table changed remotely", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    const ctrl = controller(view);
    ctrl.select({ r: 1, c: 0 });
    const root = view.dom.querySelector(".md-table-root");
    await openMenu(root, "Table");
    await chooseOption("Import CSV / TSV…");
    const ta = await vi.waitFor(() => {
      const el = screen.queryByLabelText("Data to import");
      if (!el) throw new Error("import dialog not open");
      return el;
    });
    fireEvent.change(ta, { target: { value: "x,y\nz,w" } });
    // A peer edits the table while the dialog sits open.
    const from = TABLE_DOC.indexOf("| 1 |") + 2;
    view.dispatch({ changes: { from, to: from + 1, insert: "9" } });
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.click(screen.getByRole("button", { name: "Paste at selection" }));
    await vi.waitFor(() => {
      const dlg = document.querySelector("[role='dialog']");
      const alert = dlg?.querySelector("[role='alert']");
      if (!alert || !/changed since you opened/.test(alert.textContent)) {
        throw new Error("no in-dialog stale notice");
      }
    });
    const doc = view.state.doc.toString();
    expect(doc).toContain("| 9 |");
    expect(doc).not.toContain("| x | y |");
    expect(ctrl.dialog).toBe("import");
    view.destroy();
  });

  it("a malformed in-app clipboard payload is rejected with a notice", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    controller(view).select({ r: 1, c: 0 });
    const grid = view.dom.querySelector(".md-table-scroll");
    clipEvent(grid, "paste", {
      "application/x-luna-table+json": JSON.stringify({
        version: 1,
        rows: [null],
      }),
    });
    await vi.waitFor(() => {
      const note = view.dom.querySelector(".md-table-note");
      if (!note?.textContent) throw new Error("no notice");
    });
    expect(view.state.doc.toString()).toBe(TABLE_DOC);
    view.destroy();
  });

  it("read-only tables render the grid without dock actions", async () => {
    const view = mount(TABLE_DOC, 0, false);
    await settled(view);
    const root = qs(view.dom, ".md-table-root");
    expect(root.querySelector(".md-table-grid")).toBeTruthy();
    expect(within(root).queryByRole("button", { name: "Add row" })).toBeNull();
    view.destroy();
  });
});

describe("inline Markdown rendering matches the real document", () => {
  /** Render `source` as a full GFM table and return each cell's text. */
  function docCells(source) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const { unmount } = render(
      createElement(
        ReactMarkdown,
        { remarkPlugins: [remarkGfm], rehypePlugins: [rehypeSanitize] },
        source,
      ),
      { container: host },
    );
    const cells = [...host.querySelectorAll("td")].map((td) => td.textContent);
    unmount();
    host.remove();
    return cells;
  }

  it.each([
    ["escaped emphasis stays literal", String.raw`\*literal\*`],
    ["escaped brackets stay literal", String.raw`\[label\]`],
    ["double backslash", String.raw`\\server`],
    ["pipe inside code span", "`x\\|y`"],
    ["a real link", "[l](https://x.test)"],
  ])("%s survives widget render = doc render", async (_name, cellSource) => {
    const doc = `intro\n\n| A |\n| --- |\n| ${cellSource} |\n\nafter`;
    const view = mount(doc, 0);
    await settled(view);
    const rendered = cell(view, 1, 0).textContent;
    const expected = docCells(doc)[0];
    expect(rendered).toBe(expected);

    // Structural ops must not rewrite the cell's inline source. "Insert row
    // below" on the header lands at the body's top, moving this row to 2.
    const ctrl = controller(view);
    ctrl.alignCommand("center");
    ctrl.insertRowCommand("below");
    await new Promise((r) => setTimeout(r, 30));
    expect(cell(view, 2, 0).textContent).toBe(expected);
    expect(view.state.doc.toString()).toContain(cellSource);
    view.destroy();
  });
});

const WIDE_DOC =
  "intro\n\n| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n\nafter";

async function openDeleteMenu(view) {
  const dock = qs(view.dom, ".md-table-dock");
  const trigger = within(dock).getByRole("button", { name: "Delete" });
  fireEvent.click(trigger);
  await vi.waitFor(() => {
    if (!document.querySelector("[data-slot='dropdown-menu']")) {
      throw new Error("delete menu not open");
    }
  });
}

function lastMenu() {
  const menus = document.querySelectorAll("[data-slot='dropdown-menu']");
  const menu = menus[menus.length - 1];
  if (!(menu instanceof HTMLElement)) throw new Error("no menu open");
  return within(menu);
}

describe("Delete menu", () => {
  it("deletes a gutter-selected body row, keeping header and prose", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    fireEvent.click(
      qs(view.dom, "[aria-label='Select row 1']"),
    );
    await openDeleteMenu(view);
    fireEvent.click(lastMenu().getByRole("option", { name: "Delete row" }));
    await vi.waitFor(() => {
      const doc = view.state.doc.toString();
      if (doc.includes("| 1 |")) throw new Error("row still present");
      expect(doc).toBe("intro\n\n| A | B |\n| --- | ---: |\n\nafter");
    });
    view.destroy();
  });

  it("deletes a gutter-selected column", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    fireEvent.click(qs(view.dom, "[aria-label='Select column 2']"));
    await openDeleteMenu(view);
    fireEvent.click(lastMenu().getByRole("option", { name: "Delete column" }));
    await vi.waitFor(() => {
      const doc = view.state.doc.toString();
      if (doc.includes("| B |")) throw new Error("column still present");
      expect(doc).toBe("intro\n\n| A |\n| --- |\n| 1 |\n\nafter");
    });
    view.destroy();
  });

  it("labels and deletes two selected body rows", async () => {
    const view = mount(WIDE_DOC, 0);
    await settled(view);
    controller(view).select(
      { r: 1, c: 0 },
      { r: 2, c: 2 },
    );
    await openDeleteMenu(view);
    fireEvent.click(lastMenu().getByRole("option", { name: "Delete 2 rows" }));
    await vi.waitFor(() => {
      const doc = view.state.doc.toString();
      if (doc.includes("| 1 |")) throw new Error("rows still present");
      expect(doc).toBe(
        "intro\n\n| A | B | C |\n| --- | --- | --- |\n\nafter",
      );
    });
    view.destroy();
  });

  it("labels and deletes two selected columns", async () => {
    const view = mount(WIDE_DOC, 0);
    await settled(view);
    controller(view).select(
      { r: 0, c: 0 },
      { r: 2, c: 1 },
    );
    await openDeleteMenu(view);
    fireEvent.click(
      lastMenu().getByRole("option", { name: "Delete 2 columns" }),
    );
    await vi.waitFor(() => {
      const doc = view.state.doc.toString();
      if (doc.includes("| A |")) throw new Error("columns still present");
      expect(doc).toBe("intro\n\n| C |\n| --- |\n| 3 |\n| 6 |\n\nafter");
    });
    view.destroy();
  });

  it("header-only selection offers no row delete", async () => {
    const view = mount(WIDE_DOC, 0);
    await settled(view);
    controller(view).select({ r: 0, c: 0 }, { r: 0, c: 2 });
    await openDeleteMenu(view);
    const menu = lastMenu();
    expect(menu.queryByRole("option", { name: /^Delete.*row/ })).toBeNull();
    expect(
      menu.queryByRole("option", { name: /^Delete.*column/ }),
    ).toBeNull();
    expect(menu.getByRole("option", { name: "Delete table…" })).toBeTruthy();
    await closeMenus();
    view.destroy();
  });

  it("partial header selection offers column delete but no row delete", async () => {
    const view = mount(WIDE_DOC, 0);
    await settled(view);
    controller(view).select({ r: 0, c: 0 }, { r: 0, c: 1 });
    await openDeleteMenu(view);
    const menu = lastMenu();
    expect(menu.queryByRole("option", { name: /^Delete.*row/ })).toBeNull();
    expect(
      menu.getByRole("option", { name: "Delete 2 columns" }),
    ).toBeTruthy();
    await closeMenus();
    view.destroy();
  });

  it("all-columns selection swaps column delete for Delete table", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    controller(view).selectAll();
    await openDeleteMenu(view);
    expect(
      lastMenu().queryByRole("option", { name: /^Delete.*column/ }),
    ).toBeNull();
    fireEvent.click(lastMenu().getByRole("option", { name: "Delete table…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await vi.waitFor(() => {
      if (!view.dom.querySelector(".md-table-grid")) {
        throw new Error("table gone after cancel");
      }
    });
    expect(view.state.doc.toString()).toBe(TABLE_DOC);
    view.destroy();
  });

  it("single-column table offers no column delete", async () => {
    const view = mount("intro\n\n| A |\n| --- |\n| 1 |\n\nafter", 0);
    await settled(view);
    controller(view).select({ r: 0, c: 0 }, { r: 1, c: 0 });
    await openDeleteMenu(view);
    const menu = lastMenu();
    expect(
      menu.queryByRole("option", { name: /^Delete.*column/ }),
    ).toBeNull();
    expect(menu.getByRole("option", { name: "Delete table…" })).toBeTruthy();
    await closeMenus();
    view.destroy();
  });

  it("Clear cell contents empties cells without changing shape", async () => {
    const view = mount(TABLE_DOC, 0);
    await settled(view);
    controller(view).select({ r: 1, c: 0 }, { r: 1, c: 1 });
    await openDeleteMenu(view);
    fireEvent.click(
      lastMenu().getByRole("option", { name: "Clear cell contents" }),
    );
    await vi.waitFor(() => {
      const doc = view.state.doc.toString();
      if (doc.includes("| 1 |") || !doc.includes("| --- | ---: |")) {
        throw new Error(`unexpected doc: ${doc}`);
      }
    });
    expect(view.state.doc.toString()).toBe(
      "intro\n\n| A | B |\n| --- | ---: |\n|  |  |\n\nafter",
    );
    view.destroy();
  });

  it("read-only tables show no Delete trigger", async () => {
    const view = mount(TABLE_DOC, 0, false);
    await settled(view);
    expect(
      within(view.dom).queryByRole("button", { name: "Delete" }),
    ).toBeNull();
    view.destroy();
  });
});
