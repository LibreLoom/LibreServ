/**
 * MarkdownTableEditor — the React surface of the pipe-table widget. All
 * document state lives in TableController (markdownTables.js); this file is
 * view + input only, so the grid, the expanded workspace and the dialogs
 * can never fork the model. Rendered both inline (inside the CodeMirror
 * widget) and, when expanded, inside a ModalCard portal — the same
 * controller drives both.
 *
 * Cell text is rendered as sanitized inline Markdown (no block elements,
 * no raw HTML, no fetched images); editing shows the inline source.
 */

import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import PropTypes from "prop-types";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import {
  Bold,
  ChevronDown,
  Code,
  Grid2x2,
  Italic,
  Keyboard,
  Link2,
  Maximize2,
  Minimize2,
  Minus,
  Strikethrough,
} from "lucide-react";
import Button from "../ui/Button.jsx";
import { Tooltip } from "../ui/Tooltip.jsx";
import Dropdown from "../common/Dropdown.jsx";
import Toggle from "../common/Toggle.jsx";
import ModalCard, { NESTED_OVERLAY_CLASS } from "../cards/ModalCard.jsx";
import ConfirmModal from "../cards/ConfirmModal.jsx";
import { applyMarkdownAction } from "../../lib/markdown.js";
import {
  encodeTableCell,
  MAX_CLIPBOARD_COLS,
  paddedCellEstimate,
  parseTableClipboard,
  parseTableDocument,
  tableCellValue,
  TABLE_CLIPBOARD_MIME,
  validateTableRows,
} from "./markdownTableModel.js";
import { ICON_SIZE } from "@/lib/ui-tokens";
import { cn } from "@/lib/utils";
import "./markdownTables.css";

const MIN_COL_PX = 120;
const DEFAULT_COL_PX = 180;
const GUTTER_PX = 40;
const MAX_IMPORT_CELLS = 20000;
const MAX_IMPORT_BYTES = 1048576;
const TAP_SLOP_PX = 10;

/**
 * Elements kept inside a rendered cell. The cell source is wrapped in a
 * synthetic one-column table so remarkGfm gives inline escapes (`\|`,
 * `\*`), code spans and links their real GFM treatment — the structural
 * tags are unwrapped straight through, so the DOM stays inline.
 */
const CELL_ELEMENTS = [
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "em",
  "strong",
  "del",
  "s",
  "code",
  "a",
  "img",
  "br",
];

const cellMarkdownComponents = {
  thead: () => null,
  table: ({ children }) => <>{children}</>,
  tbody: ({ children }) => <>{children}</>,
  tr: ({ children }) => <>{children}</>,
  td: ({ children }) => <>{children}</>,
  // Links render inert (no navigation hijack of the editor); unsafe
  // protocols are already neutralized by the default URL transform.
  a: ({ href, children }) => (
    <a href={href} className="md-table-link" onClick={(e) => e.preventDefault()}>
      {children}
    </a>
  ),
  // Never fetch external images inside the editor — show a text chip.
  img: ({ alt }) => (
    <span className="md-table-imgchip">
      {alt ? `image: ${alt}` : "image"}
    </span>
  ),
};

/** Sanitized inline Markdown for one cell, parsed in a real GFM table. */
function InlineMarkdownCell({ text }) {
  if (!text.trim()) return <span aria-hidden="true">{" "}</span>;
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeSanitize]}
      allowedElements={CELL_ELEMENTS}
      unwrapDisallowed
      components={cellMarkdownComponents}
    >
      {`| |\n| --- |\n| ${encodeTableCell(text)} |`}
    </ReactMarkdown>
  );
}

InlineMarkdownCell.propTypes = { text: PropTypes.string.isRequired };

const InlineMarkdown = memo(InlineMarkdownCell);

const composing = (e) =>
  e.nativeEvent?.isComposing || e.isComposing || e.key === "Process";

const FORMAT_KEYS = { b: "bold", i: "italic", k: "link" };

/**
 * @param {{
 *   controller: import("./markdownTables.js").TableController,
 *   snap: object,
 *   gridRef: import("react").RefObject<HTMLDivElement | null>,
 *   expanded?: boolean,
 * }} props
 */
