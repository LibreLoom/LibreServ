/**
 * Live-preview decorations for the Markdown editor — the "type source, see
 * it rendered" mode. A ViewPlugin walks the syntax tree over the visible
 * ranges and:
 *
 *   - hides syntax marks (`**`, `#`, `>`, backticks, `[…](…)` furniture)
 *     whenever the cursor is NOT on that line/range — move the cursor in
 *     and the raw markdown reappears so the file stays honest
 *   - styles the content (headings scale, bold is bold, links underline,
 *     inline code gets a pill, blockquotes get a bar, fenced code a layer)
 *   - swaps `- ` list marks for `•`, task markers for real checkboxes,
 *     `---` rules for a hairline, and `![alt](src)` for an inline image
 *
 * All classes are themed in editorTheme.js (previewTheme).
 */

import { syntaxTree } from "@codemirror/language";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
} from "@codemirror/view";
import { RangeSet, StateField } from "@codemirror/state";
import { TableWidget, tableControllers } from "./markdownTables.js";

const hide = Decoration.replace({});
const lineDeco = (cls) => Decoration.line({ attributes: { class: cls } });
const markDeco = (cls) => Decoration.mark({ class: cls });

/** Task-list checkbox — a real input so clicking toggles `[ ]` ↔ `[x]`. */
class CheckboxWidget extends WidgetType {
  /** @param {boolean} checked @param {number} pos TaskMarker.from */
  constructor(checked, pos) {
    super();
    this.checked = checked;
    this.pos = pos;
  }
  eq(other) {
    return other.checked === this.checked && other.pos === this.pos;
  }
  toDOM(view) {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "cm-lp-task";
    input.checked = this.checked;
    input.setAttribute("aria-label", this.checked ? "Done — click to reopen" : "To do — click to mark done");
    input.addEventListener("mousedown", (event) => {
      event.preventDefault();
      // `[x]` — the state char sits one byte into the marker.
      view.dispatch({
        changes: { from: this.pos + 1, to: this.pos + 2, insert: this.checked ? " " : "x" },
        userEvent: "input.taskToggle",
      });
    });
    return input;
  }
  ignoreEvent() {
    return false;
  }
}

/** Inline image preview for `![alt](src)` — resolved via a callback so the
 * editor can map relative paths against the file's folder on the drive. */
