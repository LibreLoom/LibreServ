/**
 * MarkdownTableEditor — the React surface of the pipe-table widget, modeled
 * on Nextcloud Text's table node views (TableView, TableHeaderView,
 * TableRowView):
 *
 *   - cells are typed into directly; the cell with the caret shows its
 *     inline Markdown source, every other cell shows it rendered
 *   - each header cell has a menu: align, sort, add column left/right,
 *     delete column
 *   - each body row ends in a menu: add row above/below, delete row
 *   - the header row ends in the table menu: delete table
 *   - "add column" and "add row" strips appear on hover / while editing
 *
 * All document state lives in TableController (markdownTables.js).
 */

import { memo, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import PropTypes from "prop-types";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { Ellipsis, Plus, TableProperties } from "lucide-react";
import Dropdown from "@libreloom/ui/components/common/Dropdown.jsx";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { cn } from "@libreloom/ui/lib/utils.js";
import { encodeTableCell, tableCellValue } from "./markdownTableModel.js";
import "./markdownTables.css";

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
    <span className="md-table-imgchip">{alt ? `image: ${alt}` : "image"}</span>
  ),
};

/** Sanitized inline Markdown for one cell, parsed in a real GFM table. */
function InlineMarkdownCell({ text }) {
  if (!text.trim()) return <span aria-hidden="true">{" "}</span>;
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

/** True when the textarea's text fits on one visual line. */
function singleLine(ta) {
  const lh = parseFloat(getComputedStyle(ta).lineHeight) || 0;
  return !lh || ta.clientHeight <= lh * 1.5;
}

/**
 * One cell: rendered Markdown, or — for the cell with the caret — an
 * auto-growing textarea over the same text.
 * @param {{ controller: object, snap: object, r: number, c: number }} props
 */
function Cell({ controller, snap, r, c }) {
  const editing = snap.editing?.r === r && snap.editing?.c === c;
  const value = tableCellValue(snap.model, r, c);
  const label = r === 0 ? `Column ${c + 1} heading` : `Row ${r}, column ${c + 1}`;

  /** @param {import("react").KeyboardEvent<HTMLTextAreaElement>} e */
  const onKeyDown = (e) => {
    // The fullscreen frame and page listen for Escape and shortcuts — a
    // key typed into a cell belongs to the cell.
    e.stopPropagation();
    if (composing(e)) return;
    const ta = e.currentTarget;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    const collapsed = ta.selectionStart === ta.selectionEnd;
    const atStart = collapsed && ta.selectionStart === 0;
    const atEnd = collapsed && ta.selectionEnd === ta.value.length;
    if (e.key === "Tab") {
      e.preventDefault();
      controller.move(e.shiftKey ? "prev" : "next");
    } else if (e.key === "Enter") {
      e.preventDefault();
      controller.move(e.shiftKey ? "up" : "down");
    } else if (e.key === "Escape") {
      e.preventDefault();
      controller.exit("after");
    } else if (e.key === "ArrowUp" && !e.shiftKey && (atStart || singleLine(ta))) {
      e.preventDefault();
      controller.move("up");
    } else if (e.key === "ArrowDown" && !e.shiftKey && (atEnd || singleLine(ta))) {
      e.preventDefault();
      controller.move("down");
    } else if (e.key === "ArrowLeft" && !e.shiftKey && atStart) {
      e.preventDefault();
      if (r === 0 && c === 0) controller.exit("before");
      else controller.move("prev");
    } else if (e.key === "ArrowRight" && !e.shiftKey && atEnd) {
      e.preventDefault();
      controller.move("next");
    } else if (mod && key === "z") {
      e.preventDefault();
      if (e.shiftKey) controller.redo();
      else controller.undo();
    } else if (mod && key === "y") {
      e.preventDefault();
      controller.redo();
    } else if (mod && e.shiftKey && key === "x") {
      e.preventDefault();
      controller.formatEditingCell("strikethrough", ta);
    } else if (mod && FORMAT_KEYS[key]) {
      e.preventDefault();
      controller.formatEditingCell(FORMAT_KEYS[key], ta);
    }
  };

  const onBlur = () => {
    // Switching browser tabs keeps the caret where it was.
    if (!document.hasFocus()) return;
    // Only the cell that still owns the caret closes — moving to another
    // cell already reassigned it.
    const cur = controller.editing;
    if (cur?.r === r && cur?.c === c) controller.stopEditing();
  };

  const onMouseDown = (e) => {
    if (!snap.editable || e.button !== 0) return;
    if (e.target instanceof Element && e.target.closest("textarea")) return;
    // Keep the open cell's textarea from blurring first — focus moves
    // straight to this cell.
    e.preventDefault();
    controller.focusCell(r, c);
  };

  const Tag = r === 0 ? "th" : "td";
  const align = snap.model.align[c] || undefined;
  return (
    <Tag
      scope={r === 0 ? "col" : undefined}
      className={cn("md-table-cell", editing && "md-table-cell-editing")}
      style={align ? { textAlign: align } : undefined}
      data-cell={`${r},${c}`}
      onMouseDown={onMouseDown}
    >
      <div className={r === 0 ? "md-table-head" : undefined}>
        {editing ? (
          <div className="md-table-field" data-value={`${snap.editing.text} `}>
            <textarea
              className="md-table-input no-focus-outline"
              rows={1}
              cols={1}
              value={snap.editing.text}
              aria-label={label}
              spellCheck
              onChange={(e) => controller.setCellText(e.target.value)}
              onKeyDown={onKeyDown}
              onBlur={onBlur}
            />
          </div>
        ) : (
          <div className="md-table-value" aria-label={snap.editable ? label : undefined}>
            <InlineMarkdown text={value} />
          </div>
        )}
        {r === 0 && snap.editable && <ColumnMenu controller={controller} snap={snap} c={c} />}
      </div>
    </Tag>
  );
}

Cell.propTypes = {
  controller: PropTypes.object.isRequired,
  snap: PropTypes.object.isRequired,
  r: PropTypes.number.isRequired,
  c: PropTypes.number.isRequired,
};

/** Nextcloud's TableHeaderView actions: align, sort, add / delete column. */
function ColumnMenu({ controller, snap, c }) {
  const align = snap.model.align[c] || "";
  const options = [
    { value: "align:left", label: "Align left" },
    { value: "align:center", label: "Align center" },
    { value: "align:right", label: "Align right" },
    { value: "sort:1", label: "Sort A → Z" },
    { value: "sort:-1", label: "Sort Z → A" },
    { value: "add:before", label: "Add column left" },
    { value: "add:after", label: "Add column right" },
    ...(snap.cols > 1 ? [{ value: "delete", label: "Delete this column" }] : []),
  ];
  const run = (v) => {
    const [kind, arg] = v.split(":");
    if (kind === "align") controller.setAlign(c, arg);
    else if (kind === "sort") controller.sortColumn(c, Number(arg));
    else if (kind === "add" && arg === "before") controller.addColumnBefore(c);
    else if (kind === "add") controller.addColumnAfter(c);
    else if (kind === "delete") controller.deleteColumn(c);
  };
  return (
    <span className="md-table-menu" onMouseDown={(e) => e.stopPropagation()}>
      <Dropdown
        options={options}
        value={align ? `align:${align}` : ""}
        onChange={run}
        icon={Ellipsis}
        bg="primary"
        ghost
        aria-label={`Column ${c + 1} options`}
      />
    </span>
  );
}

ColumnMenu.propTypes = {
  controller: PropTypes.object.isRequired,
  snap: PropTypes.object.isRequired,
  c: PropTypes.number.isRequired,
};

/** Nextcloud's TableRowView actions: add row above / below, delete row. */
function RowMenu({ controller, r }) {
  const run = (v) => {
    if (v === "before") controller.addRowBefore(r);
    else if (v === "after") controller.addRowAfter(r);
    else if (v === "delete") controller.deleteRow(r);
  };
  return (
    <Dropdown
      options={[
        { value: "before", label: "Add row above" },
        { value: "after", label: "Add row below" },
        { value: "delete", label: "Delete this row" },
      ]}
      value=""
      onChange={run}
      icon={Ellipsis}
      bg="primary"
      ghost
      aria-label={`Row ${r} options`}
    />
  );
}

RowMenu.propTypes = {
  controller: PropTypes.object.isRequired,
  r: PropTypes.number.isRequired,
};

/** Nextcloud's TableView settings menu. */
function TableMenu({ controller }) {
  return (
    <Dropdown
      options={[{ value: "delete", label: "Delete this table" }]}
      value=""
      onChange={(v) => {
        if (v === "delete") controller.deleteTable();
      }}
      icon={TableProperties}
      bg="primary"
      ghost
      aria-label="Table options"
    />
  );
}

TableMenu.propTypes = { controller: PropTypes.object.isRequired };

/** @param {{ controller: import("./markdownTables.js").TableController }} props */
export default function MarkdownTableEditor({ controller }) {
  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const rootRef = useRef(null);

  // Focus hand-off: the controller asks for a cell, we focus its textarea
  // after render — caret at the end, or where a format action left it.
  useLayoutEffect(() => {
    const want = controller.takeFocusRequest();
    const caret = controller.takeCaret();
    const target = want ?? (caret ? snap.editing : null);
    if (!target) return;
    const ta = /** @type {HTMLTextAreaElement | null} */ (
      rootRef.current?.querySelector(`[data-cell="${target.r},${target.c}"] textarea`)
    );
    if (!ta) return;
    if (document.activeElement !== ta) ta.focus({ preventScroll: false });
    const end = ta.value.length;
    ta.setSelectionRange(caret?.start ?? end, caret?.end ?? end);
  }, [snap, controller]);

  const { model, editable } = snap;
  const addColumn = () => {
    haptic("light");
    controller.addColumnAfter(snap.cols - 1);
  };
  const addRow = () => {
    haptic("light");
    controller.addRowAfter(snap.rows);
  };

  return (
    <div ref={rootRef} className={cn("md-table-root", editable && "md-table-editable")}>
      <div className="md-table-scroll">
        <table className="md-table-grid" aria-label="Table">
          <thead>
            <tr>
              {model.header.map((_, c) => (
                <Cell key={c} controller={controller} snap={snap} r={0} c={c} />
              ))}
              {editable && (
                <td className="md-table-actions">
                  <TableMenu controller={controller} />
                </td>
              )}
            </tr>
          </thead>
          <tbody>
            {model.body.map((row, i) => (
              <tr key={i}>
                {row.map((_, c) => (
                  <Cell key={c} controller={controller} snap={snap} r={i + 1} c={c} />
                ))}
                {editable && (
                  <td className="md-table-actions">
                    <RowMenu controller={controller} r={i + 1} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editable && (
        <>
          <button
            type="button"
            className="md-table-add md-table-add-col"
            aria-label="Add column"
            title="Add column"
            onMouseDown={(e) => e.preventDefault()}
            onClick={addColumn}
          >
            <Plus size={ICON_SIZE.sm} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="md-table-add md-table-add-row"
            aria-label="Add row"
            title="Add row"
            onMouseDown={(e) => e.preventDefault()}
            onClick={addRow}
          >
            <Plus size={ICON_SIZE.sm} aria-hidden="true" />
          </button>
        </>
      )}
    </div>
  );
}

MarkdownTableEditor.propTypes = {
  controller: PropTypes.object.isRequired,
};
