import { describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { fireEvent } from "@testing-library/react";
import { markdownLivePreview } from "./markdownLivePreview.js";
import {
  insertMarkdownTable,
  parseMarkdownTable,
  runActiveTableAction,
  serializeMarkdownTable,
  splitTableLine,
  tableControllers,
} from "./markdownTables.js";

const TABLE_DOC = "intro\n\n| A | B |\n| --- | ---: |\n| 1 | 2 |\n\nafter";

describe("markdownTables helpers", () => {
  it("splits rows on unescaped pipes, keeping raw inline source", () => {
    expect(splitTableLine("| a | b |")).toEqual(["a", "b"]);
    expect(splitTableLine("a | b")).toEqual(["a", "b"]);
    expect(splitTableLine("| a \\| x | b |")).toEqual(["a \\| x", "b"]);
    expect(splitTableLine("|  |")).toEqual([""]);
  });

  it("parses header, alignment and body; pads ragged rows", () => {
    const m = parseMarkdownTable("| A | B |\n| :--- | ---: |\n| 1 | 2 |\n| 3 |\n");
    expect(m.header).toEqual(["A", "B"]);
    expect(m.align).toEqual(["left", "right"]);
    expect(m.body).toEqual([
      ["1", "2"],
      ["3", ""],
    ]);
  });

  it("serializes back to a normalized pipe table, escaping pipes", () => {
    const text = serializeMarkdownTable({
      header: ["A", "B"],
      align: ["center", ""],
      body: [["x | y", "2"]],
    });
    expect(text).toBe("| A | B |\n| :---: | --- |\n| x \\| y | 2 |");
  });
});

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

/** Wait for the parse + the queued React mount of the table. */
async function settled(view) {
  await vi.waitFor(() => {
    view.requestMeasure();
    if (!view.dom.querySelector(".md-table-grid")) {
      throw new Error("table not rendered yet");
    }
  });
}

function cell(view, r, c) {
  const el = view.dom.querySelector(`[data-cell="${r},${c}"]`);
  if (!(el instanceof HTMLElement)) throw new Error(`no cell ${r},${c}`);
  return el;
}

/** @returns {HTMLTextAreaElement} */
function input(view) {
  const ta = view.dom.querySelector("textarea.md-table-input");
  if (!(ta instanceof HTMLTextAreaElement)) throw new Error("no open cell");
  return ta;
}

async function openCell(view, r, c) {
  fireEvent.mouseDown(cell(view, r, c), { button: 0 });
  await vi.waitFor(() => {
    if (document.activeElement !== cell(view, r, c).querySelector("textarea")) {
      throw new Error(`cell ${r},${c} not focused`);
    }
  });
  return input(view);
}

describe("table in live preview", () => {
  it("renders cells as rendered text, with no text box until one is clicked", async () => {
    const view = mount(TABLE_DOC);
    await settled(view);
    const cells = [...view.dom.querySelectorAll("[data-cell]")];
    expect(cells.map((c) => c.textContent)).toEqual(["A", "B", "1", "2"]);
    expect(view.dom.querySelector("textarea")).toBeNull();
    expect(cell(view, 1, 1).style.textAlign).toBe("right");
    view.destroy();
  });

  it("typing in a cell writes straight into that cell's source", async () => {
    const view = mount(TABLE_DOC);
    await settled(view);
    const ta = await openCell(view, 1, 0);
    expect(ta.value).toBe("1");
    fireEvent.change(ta, { target: { value: "12" } });
    expect(view.state.doc.toString()).toBe(
      "intro\n\n| A | B |\n| --- | ---: |\n| 12 | 2 |\n\nafter",
    );
    fireEvent.change(input(view), { target: { value: "" } });
    expect(view.state.doc.toString()).toContain("| | 2 |");
    view.destroy();
  });

  it("keeps a trailing space and a raw pipe in the text box while the file stays valid", async () => {
    const view = mount(TABLE_DOC);
    await settled(view);
    const ta = await openCell(view, 1, 0);
    fireEvent.change(ta, { target: { value: "a " } });
    expect(input(view).value).toBe("a ");
    fireEvent.change(input(view), { target: { value: "a |b" } });
    expect(input(view).value).toBe("a |b");
    expect(view.state.doc.toString()).toContain("| a \\|b | 2 |");
    view.destroy();
  });

  it("pasted line breaks become spaces", async () => {
    const view = mount(TABLE_DOC);
    await settled(view);
    const ta = await openCell(view, 0, 0);
    fireEvent.change(ta, { target: { value: "one\ntwo" } });
    expect(input(view).value).toBe("one two");
    expect(view.state.doc.toString()).toContain("| one two | B |");
    view.destroy();
  });

  it("the open cell follows a peer's edit to the same cell", async () => {
    const view = mount(TABLE_DOC);
    await settled(view);
    await openCell(view, 1, 1);
    const at = view.state.doc.toString().indexOf("| 2 |") + 2;
    view.dispatch({ changes: { from: at, to: at + 1, insert: "9" } });
    await vi.waitFor(() => expect(input(view).value).toBe("9"));
    view.destroy();
  });

  it("writes into a short row by filling out only that row", async () => {
    const view = mount("| A | B |\n| --- | --- |\n| 1 |\n| 3 | 4 |");
    await settled(view);
    const ta = await openCell(view, 1, 1);
    fireEvent.change(ta, { target: { value: "x" } });
    expect(view.state.doc.toString()).toBe(
      "| A | B |\n| --- | --- |\n| 1 | x |\n| 3 | 4 |",
    );
    view.destroy();
  });

  it("Tab walks the cells and leaves the table after the last one", async () => {
    const view = mount(TABLE_DOC);
    await settled(view);
    await openCell(view, 0, 0);
    fireEvent.keyDown(input(view), { key: "Tab" });
    await vi.waitFor(() => expect(input(view).closest("[data-cell]")?.getAttribute("data-cell")).toBe("0,1"));
    fireEvent.keyDown(input(view), { key: "Tab", shiftKey: true });
    await vi.waitFor(() => expect(input(view).closest("[data-cell]")?.getAttribute("data-cell")).toBe("0,0"));
    await openCell(view, 1, 1);
    fireEvent.keyDown(input(view), { key: "Tab" });
    await vi.waitFor(() => expect(view.dom.querySelector("textarea")).toBeNull());
    const tableEnd = TABLE_DOC.indexOf("| 2 |") + 5;
    expect(view.state.selection.main.head).toBe(tableEnd + 1);
    view.destroy();
  });

  it("Enter moves down a row and leaves the table below the last row", async () => {
    const view = mount(TABLE_DOC);
    await settled(view);
    await openCell(view, 0, 1);
    fireEvent.keyDown(input(view), { key: "Enter" });
    await vi.waitFor(() => expect(input(view).closest("[data-cell]")?.getAttribute("data-cell")).toBe("1,1"));
    fireEvent.keyDown(input(view), { key: "Enter" });
    await vi.waitFor(() => expect(view.dom.querySelector("textarea")).toBeNull());
    view.destroy();
  });

  it("leaving a table at the end of the file adds a line to type on", async () => {
    const doc = "| A |\n| --- |\n| 1 |";
    const view = mount(doc);
    await settled(view);
    await openCell(view, 1, 0);
    fireEvent.keyDown(input(view), { key: "Escape" });
    expect(view.state.doc.toString()).toBe(`${doc}\n\n`);
    expect(view.state.selection.main.head).toBe(doc.length + 2);
    view.destroy();
  });

  it("a document cursor landing inside the table opens the matching cell", async () => {
    const view = mount(TABLE_DOC);
    await settled(view);
    const inside = TABLE_DOC.indexOf("| 1 |") + 2;
    view.dispatch({ selection: { anchor: inside } });
    await vi.waitFor(() => {
      if (document.activeElement?.closest("[data-cell]")?.getAttribute("data-cell") !== "1,0") {
        throw new Error("cell not focused");
      }
    });
    view.destroy();
  });

  it("a read-only table has no menus and no text boxes", async () => {
    const view = mount(TABLE_DOC, 0, false);
    await settled(view);
    expect(view.dom.querySelector(".md-table-actions")).toBeNull();
    expect(view.dom.querySelector(".md-table-add")).toBeNull();
    fireEvent.mouseDown(cell(view, 1, 0), { button: 0 });
    await new Promise((r) => setTimeout(r, 20));
    expect(view.dom.querySelector("textarea")).toBeNull();
    view.destroy();
  });

  it("toolbar marks wrap the selected text in the open cell", async () => {
    const view = mount(TABLE_DOC);
    await settled(view);
    const ta = await openCell(view, 1, 0);
    ta.setSelectionRange(0, 1);
    expect(runActiveTableAction(view, "bold")).toBe(true);
    expect(view.state.doc.toString()).toContain("| **1** | 2 |");
    // Block actions are swallowed inside a cell.
    expect(runActiveTableAction(view, "heading")).toBe(true);
    expect(view.state.doc.toString()).not.toContain("#");
    view.destroy();
  });

  it("Ctrl+Z in a cell goes to the editor's undo history", async () => {
    const view = mount(TABLE_DOC);
    await settled(view);
    const ctrl = tableControllers(view)[0];
    const undo = vi.fn();
    const redo = vi.fn();
    ctrl.undoManager = { undo, redo };
    await openCell(view, 1, 0);
    fireEvent.keyDown(input(view), { key: "z", ctrlKey: true });
    fireEvent.keyDown(input(view), { key: "z", ctrlKey: true, shiftKey: true });
    expect(undo).toHaveBeenCalledTimes(1);
    expect(redo).toHaveBeenCalledTimes(1);
    view.destroy();
  });

  it("inserts after a line with exactly one blank line on each side", () => {
    const view = mount("Hello\nbody", 5);
    insertMarkdownTable(view, { columns: 1, rows: 0 });
    expect(view.state.doc.toString()).toBe("Hello\n\n|  |\n| --- |\n\nbody");
    view.destroy();
  });

  it("insertMarkdownTable drops in a 3-column table and opens its first cell", async () => {
    const view = mount("Hello\n\nbody", 5);
    expect(insertMarkdownTable(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(
      "Hello\n\n|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |\n\nbody",
    );
    await settled(view);
    await vi.waitFor(() => {
      if (document.activeElement?.closest("[data-cell]")?.getAttribute("data-cell") !== "0,0") {
        throw new Error("first cell not focused");
      }
    });
    view.destroy();
  });
});