class ImageWidget extends WidgetType {
  /** @param {string} alt @param {string | null} src */
  constructor(alt, src) {
    super();
    this.alt = alt;
    this.src = src;
  }
  eq(other) {
    return other.alt === this.alt && other.src === this.src;
  }
  toDOM() {
    if (!this.src) {
      const chip = document.createElement("span");
      chip.className = "cm-lp-image-broken";
      chip.textContent = this.alt ? `Image: ${this.alt}` : "Image";
      return chip;
    }
    const wrap = document.createElement("span");
    wrap.className = "cm-lp-image";
    const img = document.createElement("img");
    img.src = this.src;
    img.alt = this.alt || "";
    img.loading = "lazy";
    img.addEventListener("error", () => {
      wrap.className = "cm-lp-image-broken";
      wrap.textContent = this.alt ? `Image: ${this.alt}` : "Image";
    });
    wrap.appendChild(img);
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

/** `•` in place of the raw `-`/`*`/`+` list mark. */
class BulletWidget extends WidgetType {
  eq(other) {
    return other instanceof BulletWidget;
  }
  toDOM() {
    const span = document.createElement("span");
    span.textContent = "•";
    span.setAttribute("aria-hidden", "true");
    return span;
  }
  ignoreEvent() {
    return true;
  }
}

const MARK_NODES = new Set([
  "HeaderMark",
  "EmphasisMark",
  "CodeMark",
  "LinkMark",
  "QuoteMark",
  "LinkTitle",
  "URL",
]);

const HEADING_CLASSES = {
  ATXHeading1: "cm-lp-h1",
  ATXHeading2: "cm-lp-h2",
  ATXHeading3: "cm-lp-h3",
  ATXHeading4: "cm-lp-h4",
  ATXHeading5: "cm-lp-h5",
  ATXHeading6: "cm-lp-h6",
  SetextHeading1: "cm-lp-h1",
  SetextHeading2: "cm-lp-h2",
};

const INLINE_STYLES = {
  Emphasis: "cm-lp-italic",
  StrongEmphasis: "cm-lp-bold",
  Strikethrough: "cm-lp-strike",
  InlineCode: "cm-lp-code",
  Link: "cm-lp-link",
};

/**
 * Does any selection range touch [from, to)? For block marks we check the
 * whole line instead so a cursor anywhere on the line reveals the syntax.
 * @param {import("@codemirror/state").EditorState} state
 */
function rangeActive(state, from, to) {
  for (const range of state.selection.ranges) {
    if (range.from <= to && range.to >= from) return true;
  }
  return false;
}

/** @param {import("@codemirror/state").EditorState} state */
function lineActive(state, pos) {
  const line = state.doc.lineAt(pos);
  return rangeActive(state, line.from, line.to);
}

function buildDecorations(view, resolveImage) {
  // Collected unsorted — a node can emit decorations for several lines plus
  // marks between them, so RangeSet.of sorts the final set instead of
  // requiring emission in document order.
  /** @type {{ from: number, to: number, value: Decoration }[]} */
  const decos = [];
  const { state } = view;

  /** @param {number} from @param {number} to @param {Decoration} deco */
  const add = (from, to, deco) => decos.push({ from, to, value: deco });

  /** Push a line decoration on the line containing `pos`. */
  const decorateLine = (pos, cls) => {
    const line = state.doc.lineAt(pos);
    add(line.from, line.from, lineDeco(cls));
  };

  /**
   * Hide child marks of a node. With `perLine` a mark stays hidden unless
   * the cursor is on the mark's own line (block furniture: `>`, `#`, list
   * marks); otherwise the marks hide unless the cursor is inside the node
   * (inline furniture: `**`, backticks, link brackets).
   * @param {import("@lezer/common").SyntaxNodeRef} node
   */
  const hideMarks = (node, markNames, perLine = false) => {
    if (!perLine && rangeActive(state, node.from, node.to)) return;
    for (const childName of markNames) {
      for (const mark of node.node.getChildren(childName)) {
        if (perLine && lineActive(state, mark.from)) continue;
        add(mark.from, mark.to, hide);
      }
    }
  };

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        const { name, from: nFrom, to: nTo } = node;

        // The markdownTables widget owns the whole Table range — don't
        // descend into it decorating marks nobody can see.
        if (name === "Table") return false;

        if (HEADING_CLASSES[name]) {
          decorateLine(nFrom, HEADING_CLASSES[name]);
          if (name.startsWith("ATXHeading")) {
            let hiddenTo = -1;
            for (const mark of node.node.getChildren("HeaderMark")) {
              if (lineActive(state, mark.from)) continue;
              const line = state.doc.lineAt(mark.from);
              let from = mark.from;
              let to = mark.to;
              if (mark.from === nFrom) {
                if (/^[ \t]*$/.test(state.sliceDoc(line.from, from))) from = line.from;
              } else {
                from -= /[ \t]*$/.exec(state.sliceDoc(nFrom, from))[0].length;
              }
              to += /^[ \t]*/.exec(state.sliceDoc(to, line.to))[0].length;
              from = Math.max(from, hiddenTo);
              if (to > from) add(from, to, hide);
              hiddenTo = to;
            }
          } else {
            hideMarks(node, ["HeaderMark"], true);
          }
          return;
        }

        if (name in INLINE_STYLES) {
          const cls = INLINE_STYLES[name];
          if (name === "Link") {
            // Content is the label text; hide all link furniture.
            hideMarks(node, ["LinkMark", "URL", "LinkTitle"]);
          } else if (name === "InlineCode") {
            hideMarks(node, ["CodeMark"]);
          } else {
            hideMarks(node, ["EmphasisMark", "StrikethroughMark"]);
          }
          add(nFrom, nTo, markDeco(cls));
          return;
        }

        if (name === "Image") {
          if (rangeActive(state, nFrom, nTo)) return;
          const urlNode = node.node.getChild("URL");
          const text = state.sliceDoc(nFrom, nTo);
          const alt = /!\[([^\]]*)\]/.exec(text)?.[1] ?? "";
          const rawSrc = urlNode ? state.sliceDoc(urlNode.from, urlNode.to) : "";
          const src = resolveImage ? resolveImage(rawSrc) : null;
          add(
            nFrom,
            nTo,
            Decoration.replace({ widget: new ImageWidget(alt, src) }),
          );
          return false;
        }

        if (name === "Blockquote") {
          // Every line in the quote gets the bar; the `>` marks hide on
          // lines away from the cursor.
          const startLine = state.doc.lineAt(nFrom);
          const endLine = state.doc.lineAt(nTo);
          for (let l = startLine.number; l <= endLine.number; l += 1) {
            decorateLine(state.doc.line(l).from, "cm-lp-quote");
          }
          hideMarks(node, ["QuoteMark"], true);
          return;
        }

        if (name === "FencedCode") {
          const startLine = state.doc.lineAt(nFrom);
          const endLine = state.doc.lineAt(nTo);
          for (let l = startLine.number; l <= endLine.number; l += 1) {
            decorateLine(state.doc.line(l).from, "cm-lp-codeblock");
          }
          hideMarks(node, ["CodeMark", "CodeInfo"], true);
          return;
        }

        if (name === "HorizontalRule") {
          if (!lineActive(state, nFrom)) {
            add(nFrom, nTo, hide);
            decorateLine(nFrom, "cm-lp-hr-line");
          }
          return;
        }

        if (name === "TaskMarker") {
          if (!rangeActive(state, nFrom, nTo)) {
            const checked = /[xX]/.test(state.sliceDoc(nFrom, nTo));
            add(
              nFrom,
              nTo,
              Decoration.replace({ widget: new CheckboxWidget(checked, nFrom) }),
            );
          }
          return;
        }

        if (name === "ListMark") {
          if (!lineActive(state, nFrom)) {
            const text = state.sliceDoc(nFrom, nTo);
            if (!/^\d/.test(text)) {
              add(nFrom, nTo, Decoration.replace({ widget: new BulletWidget() }));
            }
          }
          return;
        }

        if (MARK_NODES.has(name)) return false;
        return undefined;
      },
    });
  }
  return RangeSet.of(decos, true);
}