function TableGrid({ controller, snap, gridRef, expanded = false }) {
  const textareaRef = useRef(null);
  // Touch taps are decided on pointerUP with a movement slop — a horizontal
  // swipe through the grid scrolls the table instead of opening an editor.
  const touchTap = useRef(null);
  const lastTouchMs = useRef(0);
  const resizeCleanup = useRef(null);
  // Event handlers read live controller state — several keys can fire
  // between React renders (rapid Tab/arrows), and a render-closure snap
  // would move the selection from stale coordinates.
  const active = snap.active;
  const colWidths = useMemo(
    () =>
      Array.from(
        { length: snap.cols },
        (_, c) => snap.widths[c] ?? DEFAULT_COL_PX,
      ),
    [snap.cols, snap.widths],
  );
  const gridMinW = GUTTER_PX + colWidths.reduce((a, b) => a + b, 0);

  // Drop any in-flight column-resize listeners when the grid unmounts.
  useEffect(() => () => resizeCleanup.current?.(), []);

  // Focus the freshly mounted editor; a replacement draft (typing over a
  // cell) leaves the caret at the end of the seed character.
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.focus();
      const len = ta.value.length;
      ta.setSelectionRange(len, len);
    }
  }, [snap.editing?.r, snap.editing?.c]);

  // Auto-grow the editor to its wrapped height.
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, [snap.draft?.text, snap.editing]);

  /** @param {string} action */
  const wrapTextarea = (action) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const res = applyMarkdownAction(ta.value, ta.selectionStart, ta.selectionEnd, action);
    controller.setDraft(res.text);
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(res.start, res.end);
      }
    });
  };

  // Expose imperative bits the controller can't reach through state.
  useEffect(() => {
    controller.attachUI({
      focusCell: (r, c) => {
        /** @type {HTMLElement | null} */ (
          gridRef.current?.querySelector(`[data-cell="${r},${c}"]`)
        )?.focus({ preventScroll: false });
      },
      focusDock: () => {
        // An explicit dock jump wins over a queued cell-focus request —
        // otherwise a pending render could steal focus right back.
        // .md-table-body (not .md-table-root) so the expanded workspace's
        // portalled dialog is found too.
        controller.takeFocusRequest();
        /** @type {HTMLElement | null} */ (
          gridRef.current
            ?.closest(".md-table-body")
            ?.querySelector(".md-table-dock button, .md-table-dock [data-slot='dropdown-trigger']")
        )?.focus();
      },
      wrapTextarea,
    });
    return () => controller.attachUI(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, snap.editing]);

  /**
   * The shared select-or-edit gesture. A draft open on ANOTHER cell commits
   * first — a refused commit keeps the conflict visible and the pointer
   * gesture does not move the selection over unsaved text.
   */
  const tapCell = (r, c, shiftKey) => {
    const s = controller;
    if (shiftKey) {
      s.select(s.selection.anchor, { r, c });
      return;
    }
    if (s.draft && (s.draft.r !== r || s.draft.c !== c) && !s.commitDraft(null)) {
      return;
    }
    const { anchor, head } = s.selection;
    const wasSingle =
      anchor.r === r && anchor.c === c && head.r === r && head.c === c && !s.editing;
    if (wasSingle && s.editable) {
      s.startEdit(r, c);
      return;
    }
    s.select({ r, c });
  };

  const onCellMouseDown = (e, r, c) => {
    // Clicks inside the open textarea are caret placement — leave them alone.
    if (e.target instanceof Element && e.target.closest("textarea")) return;
    if (e.button !== 0) return;
    // A touch tap already acted on pointerup — ignore the synthesized mouse.
    if (e.timeStamp - lastTouchMs.current < 700) return;
    e.preventDefault();
    tapCell(r, c, e.shiftKey);
  };

  const onCellDoubleClick = (e, r, c) => {
    if (e.target instanceof Element && e.target.closest("textarea")) return;
    if (controller.editing?.r === r && controller.editing?.c === c) return;
    if (controller.editable) controller.startEdit(r, c);
  };

  const onCellPointerDown = (e, r, c) => {
    if (e.pointerType !== "touch") return;
    if (e.target instanceof Element && e.target.closest("textarea")) return;
    touchTap.current = { x: e.clientX, y: e.clientY, r, c };
  };

  const onCellPointerUp = (e, r, c) => {
    const t = touchTap.current;
    touchTap.current = null;
    if (e.pointerType !== "touch" || !t) return;
    if (e.target instanceof Element && e.target.closest("textarea")) return;
    const moved = Math.hypot(e.clientX - t.x, e.clientY - t.y);
    if (moved > TAP_SLOP_PX || t.r !== r || t.c !== c) return;
    lastTouchMs.current = e.timeStamp;
    // A clean tap edits directly — the select-then-tap two-step was a
    // mouse convention, not a touch one. startEdit refuses (keeping any
    // conflicting draft) rather than dropping text.
    controller.startEdit(r, c);
  };

  const onCellPointerCancel = () => {
    touchTap.current = null;
  };

  const selectRow = (e, r) => {
    const anchor = e.shiftKey ? controller.selection.anchor : { r, c: 0 };
    controller.select(anchor, { r, c: controller.cols - 1 });
  };

  const selectCol = (e, c) => {
    const anchor = e.shiftKey ? controller.selection.anchor : { r: 0, c };
    controller.select(anchor, { r: controller.rows, c });
  };

  const inSel = (r, c) =>
    active &&
    r >= snap.sel.top &&
    r <= snap.sel.bottom &&
    c >= snap.sel.left &&
    c <= snap.sel.right;
  const isHead = (r, c) => snap.selection.head.r === r && snap.selection.head.c === c;
  const isEditing = (r, c) => snap.editing?.r === r && snap.editing?.c === c;

  const moveSel = (dr, dc, extend) => {
    const s = controller;
    const head = {
      r: Math.min(Math.max(s.selection.head.r + dr, 0), s.rows),
      c: Math.min(Math.max(s.selection.head.c + dc, 0), s.cols - 1),
    };
    controller.select(extend ? s.selection.anchor : head, head);
  };

  /**
   * Grid navigation — only when an actual gridcell (not a gutter button,
   * the resize handle, or the open textarea) is the event target, so row
   * and column handles keep their own keyboard behavior.
   */
  const onGridKeyDown = (e) => {
    const t = e.target;
    if (
      !(t instanceof Element) ||
      !t.closest('[role="gridcell"]') ||
      t.closest("textarea")
    ) {
      return;
    }
    if (composing(e)) return;
    const mod = e.metaKey || e.ctrlKey;
    const s = controller;
    const head = s.selection.head;
    switch (e.key) {
      case "ArrowUp": e.preventDefault(); moveSel(-1, 0, e.shiftKey); return;
      case "ArrowDown": e.preventDefault(); moveSel(1, 0, e.shiftKey); return;
      case "ArrowLeft": e.preventDefault(); moveSel(0, -1, e.shiftKey); return;
      case "ArrowRight": e.preventDefault(); moveSel(0, 1, e.shiftKey); return;
      case "Home":
        e.preventDefault();
        if (mod) controller.select(e.shiftKey ? s.selection.anchor : { r: 0, c: 0 }, { r: 0, c: 0 });
        else {
          const t2 = { r: head.r, c: 0 };
          controller.select(e.shiftKey ? s.selection.anchor : t2, t2);
        }
        return;
      case "End":
        e.preventDefault();
        if (mod) {
          const t2 = { r: s.rows, c: s.cols - 1 };
          controller.select(e.shiftKey ? s.selection.anchor : t2, t2);
        } else {
          const t2 = { r: head.r, c: s.cols - 1 };
          controller.select(e.shiftKey ? s.selection.anchor : t2, t2);
        }
        return;
      case "Enter":
      case "F2":
        e.preventDefault();
        controller.startEdit(head.r, head.c);
        return;
      case "F6":
        e.preventDefault();
        controller.ui?.focusDock?.();
        return;
      case "Escape":
        e.preventDefault();
        controller.exit("after");
        return;
      case "Tab":
        e.preventDefault();
        controller.gridTab(e.shiftKey ? -1 : 1);
        return;
      case "Delete":
      case "Backspace":
        e.preventDefault();
        controller.clearSelection();
        return;
      default:
        break;
    }
    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      controller.selectAll();
      return;
    }
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) controller.redo();
      else controller.undo();
      return;
    }
    if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      controller.redo();
      return;
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === "x") {
      e.preventDefault();
      controller.toolbarAction("strikethrough");
      return;
    }
    if (mod && FORMAT_KEYS[e.key.toLowerCase()]) {
      e.preventDefault();
      controller.toolbarAction(FORMAT_KEYS[e.key.toLowerCase()]);
      return;
    }
    if (
      e.key.length === 1 &&
      !mod &&
      !e.altKey &&
      s.editable &&
      !s.editing
    ) {
      e.preventDefault();
      controller.startEdit(head.r, head.c, e.key);
    }
  };

  /** Editor keys — cell commit/cancel + text caret stays native. */
  const onEditorKeyDown = (e) => {
    e.stopPropagation();
    if (composing(e)) return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "Enter") {
      e.preventDefault();
      controller.commitDraft(e.shiftKey ? "up" : "down");
    } else if (e.key === "Tab") {
      e.preventDefault();
      controller.commitDraft(e.shiftKey ? "prev" : "next");
    } else if (e.key === "Escape") {
      e.preventDefault();
      controller.cancelDraft();
    } else if (e.key === "F6") {
      e.preventDefault();
      // Stash the textarea range before focus leaves — the next dock format
      // action applies to the text the user had selected.
      controller.retainSelection(
        e.currentTarget.selectionStart,
        e.currentTarget.selectionEnd,
      );
      controller.ui?.focusDock?.();
    } else if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) controller.redo();
      else controller.undo();
    } else if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      controller.redo();
    } else if (mod && e.shiftKey && e.key.toLowerCase() === "x") {
      e.preventDefault();
      controller.toolbarAction("strikethrough");
    } else if (mod && FORMAT_KEYS[e.key.toLowerCase()]) {
      e.preventDefault();
      controller.toolbarAction(FORMAT_KEYS[e.key.toLowerCase()]);
    }
  };

  const onEditorBlur = (e) => {
    controller.retainSelection(e.target.selectionStart, e.target.selectionEnd);
    controller.commitDraft(null);
  };

  const onEditorPaste = (e) => {
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (!/[\r\n]/.test(text)) return; // ordinary single-line paste
    e.preventDefault();
    const ta = e.currentTarget;
    const flat = text.replace(/\r\n|\r|\n/g, " ");
    ta.setRangeText(flat, ta.selectionStart, ta.selectionEnd, "end");
    controller.setDraft(ta.value);
    controller.flash(
      "Line breaks became spaces — Markdown table cells are single-line.",
    );
  };

  const onGridCopy = (e) => {
    if (e.target instanceof HTMLTextAreaElement) return;
    const data = e.clipboardData;
    if (!data) return;
    e.preventDefault();
    try {
      data.setData("text/plain", controller.selectionTSV());
      data.setData(TABLE_CLIPBOARD_MIME, controller.selectionClipboardJSON());
    } catch {
      /* a clipboard that refuses writes still shouldn't break the grid */
    }
  };

  const onGridCut = (e) => {
    if (e.target instanceof HTMLTextAreaElement) return;
    const data = e.clipboardData;
    if (!data) return;
    e.preventDefault();
    try {
      data.setData("text/plain", controller.selectionTSV());
      data.setData(TABLE_CLIPBOARD_MIME, controller.selectionClipboardJSON());
    } catch {
      return; // clipboard write failed — nothing is removed
    }
    controller.clearSelection();
  };

  const onGridPaste = (e) => {
    if (e.target instanceof HTMLTextAreaElement) return;
    const data = e.clipboardData;
    if (!data) return;
    const own = data.getData(TABLE_CLIPBOARD_MIME);
    if (own && own.length <= MAX_IMPORT_BYTES) {
      try {
        const payload = JSON.parse(own);
        if (payload?.version === 1 && Array.isArray(payload?.rows)) {
          e.preventDefault();
          const invalid = validateTableRows(payload.rows);
          if (invalid) controller.flash(invalid);
          else controller.pasteRows(payload.rows);
          return;
        }
      } catch {
        /* fall through to the plain-text path */
      }
    }
    const text = data.getData("text/plain") ?? "";
    if (!text) return;
    e.preventDefault();
    controller.pasteText(text);
  };

  const startResize = (e, c) => {
    if (e.button !== 0 && e.pointerType !== "touch") return;
    e.preventDefault();
    e.stopPropagation();
    resizeCleanup.current?.();
    const startX = e.clientX;
    const th = e.currentTarget.closest("th");
    const startW =
      th?.getBoundingClientRect().width ||
      controller.widths[c] ||
      DEFAULT_COL_PX;
    const sep = e.currentTarget;
    const pid = e.pointerId;
    const onMove = (ev) => {
      controller.setWidth(c, Math.max(MIN_COL_PX, Math.round(startW + ev.clientX - startX)));
    };
    const end = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", end);
      document.removeEventListener("pointercancel", end);
      sep.removeEventListener("lostpointercapture", end);
      try {
        sep.releasePointerCapture?.(pid);
      } catch {
        /* already released */
      }
      if (resizeCleanup.current === end) resizeCleanup.current = null;
    };
    try {
      sep.setPointerCapture?.(pid);
    } catch {
      /* jsdom */
    }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", end);
    document.addEventListener("pointercancel", end);
    sep.addEventListener("lostpointercapture", end);
    resizeCleanup.current = end;
  };

  const onSepKeyDown = (e, c) => {
    e.stopPropagation();
    const step = e.shiftKey ? 40 : 8;
    const cur = controller.widths[c] ?? DEFAULT_COL_PX;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      controller.setWidth(c, Math.max(MIN_COL_PX, cur - step));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      controller.setWidth(c, cur + step);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      controller.setWidth(c, null);
    }
  };

  const cellLabel = (r, c) =>
    r === 0 ? `Column ${c + 1} heading` : `Row ${r}, column ${c + 1}`;

  const cellProps = (r, c) => ({
    role: "gridcell",
    "data-cell": `${r},${c}`,
    "aria-label": cellLabel(r, c),
    "aria-selected": inSel(r, c) || undefined,
    tabIndex: isHead(r, c) ? 0 : -1,
    className: cn(
      "md-table-cell",
      r === 0 && "md-table-cell-head",
      snap.model.align[c] && `md-align-${snap.model.align[c]}`,
    ),
    onMouseDown: (e) => onCellMouseDown(e, r, c),
    onDoubleClick: (e) => onCellDoubleClick(e, r, c),
    onPointerDown: (e) => onCellPointerDown(e, r, c),
    onPointerUp: (e) => onCellPointerUp(e, r, c),
    onPointerCancel: onCellPointerCancel,
  });

  const cellBody = (r, c) =>
    isEditing(r, c) ? (
      <textarea
        ref={textareaRef}
        className="md-table-editor"
        value={snap.draft?.text ?? ""}
        readOnly={!snap.editable}
        rows={1}
        aria-label={`Edit ${cellLabel(r, c)}`}
        onChange={(e) => controller.setDraft(e.target.value)}
        onKeyDown={onEditorKeyDown}
        onBlur={onEditorBlur}
        onPaste={onEditorPaste}
      />
    ) : (
      <InlineMarkdown text={tableCellValue(snap.model, r, c)} />
    );

  return (
    <div
      className={cn("md-table-scroll", expanded && "md-table-scroll-expanded")}
      ref={gridRef}
      onKeyDown={onGridKeyDown}
      onFocus={(e) => {
        if (e.target instanceof Element && e.target.closest('[role="gridcell"]')) {
          controller.noteGridFocus();
        }
      }}
      onCopy={onGridCopy}
      onCut={onGridCut}
      onPaste={onGridPaste}
    >
      <table
        className="md-table-grid cm-lp-table"
        style={{ minWidth: `${gridMinW}px` }}
        role="grid"
        aria-rowcount={snap.rows + 1}
        aria-colcount={snap.cols}
        aria-label="Markdown table"
        aria-readonly={!snap.editable}
      >
        <colgroup>
          <col className="md-table-guttercol" style={{ width: `${GUTTER_PX}px` }} />
          {colWidths.map((w, c) => (
            <col key={c} style={{ width: `${w}px` }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th className="md-table-gutter md-table-corner" scope="col">
              <button
                type="button"
                className="md-table-rowsel"
                aria-label="Select whole table"
                onClick={() => controller.selectAll()}
                onKeyDown={(e) => e.stopPropagation()}
              >
                <Grid2x2 size={ICON_SIZE.sm} aria-hidden="true" />
              </button>
            </th>
            {snap.model.header.map((_, c) => (
              <th
                key={c}
                scope="col"
                className={cn(
                  "md-table-th",
                  inSel(0, c) && "md-sel",
                  active && isHead(0, c) && "md-head",
                )}
                aria-selected={inSel(0, c) || undefined}
              >
                <div className="md-table-thwrap">
                  <button
                    type="button"
                    className="md-table-colsel"
                    aria-label={`Select column ${c + 1}`}
                    title={`Select column ${c + 1}`}
                    onClick={(e) => selectCol(e, c)}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    <ChevronDown size={ICON_SIZE.sm} aria-hidden="true" />
                  </button>
                  <div {...cellProps(0, c)}>{cellBody(0, c)}</div>
                  {snap.editable && (
                    <span
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={`Resize column ${c + 1}`}
                      tabIndex={0}
                      className="md-table-colsep"
                      onPointerDown={(e) => startResize(e, c)}
                      onKeyDown={(e) => onSepKeyDown(e, c)}
                      onDoubleClick={() => controller.setWidth(c, null)}
                    />
                  )}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {snap.model.body.map((_, ri) => {
            const r = ri + 1;
            return (
              <tr key={r}>
                <th scope="row" className="md-table-gutter">
                  <button
                    type="button"
                    className="md-table-rowsel"
                    aria-label={`Select row ${r}`}
                    onClick={(e) => selectRow(e, r)}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    {r}
                  </button>
                </th>
                {snap.model.body[ri].map((_, c) => (
                  <td
                    key={c}
                    className={cn(
                      "md-table-td",
                      inSel(r, c) && "md-sel",
                      active && isHead(r, c) && "md-head",
                    )}
                    aria-selected={inSel(r, c) || undefined}
                  >
                    <div {...cellProps(r, c)}>{cellBody(r, c)}</div>
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

TableGrid.propTypes = {
  controller: PropTypes.object.isRequired,
  snap: PropTypes.object.isRequired,
  gridRef: PropTypes.shape({ current: PropTypes.object }),
  expanded: PropTypes.bool,
};

/**
 * A command menu built on the shared Dropdown primitive.
 * @param {{ label: string, options: {value:string,label:string}[], onCommand: (v: string) => void, disabled?: boolean, tooltip?: string }} props
 */
function CommandMenu({ label, options, onCommand, disabled, tooltip }) {
  const button = (
    <Dropdown
      options={options}
      value="__none__"
      placeholder={label}
      onChange={onCommand}
      disabled={disabled || !options.length}
      ghost
      className="md-table-menu"
      aria-label={label}
    />
  );
  return tooltip ? <Tooltip content={tooltip}>{button}</Tooltip> : button;
}

CommandMenu.propTypes = {
  label: PropTypes.string.isRequired,
  options: PropTypes.array.isRequired,
  onCommand: PropTypes.func.isRequired,
  disabled: PropTypes.bool,
  tooltip: PropTypes.string,
};

const ALIGN_OPTIONS = [
  { value: "", label: "Align: default" },
  { value: "left", label: "Align left" },
  { value: "center", label: "Align center" },
  { value: "right", label: "Align right" },
];

function selectionLabel(snap) {
  const { sel, selection } = snap;
  const name = (r, c) => (r === 0 ? `heading C${c + 1}` : `R${r} C${c + 1}`);
  if (sel.top === sel.bottom && sel.left === sel.right) {
    return `${snap.cols} ${snap.cols === 1 ? "column" : "columns"} · ${snap.rows} ${snap.rows === 1 ? "row" : "rows"} — ${name(selection.head.r, selection.head.c)}`;
  }
  const rowPart =
    sel.top === 0
      ? sel.bottom === 0
        ? "heading"
        : `heading–R${sel.bottom}`
      : sel.top === sel.bottom
        ? `R${sel.top}`
        : `R${sel.top}–R${sel.bottom}`;
  const colPart =
    sel.left === sel.right ? `C${sel.left + 1}` : `C${sel.left + 1}–C${sel.right + 1}`;
  return `${snap.cols} ${snap.cols === 1 ? "column" : "columns"} · ${snap.rows} ${snap.rows === 1 ? "row" : "rows"} — ${rowPart} ${colPart}`;
}

/** @param {{ controller: object, snap: object }} props */
function DockBar({ controller, snap }) {
  const sel = snap.sel;
  const aligns = new Set();
  for (let c = sel.left; c <= sel.right; c += 1) {
    aligns.add(snap.model.align[c] ?? "");
  }
  const alignMixed = aligns.size > 1;
  const align = alignMixed ? "__mixed__" : ([...aligns][0] ?? "");
  const fmt = (action) => controller.toolbarAction(action);

  // Menus only offer what can actually run: boundary-invalid moves and a
  // whole-table column delete are filtered out instead of silently no-oping.
  const rowLo = Math.max(sel.top, 1);
  const rowHi = Math.min(sel.bottom, snap.rows);
  const hasBodyRows = rowLo <= rowHi;
  const rowOptions = [
    { value: "insertAbove", label: "Insert row above" },
    { value: "insertBelow", label: "Insert row below" },
    ...(hasBodyRows && rowLo > 1
      ? [{ value: "moveUp", label: "Move row up" }]
      : []),
    ...(hasBodyRows && rowHi < snap.rows
      ? [{ value: "moveDown", label: "Move row down" }]
      : []),
    ...(hasBodyRows
      ? [
          { value: "duplicate", label: "Duplicate row(s)" },
          { value: "clear", label: "Clear row(s)" },
          { value: "delete", label: "Delete row(s)" },
        ]
      : []),
  ];
  const allColsSelected = sel.left === 0 && sel.right === snap.cols - 1;
  const rowCount = Math.max(0, rowHi - rowLo + 1);
  const colCount = sel.right - sel.left + 1;
  const deleteOptions = [
    ...(hasBodyRows
      ? [{ value: "rows", label: rowCount === 1 ? "Delete row" : `Delete ${rowCount} rows` }]
      : []),
    ...(!allColsSelected
      ? [{ value: "columns", label: colCount === 1 ? "Delete column" : `Delete ${colCount} columns` }]
      : []),
    { value: "clear", label: "Clear cell contents" },
    { value: "table", label: "Delete table…" },
  ];
  const colOptions = [
    { value: "insertLeft", label: "Insert column left" },
    { value: "insertRight", label: "Insert column right" },
    ...(sel.left > 0 ? [{ value: "moveLeft", label: "Move column left" }] : []),
    ...(sel.right < snap.cols - 1
      ? [{ value: "moveRight", label: "Move column right" }]
      : []),
    { value: "duplicate", label: "Duplicate column(s)" },
    { value: "fit", label: "Fit width" },
    { value: "resetWidth", label: "Reset width" },
    ...(sel.left === sel.right
      ? [
          { value: "sortAsc", label: "Sort rows A→Z by this column" },
          { value: "sortDesc", label: "Sort rows Z→A by this column" },
        ]
      : []),
    { value: "clear", label: "Clear column(s)" },
    ...(snap.cols > 1 && !allColsSelected
      ? [{ value: "delete", label: "Delete column(s)" }]
      : []),
  ];
  const tableOptions = [
    { value: "expand", label: snap.expanded ? "Shrink to document" : "Expand workspace" },
    { value: "import", label: "Import CSV / TSV…" },
    { value: "export", label: "Export…" },
    { value: "copyMd", label: "Copy Markdown" },
    { value: "source", label: "Markdown source…" },
    { value: "help", label: "Keyboard shortcuts…" },
    { value: "deleteTable", label: "Delete table…" },
  ];

  const runRow = (v) => {
    if (v === "insertAbove") controller.insertRowCommand("above");
    else if (v === "insertBelow") controller.insertRowCommand("below");
    else if (v === "moveUp") controller.moveRowCommand(-1);
    else if (v === "moveDown") controller.moveRowCommand(1);
    else if (v === "duplicate") controller.duplicateRowCommand();
    else if (v === "clear") controller.clearRowCommand();
    else if (v === "delete") controller.deleteRowCommand();
  };
  const runCol = (v) => {
    const srect = controller.selRect();
    if (v === "insertLeft") controller.insertColCommand("left");
    else if (v === "insertRight") controller.insertColCommand("right");
    else if (v === "moveLeft") controller.moveColCommand(-1);
    else if (v === "moveRight") controller.moveColCommand(1);
    else if (v === "duplicate") controller.duplicateColCommand();
    else if (v === "fit") controller.fitSelectedColumns();
    else if (v === "resetWidth") {
      for (let c = srect.left; c <= srect.right; c += 1) controller.setWidth(c, null);
    } else if (v === "sortAsc") controller.sortCommand(1);
    else if (v === "sortDesc") controller.sortCommand(-1);
    else if (v === "clear") controller.clearColCommand();
    else if (v === "delete") controller.deleteColCommand();
  };
  const runTable = (v) => {
    if (v === "expand") controller.setExpanded(!controller.expanded);
    else if (v === "import") controller.setDialog("import");
    else if (v === "export") controller.setDialog("export");
    else if (v === "source") controller.setDialog("source");
    else if (v === "help") controller.setDialog("help");
    else if (v === "deleteTable") controller.setDialog("delete");
    else if (v === "copyMd") void controller.copyMarkdown();
  };

  const formatButtons = [
    { action: "bold", Icon: Bold, label: "Bold" },
    { action: "italic", Icon: Italic, label: "Italic" },
    { action: "strikethrough", Icon: Strikethrough, label: "Strikethrough" },
    { action: "code", Icon: Code, label: "Code" },
    { action: "link", Icon: Link2, label: "Link" },
  ];

  return (
    <div
      className="md-table-dock"
      role="toolbar"
      aria-label="Table tools"
      onMouseDown={(e) => {
        // Keep the open cell editor's text selection alive while a dock
        // control is clicked — formatting reads the live textarea range.
        const t = e.target;
        if (t instanceof Element && t.closest("input, textarea, select")) return;
        e.preventDefault();
      }}
      onKeyDown={(e) => {
        if (e.key === "F6" || e.key === "Escape") {
          e.preventDefault();
          const h = controller.selection.head;
          controller.ui?.focusCell?.(h.r, h.c);
        }
      }}
    >
      <span className="md-table-status" aria-live="polite">
        <span className="md-table-coords">{selectionLabel(snap)}</span>
        {snap.active && snap.editable && !snap.editing && (
          <span className="md-table-hint"> · Type to replace · Enter to edit</span>
        )}
        {snap.editing && (
          <span className="md-table-hint"> · Enter commits · Esc cancels</span>
        )}
      </span>
      {snap.editable && (
        <div className="md-table-actions">
          <Button variant="outline" surface="secondary" size="sm" onClick={() => controller.appendRow()}>
            Add row
          </Button>
          <Button variant="outline" surface="secondary" size="sm" onClick={() => controller.appendCol()}>
            Add column
          </Button>
          <CommandMenu
            label="Delete"
            options={deleteOptions}
            tooltip="Delete selected rows or columns, or clear cell contents"
            onCommand={(v) => {
              if (v === "rows") controller.deleteRowCommand();
              else if (v === "columns") controller.deleteColCommand();
              else if (v === "clear") controller.clearSelection();
              else if (v === "table") controller.setDialog("delete");
            }}
          />
          <span className="md-table-sep" aria-hidden="true" />
          <span className="md-table-wideonly">
            {formatButtons.map(({ action, Icon, label }) => (
              <Tooltip key={action} content={label}>
                <Button
                  variant="ghost"
                  surface="secondary"
                  size="iconSm"
                  aria-label={label}
                  onClick={() => fmt(action)}
                >
                  <Icon size={ICON_SIZE.md} aria-hidden="true" />
                </Button>
              </Tooltip>
            ))}
          </span>
          <span className="md-table-wideonly">
            <Dropdown
              options={ALIGN_OPTIONS}
              value={align}
              placeholder={alignMixed ? "Align: Mixed" : "Column alignment"}
              onChange={(v) => controller.alignCommand(v)}
              ghost
              className="md-table-menu"
              aria-label="Column alignment"
            />
          </span>
          <span className="md-table-narrowonly">
            <CommandMenu
              label="Format"
              options={[
                { value: "bold", label: "Bold" },
                { value: "italic", label: "Italic" },
                { value: "strikethrough", label: "Strikethrough" },
                { value: "code", label: "Code" },
                { value: "link", label: "Link" },
                ...ALIGN_OPTIONS.map((o) => ({ value: `align:${o.value}`, label: o.label })),
              ]}
              onCommand={(v) => {
                if (v.startsWith("align:")) controller.alignCommand(v.slice(6));
                else fmt(v);
              }}
            />
          </span>
          <span className="md-table-sep" aria-hidden="true" />
          <CommandMenu label="Row" options={rowOptions} onCommand={runRow} />
          <CommandMenu label="Column" options={colOptions} onCommand={runCol} />
          <CommandMenu label="Table" options={tableOptions} onCommand={runTable} />
          <span className="md-table-sep" aria-hidden="true" />
          <Tooltip content={snap.expanded ? "Shrink to document" : "Expand workspace"}>
            <Button
              variant="ghost"
              surface="secondary"
              size="iconSm"
              aria-label={snap.expanded ? "Shrink table to document" : "Expand table workspace"}
              onClick={() => controller.setExpanded(!snap.expanded)}
            >
              {snap.expanded ? (
                <Minimize2 size={ICON_SIZE.md} aria-hidden="true" />
              ) : (
                <Maximize2 size={ICON_SIZE.md} aria-hidden="true" />
              )}
            </Button>
          </Tooltip>
          <Tooltip content="Keyboard shortcuts">
            <Button
              variant="ghost"
              surface="secondary"
              size="iconSm"
              aria-label="Table keyboard shortcuts"
              onClick={() => controller.setDialog("help")}
            >
              <Keyboard size={ICON_SIZE.md} aria-hidden="true" />
            </Button>
          </Tooltip>
        </div>
      )}
    </div>
  );
}

DockBar.propTypes = {
  controller: PropTypes.object.isRequired,
  snap: PropTypes.object.isRequired,
};

/** Remote-edit conflict banner — never silently overwrite a live draft. */
function ConflictBar({ controller, snap }) {
  const conflict = snap.conflict;
  return (
    <div className="md-table-conflict" role="alert">
      <span>
        {conflict.kind === "cell"
          ? `This cell changed while you were editing — newer text: “${conflict.remote ?? ""}”.`
          : "The table's rows or columns changed while you were editing, so your draft can't be written back automatically."}
      </span>
      <span className="md-table-conflict-actions">
        {conflict.kind === "cell" && (
          <Button variant="outline" surface="primary" size="sm" onClick={() => controller.resolveConflict("mine")}>
            Keep mine
          </Button>
        )}
        <Button variant="outline" surface="primary" size="sm" onClick={() => void controller.resolveConflict("copy")}>
          Copy my text
        </Button>
        <Button variant="outline" surface="primary" size="sm" onClick={() => controller.resolveConflict("theirs")}>
          Use updated
        </Button>
      </span>
    </div>
  );
}

ConflictBar.propTypes = {
  controller: PropTypes.object.isRequired,
  snap: PropTypes.object.isRequired,
};

/** Draft text recovered from a torn-down widget — offered, never applied. */
function RecoveryBar({ controller, snap }) {
  const items = snap.recovered;
  if (!items?.length) return null;
  return (
    <div className="md-table-recovery" role="status">
      <span>
        {items.length === 1
          ? "An unsaved cell edit survived a table change:"
          : `${items.length} unsaved cell edits survived a table change:`}
        {" “"}
        {items[items.length - 1].text}
        {"”"}
      </span>
      <span className="md-table-recovery-actions">
        <Button
          variant="outline"
          surface="primary"
          size="sm"
          onClick={() => void controller.copyRecovered()}
        >
          Copy text
        </Button>
        <Button
          variant="ghost"
          surface="primary"
          size="sm"
          onClick={() => controller.dismissRecovered()}
        >
          Dismiss
        </Button>
      </span>
    </div>
  );
}

RecoveryBar.propTypes = {
  controller: PropTypes.object.isRequired,
  snap: PropTypes.object.isRequired,
};

const IMPORT_FORMATS = [
  { value: "auto", label: "Auto-detect" },
  { value: "csv", label: "CSV (commas)" },
  { value: "tsv", label: "TSV (tabs)" },
  { value: "markdown", label: "Markdown table" },
];

/**
 * Shared import dialog — used by the table menu (paste at the selection /
 * replace the table) and by the MarkdownEditor toolbar (create a table from
 * CSV/TSV data). Nothing mutates until an apply button is pressed, the
 * preview parses cleanly, and the host's onApply accepts (returns true).
 *
 * @param {{
 *   open: boolean,
 *   onClose: () => void,
 *   onApply: (rows: string[][], firstRowHeadings: boolean, mode: "insert" | "replace") => boolean | void,
 *   replace?: boolean,
 *   notice?: string | null,
 * }} props
 */
export function TableImportDialog({ open, onClose, onApply, replace = false, notice = null }) {
  const [text, setText] = useState("");
  const [format, setFormat] = useState("auto");
  const [firstRow, setFirstRow] = useState(true);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);

  // Fresh draft each time the dialog opens (render-phase adjust pattern —
  // the same one MarkdownEditor uses for mode flips).
  const [prevOpen, setPrevOpen] = useState(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    if (open) {
      setText("");
      setFormat("auto");
      setFirstRow(true);
      setError(null);
    }
  }

  const parsed = useMemo(() => {
    if (!text.trim()) return null;
    if (text.length > MAX_IMPORT_BYTES) {
      return {
        error: "That's over 1 MB of data — split it up or add it in smaller chunks.",
      };
    }
    const res = parseTableClipboard(text, format, { sniffCsv: format === "auto" });
    if (res.error) return { error: res.error };
    const cells = res.rows.reduce((n, r) => n + r.length, 0);
    if (cells > MAX_IMPORT_CELLS) {
      return {
        error: `That's ${cells.toLocaleString()} cells — too much for one table. Split the data or use Markdown source.`,
      };
    }
    return res;
  }, [text, format]);

  const preview = parsed && !parsed.error ? parsed.rows : null;
  const cols = preview ? Math.max(...preview.map((r) => r.length)) : 0;

  const apply = (mode) => {
    if (!preview) {
      setError(parsed?.error ?? "Paste or choose a CSV/TSV file first.");
      return;
    }
    // The host decides: a refused apply (stale table, over-limit paste)
    // keeps the dialog open with its notice visible.
    if (onApply(preview, firstRow, mode) === true) onClose();
  };

  return (
    <ModalCard
      open={open}
      onClose={onClose}
      title="Import table data"
      size="lg"
      overlayClassName={NESTED_OVERLAY_CLASS}
    >
      <div className="md-table-dialog">
        <p className="md-table-dialoghint">
          Paste CSV/TSV text or pick a file. Nothing changes until you apply.
        </p>
        <textarea
          className="md-table-sourceta"
          rows={6}
          value={text}
          placeholder={"name,role\nAda,admin"}
          aria-label="Data to import"
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
        />
        <div className="md-table-dialogrow">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values"
            className="md-table-fileinput"
            aria-label="Choose a CSV or TSV file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              if (file.size > MAX_IMPORT_BYTES) {
                setError(
                  "That file is over 1 MB — split it up or paste a smaller range.",
                );
                e.target.value = "";
                return;
              }
              file
                .text()
                .then((t) => {
                  setText(t);
                  setError(null);
                })
                .catch(() => setError("Couldn't read that file — paste the text instead."));
            }}
          />
        </div>
        <div className="md-table-dialogrow md-table-dialogrow-split">
          <Dropdown
            options={IMPORT_FORMATS}
            value={format}
            onChange={setFormat}
            label="Format"
            bg="primary"
            aria-label="Import format"
          />
          <Toggle
            checked={firstRow}
            onChange={setFirstRow}
            label="First row is headings"
            surface="secondary"
          />
        </div>
        {replace && (
          <p className="md-table-dialoghint">
            “First row is headings” applies to Replace table — Paste at
            selection writes the rows exactly as they are.
          </p>
        )}
        {preview && (
          <div className="md-table-preview" role="status">
            <p>
              {cols} {cols === 1 ? "column" : "columns"} · {preview.length}{" "}
              {preview.length === 1 ? "row" : "rows"} detected
              {parsed.normalizedLineBreaks &&
                " — line breaks inside cells will become spaces"}
            </p>
            <div className="md-table-previewscroll">
              <table className="md-table-previewgrid">
                <tbody>
                  {preview.slice(0, 3).map((row, i) => (
                    <tr key={i}>
                      {Array.from({ length: cols }, (_, c) => (
                        <td key={c}>{row[c] ?? ""}</td>
                      ))}
                    </tr>
                  ))}
                  {preview.length > 3 && (
                    <tr>
                      <td colSpan={cols}>…{preview.length - 3} more</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {notice && (
          <p className="md-table-dialogerror" role="alert">
            {notice}
          </p>
        )}
        {(error || parsed?.error) && (
          <p className="md-table-dialogerror" role="alert">
            {error ?? parsed?.error}
          </p>
        )}
        <div className="md-table-dialogbuttons">
          <Button variant="outline" surface="secondary" onClick={onClose}>
            Cancel
          </Button>
          {replace && (
            <Button
              variant="outline"
              surface="secondary"
              disabled={!preview}
              onClick={() => apply("replace")}
            >
              Replace table
            </Button>
          )}
          <Button
            variant="primary"
            surface="secondary"
            disabled={!preview}
            onClick={() => apply("insert")}
          >
            {replace ? "Paste at selection" : "Insert table"}
          </Button>
        </div>
      </div>
    </ModalCard>
  );
}

TableImportDialog.propTypes = {
  open: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onApply: PropTypes.func.isRequired,
  replace: PropTypes.bool,
  notice: PropTypes.string,
};

/** Export dialog: format, spreadsheet-safe toggle, download / copy. */
function TableExportDialog({ controller, snap }) {
  const [format, setFormat] = useState("markdown");
  const [safe, setSafe] = useState(true);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const text = controller.exportText(format, safe);
  const fallbackRef = useRef(null);

  const download = () => {
    const ext = format === "markdown" ? "md" : format;
    const mime =
      format === "markdown"
        ? "text/markdown"
        : format === "csv"
          ? "text/csv"
          : "text/tab-separated-values";
    const blob = new Blob([text], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `table.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copy = async () => {
    if (!navigator.clipboard?.writeText) {
      setCopyFailed(true);
      setTimeout(() => fallbackRef.current?.select(), 0);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setCopyFailed(false);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyFailed(true);
      setTimeout(() => fallbackRef.current?.select(), 0);
    }
  };

  return (
    <ModalCard
      open={snap.dialog === "export"}
      onClose={() => controller.setDialog(null)}
      title="Export table"
      size="md"
      overlayClassName={NESTED_OVERLAY_CLASS}
    >
      <div className="md-table-dialog">
        <div className="md-table-dialogrow md-table-dialogrow-split">
          <Dropdown
            options={[
              { value: "markdown", label: "Markdown" },
              { value: "csv", label: "CSV" },
              { value: "tsv", label: "TSV" },
            ]}
            value={format}
            onChange={setFormat}
            label="Format"
            bg="primary"
            aria-label="Export format"
          />
          {format !== "markdown" && (
            <Toggle
              checked={safe}
              onChange={setSafe}
              label="Spreadsheet-safe export"
              description="Adds ' before cells that look like formulas (=, +, -, @, or leading tabs/line breaks) so common spreadsheet apps don't treat them as formulas — not every app honors it. Only the export changes; the file keeps the original text."
              surface="secondary"
            />
          )}
        </div>
        {copyFailed && (
          <div className="md-table-dialogrow">
            <p className="md-table-dialogerror" role="alert">
              Couldn't reach the clipboard. The text below is selected — press
              Ctrl+C to copy it.
            </p>
            <textarea
              ref={fallbackRef}
              className="md-table-sourceta"
              readOnly
              rows={5}
              value={text}
              aria-label="Exported table text"
              onFocus={(e) => e.target.select()}
            />
          </div>
        )}
        <div className="md-table-dialogbuttons">
          <Button variant="outline" surface="secondary" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button variant="primary" surface="secondary" onClick={download}>
            Download
          </Button>
        </div>
      </div>
    </ModalCard>
  );
}

TableExportDialog.propTypes = {
  controller: PropTypes.object.isRequired,
  snap: PropTypes.object.isRequired,
};

/** Edit the table's raw Markdown — validated draft, apply or cancel. */
function TableSourceDialog({ controller, snap }) {
  const [draft, setDraft] = useState(snap.dialogSource ?? snap.source);
  const [error, setError] = useState(null);

  // Re-seed the draft from the source captured when the dialog opened —
  // remote edits while it sits open do NOT rewrite the textarea, and the
  // stale-edit banner below shows instead.
  const [prevDialog, setPrevDialog] = useState(snap.dialog);
  if (prevDialog !== snap.dialog) {
    setPrevDialog(snap.dialog);
    if (snap.dialog === "source") {
      setDraft(snap.dialogSource ?? snap.source);
      setError(null);
    }
  }

  const stale =
    snap.dialog === "source" &&
    snap.dialogSource != null &&
    snap.source !== snap.dialogSource;

  const apply = () => {
    if (draft.length > MAX_IMPORT_BYTES) {
      setError("That's over 1 MB of source — trim it down first.");
      return;
    }
    const parsed = parseTableDocument(draft, { maxCells: MAX_IMPORT_CELLS });
    if (!parsed) {
      setError(
        paddedCellEstimate(draft) > MAX_IMPORT_CELLS
          ? `That table would need over ${MAX_IMPORT_CELLS.toLocaleString()} cells once the rows are squared up — trim it down first.`
          : "That isn't a valid Markdown table — keep the header row and the | --- | divider row.",
      );
      return;
    }
    if (parsed.model.header.length > MAX_CLIPBOARD_COLS) {
      setError(
        `That's ${parsed.model.header.length} columns — tables cap at ${MAX_CLIPBOARD_COLS}. Split the table first.`,
      );
      return;
    }
    if (controller.replaceSource(draft, snap.dialogSource ?? snap.source)) {
      controller.setDialog(null);
    }
  };

  return (
    <ModalCard
      open={snap.dialog === "source"}
      onClose={() => controller.setDialog(null)}
      title="Table Markdown"
      size="lg"
      overlayClassName={NESTED_OVERLAY_CLASS}
    >
      <div className="md-table-dialog">
        <p className="md-table-dialoghint">
          The raw pipe-table text for this table only. Apply checks it still
          parses — nothing half-typed reaches the document.
        </p>
        <textarea
          className="md-table-sourceta"
          rows={Math.min(14, (snap.dialogSource ?? snap.source).split("\n").length + 2)}
          value={draft}
          aria-label="Table Markdown source"
          spellCheck={false}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
        />
        {stale && (
          <p className="md-table-dialogerror" role="alert">
            The table changed since you opened this — close and reopen to edit
            the latest text.
          </p>
        )}
        {error && (
          <p className="md-table-dialogerror" role="alert">
            {error}
          </p>
        )}
        <div className="md-table-dialogbuttons">
          <Button
            variant="outline"
            surface="secondary"
            onClick={() => controller.setDialog(null)}
          >
            Cancel
          </Button>
          <Button variant="primary" surface="secondary" onClick={apply}>
            Apply
          </Button>
        </div>
      </div>
    </ModalCard>
  );
}

TableSourceDialog.propTypes = {
  controller: PropTypes.object.isRequired,
  snap: PropTypes.object.isRequired,
};

const SHORTCUTS = [
  ["Arrows", "Move the selected cell"],
  ["Shift + Arrows", "Extend the selection"],
  ["Home / End", "First / last column of the row"],
  ["Ctrl+Home / Ctrl+End", "First / last cell of the table"],
  ["Enter or F2", "Edit the selected cell"],
  ["Double-click", "Edit a cell with the mouse"],
  ["Any character", "Replace the cell's text"],
  ["Enter (while editing)", "Commit and move down"],
  ["Shift+Enter (while editing)", "Commit and move up"],
  ["Tab / Shift+Tab", "Commit and move between cells — Tab past the end adds a row"],
  ["Escape", "Cancel the draft, then leave the table"],
  ["Ctrl+B / Ctrl+I / Ctrl+K", "Bold / italic / link the selected text or cells"],
  ["Ctrl+Shift+X", "Strikethrough the selected text or cells"],
  ["Delete / Backspace", "Clear the selected cells"],
  ["Ctrl+A", "Select the whole table"],
  ["Ctrl+Z / Ctrl+Shift+Z", "Undo a draft, then document undo / redo"],
  ["F6", "Jump between the grid and the toolbar"],
  ["Shift+Click", "Select a rectangle of cells"],
];

/** Keyboard reference — a small popover, not a modal. */
function TableHelpPopover({ controller, snap }) {
  const ref = useRef(null);
  useEffect(() => {
    if (snap.dialog !== "help") return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        controller.setDialog(null);
      }
    };
    const onDown = (e) => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) {
        controller.setDialog(null);
      }
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown, true);
    ref.current?.querySelector("button")?.focus();
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.dialog]);

  if (snap.dialog !== "help") return null;
  return createPortal(
    <div ref={ref} className="md-table-help" role="dialog" aria-label="Table keyboard shortcuts">
      <div className="md-table-help-head">
        <h3>Table shortcuts</h3>
        <Button
          variant="ghost"
          surface="secondary"
          size="iconSm"
          aria-label="Close shortcuts"
          onClick={() => controller.setDialog(null)}
        >
          <Minus size={ICON_SIZE.md} aria-hidden="true" />
        </Button>
      </div>
      <dl>
        {SHORTCUTS.map(([keys, desc]) => (
          <div key={keys} className="md-table-help-row">
            <dt>{keys}</dt>
            <dd>{desc}</dd>
          </div>
        ))}
      </dl>
      <p className="md-table-helpnote">
        Cells hold one line of inline Markdown — Shift+Enter commits upward
        rather than forcing a line break. For the raw pipes, use Table ▸
        Markdown source or the editor's Source mode.
      </p>
    </div>,
    document.body,
  );
}

TableHelpPopover.propTypes = {
  controller: PropTypes.object.isRequired,
  snap: PropTypes.object.isRequired,
};

/** The grid + dock — mounted inline or inside the expanded modal. */
function EditorBody({ controller, snap, gridRef, expanded }) {
  return (
    <div className={cn("md-table-body", expanded && "md-table-body-expanded")}>
      <TableGrid controller={controller} snap={snap} gridRef={gridRef} expanded={expanded} />
      <DockBar controller={controller} snap={snap} />
    </div>
  );
}

EditorBody.propTypes = {
  controller: PropTypes.object.isRequired,
  snap: PropTypes.object.isRequired,
  gridRef: PropTypes.shape({ current: PropTypes.object }),
  expanded: PropTypes.bool,
};

/** @param {{ controller: import("./markdownTables.js").TableController }} props */
export default function MarkdownTableEditor({ controller }) {
  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const rootRef = useRef(null);
  const gridRef = useRef(null);

  // Focus hand-off: the controller asks for a cell, we focus it after render.
  useLayoutEffect(() => {
    const want = controller.takeFocusRequest();
    if (!want) return;
    gridRef.current
      ?.querySelector(`[data-cell="${want.r},${want.c}"]`)
      ?.focus({ preventScroll: false });
  }, [snap, controller]);

  return (
    <div
      ref={rootRef}
      className="md-table-root"
      onBlur={() => {
        setTimeout(() => controller.noteExternalFocus(document.activeElement), 0);
      }}
    >
      {snap.expanded ? (
        <>
          <div className="md-table-mini">
            <span>Table open in the expanded workspace</span>
            <Button
              variant="outline"
              surface="primary"
              size="sm"
              onClick={() => controller.setExpanded(false)}
            >
              Restore
            </Button>
          </div>
          <ModalCard
            open
            onClose={() => controller.setExpanded(false)}
            title="Edit table"
            size="fullscreen"
            mobileFullscreen
            className="md-table-expandcard"
            overlayClassName={NESTED_OVERLAY_CLASS}
          >
            <div className="md-table-dialog">
              {snap.message && (
                <div className="md-table-note" role="status">
                  {snap.message}
                </div>
              )}
              {snap.conflict && <ConflictBar controller={controller} snap={snap} />}
              <RecoveryBar controller={controller} snap={snap} />
              <EditorBody controller={controller} snap={snap} gridRef={gridRef} expanded />
            </div>
          </ModalCard>
        </>
      ) : (
        <>
          {snap.message && (
            <div className="md-table-note" role="status">
              {snap.message}
            </div>
          )}
          {snap.conflict && <ConflictBar controller={controller} snap={snap} />}
          <RecoveryBar controller={controller} snap={snap} />
          <EditorBody controller={controller} snap={snap} gridRef={gridRef} expanded={false} />
        </>
      )}
      <TableImportDialog
        open={snap.dialog === "import"}
        onClose={() => controller.setDialog(null)}
        replace
        notice={snap.dialog === "import" ? snap.message : null}
        onApply={(rows, firstRow, mode) => controller.applyImport(rows, firstRow, mode)}
      />
      <TableExportDialog controller={controller} snap={snap} />
      <TableSourceDialog controller={controller} snap={snap} />
      <TableHelpPopover controller={controller} snap={snap} />
      <ConfirmModal
        open={snap.dialog === "delete"}
        overlayClassName={NESTED_OVERLAY_CLASS}
        onClose={() => controller.setDialog(null)}
        onConfirm={() => {
          // Rechecked against the source captured when the dialog opened —
          // a remote change in between keeps the dialog open.
          if (controller.deleteTable(snap.dialogSource)) {
            controller.setDialog(null);
          }
        }}
        variant="danger"
        title="Delete this table?"
        message="The whole table is removed from the document. You can undo with Ctrl+Z."
        confirmLabel="Delete table"
        error={snap.dialog === "delete" ? snap.message : null}
      />
    </div>
  );
}

MarkdownTableEditor.propTypes = {
  controller: PropTypes.object.isRequired,
};