/**
 * Table grids. Block-level widget decorations can't be provided by a
 * ViewPlugin, so tables get their own provider: a StateField feeding
 * `EditorView.decorations`. It iterates the whole document (tables are rare
 * — cheaper than tracking the viewport) and rebuilds when the doc, the
 * editable facet, or the parsed tree changes — the last case also fires
 * when the background parser first reaches a table. The grid is stable:
 * the document cursor moving inside the range no longer flips it back to
 * source — the table menu's Markdown view and the editor's Source mode
 * cover that.
 * @param {import("@codemirror/state").EditorState} state
 */
function buildTableDecorations(state) {
  /** @type {{ from: number, to: number, value: Decoration }[]} */
  const decos = [];
  const editable = state.facet(EditorView.editable);
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== "Table") return undefined;
      // Only top-level tables become grids — nested ones (e.g. inside a
      // quote) would overlap the quote's hidden marks.
      if (node.node.parent?.name !== "Document") return false;
      decos.push({
        from: node.from,
        to: node.to,
        value: Decoration.replace({
          widget: new TableWidget(
            state.sliceDoc(node.from, node.to),
            node.from,
            node.to,
            editable,
          ),
          block: true,
        }),
      });
      return false;
    },
  });
  return RangeSet.of(decos, true);
}

const tableGridField = StateField.define({
  /** @param {import("@codemirror/state").EditorState} state */
  create: (state) => buildTableDecorations(state),
  /** @param {RangeSet<Decoration>} value @param {import("@codemirror/state").Transaction} tr */
  update: (value, tr) => {
    const treeChanged = syntaxTree(tr.startState) !== syntaxTree(tr.state);
    const editableChanged =
      tr.startState.facet(EditorView.editable) !==
      tr.state.facet(EditorView.editable);
    if (!tr.docChanged && !treeChanged && !editableChanged) return value;
    return buildTableDecorations(tr.state);
  },
  provide: (f) => [
    EditorView.decorations.from(f),
    // The grid owns the range: arrow-key motion and block selection step
    // over it, and the keymap below is the deliberate way in.
    EditorView.atomicRanges.of((view) => view.state.field(f)),
  ],
});

/**
 * Enter an adjacent table grid from document focus. byLine covers
 * ArrowUp/Down (whole-line adjacency); Left/Right check positions. Returns
 * true when a table claimed the key.
 * @param {EditorView} view @param {1|-1} dir @param {boolean} byLine
 */
function enterAdjacentTable(view, dir, byLine) {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const head = sel.head;
  for (const ctrl of tableControllers(view)) {
    if (ctrl.disposed) continue;
    const firstLine = state.doc.lineAt(ctrl.from).number;
    const lastLine = state.doc.lineAt(ctrl.to).number;
    const curLine = state.doc.lineAt(head).number;
    if (byLine) {
      if (
        dir > 0 &&
        (curLine === firstLine - 1 || (head >= ctrl.from && head < ctrl.to))
      ) {
        ctrl.focusDocPosition(ctrl.from);
        return true;
      }
      if (
        dir < 0 &&
        (curLine === lastLine + 1 || (head > ctrl.from && head <= ctrl.to))
      ) {
        ctrl.focusDocPosition(ctrl.to);
        return true;
      }
    } else {
      if (dir > 0 && head >= ctrl.from - 1 && head < ctrl.to) {
        ctrl.focusDocPosition(ctrl.from);
        return true;
      }
      if (dir < 0 && head > ctrl.from && head <= ctrl.to + 1) {
        ctrl.focusDocPosition(ctrl.to);
        return true;
      }
    }
  }
  return false;
}

/**
 * Keyboard entry into a grid: arrows that would cross the widget boundary
 * focus the edge cell instead of skipping over the atomic range.
 */
const tableEntryKeymap = keymap.of([
  { key: "ArrowRight", run: (view) => enterAdjacentTable(view, 1, false) },
  { key: "ArrowLeft", run: (view) => enterAdjacentTable(view, -1, false) },
  { key: "ArrowDown", run: (view) => enterAdjacentTable(view, 1, true) },
  { key: "ArrowUp", run: (view) => enterAdjacentTable(view, -1, true) },
]);

/**
 * Selection entry hook: a programmatic cursor that lands inside a table
 * range (search, select-all, API) focuses the matching grid cell. Only
 * actual selection transactions trigger this — document edits (local or
 * remote) never refocus anything. Scheduled outside the view update, then
 * rechecked against the LATEST selection: if the user moved on (typed,
 * clicked into a grid textarea or a dialog) before the timer ran, nothing
 * happens.
 */
const tableEntryPlugin = ViewPlugin.fromClass(
  class {
    /** @param {import("@codemirror/view").ViewUpdate} update */
    update(update) {
      if (!update.selectionSet) return;
      const sel = update.state.selection.main;
      if (!sel.empty) return;
      const view = update.view;
      const head = sel.head;
      setTimeout(() => {
        if (!view.dom.isConnected) return;
        const latest = view.state.selection.main;
        if (!latest.empty || latest.head !== head) return;
        const active = document.activeElement;
        if (
          active instanceof Element &&
          active.closest(
            "textarea, input, .md-table-dialog, [data-slot='dropdown-menu'], [data-slot='dialog-overlay']",
          )
        ) {
          return;
        }
        for (const ctrl of tableControllers(view)) {
          if (ctrl.disposed) continue;
          if (head > ctrl.from && head < ctrl.to) {
            ctrl.focusDocPosition(head);
            return;
          }
        }
      }, 0);
    }
  },
);

/**
 * @param {{ resolveImage?: (src: string) => string | null }} [opts]
 */
export function markdownLivePreview(opts = {}) {
  const { resolveImage } = opts;
  const plugin = ViewPlugin.fromClass(
    class {
      /** @param {EditorView} view */
      constructor(view) {
        this.decorations = buildDecorations(view, resolveImage);
      }
      /** @param {import("@codemirror/view").ViewUpdate} update */
      update(update) {
        if (
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged ||
          syntaxTree(update.startState) !== syntaxTree(update.state)
        ) {
          this.decorations = buildDecorations(update.view, resolveImage);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
  return [plugin, tableGridField, tableEntryKeymap, tableEntryPlugin];
}
