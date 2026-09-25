import { useCallback, useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import {
  Bold,
  Code,
  Heading,
  Italic,
  Link2,
  List,
  ListChecks,
  Minus,
  Quote,
  SquareCode,
  Strikethrough,
  Table,
} from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import Dropdown from "@libreloom/ui/components/common/Dropdown.jsx";
import ModalCard, { NESTED_OVERLAY_CLASS } from "@libreloom/ui/components/cards/ModalCard.jsx";
import ShakeTarget from "@libreloom/ui/components/ui/ShakeTarget.jsx";
import MarkdownPreview from "./MarkdownPreview.jsx";
import { ActionTooltipGroup, Tooltip } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { useFileEditor, runMarkdownAction } from "./useFileEditor.js";
import { insertMarkdownTable } from "./markdownTables.js";
import { TableImportDialog } from "./MarkdownTableEditor.jsx";
import { useFileSource } from "../../lib/fileSource.jsx";
import { joinPath, parentPath } from "../../lib/paths.js";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { cn } from "@libreloom/ui/lib/utils.js";

/**
 * Toolbar actions — each inserts or toggles Markdown syntax at the cursor.
 * Labels are plain language; tooltips repeat the label.
 */
const TOOLBAR_ACTIONS = [
  { action: "bold", icon: Bold, label: "Bold", keys: "Ctrl+B" },
  { action: "italic", icon: Italic, label: "Italic", keys: "Ctrl+I" },
  { action: "strikethrough", icon: Strikethrough, label: "Strikethrough" },
  { action: "link", icon: Link2, label: "Link", keys: "Ctrl+K" },
  { action: "heading", icon: Heading, label: "Heading" },
  { action: "list", icon: List, label: "List" },
  { action: "task", icon: ListChecks, label: "Checklist" },
  { action: "quote", icon: Quote, label: "Quote" },
  { action: "code", icon: Code, label: "Code" },
  { action: "codeblock", icon: SquareCode, label: "Code block" },
  { action: "table", icon: Table, label: "Table" },
  { action: "hr", icon: Minus, label: "Divider" },
];

const HEADING_OPTIONS = Array.from({ length: 6 }, (_, i) => ({
  value: `heading${i + 1}`,
  label: `Heading ${i + 1} (H${i + 1})`,
}));

const SIZE_CHOOSER_MAX = 6;

/**
 * New-table dialog: pick columns/rows (fields or the quick-size grid), or
 * import CSV/TSV instead. Confirming inserts a pipe table at the caret and
 * focuses its first header cell.
 */
function TableCreateDialog({ open, view, onClose }) {
  const [cols, setCols] = useState(3);
  const [rows, setRows] = useState(3);
  const [importOpen, setImportOpen] = useState(false);
  return (
    <ModalCard
      open={open}
      onClose={onClose}
      title="Insert table"
      overlayClassName={NESTED_OVERLAY_CLASS}
    >
      <div className="space-y-3 text-sm text-primary">
        <div className="flex flex-wrap items-center gap-4">
          <div
            className="grid gap-1"
            style={{
              gridTemplateColumns: `repeat(${SIZE_CHOOSER_MAX}, minmax(0,1fr))`,
            }}
            role="presentation"
            aria-hidden="true"
          >
            {Array.from({ length: SIZE_CHOOSER_MAX * SIZE_CHOOSER_MAX }, (_, i) => {
              const c = (i % SIZE_CHOOSER_MAX) + 1;
              const r = Math.floor(i / SIZE_CHOOSER_MAX) + 1;
              const on = c <= cols && r <= rows;
              return (
                <button
                  key={i}
                  type="button"
                  tabIndex={-1}
                  aria-label={`${c} columns, ${r} rows`}
                  onClick={() => {
                    setCols(c);
                    setRows(r);
                  }}
                  className={`md-table-size-cell ${
                    on
                      ? "border-primary bg-primary text-secondary"
                      : "border-accent bg-secondary text-primary"
                  }`}
                />
              );
            })}
          </div>
          <div className="space-y-2">
            <p className="text-xs" aria-live="polite">
              {cols} columns × {rows} rows, plus headings
            </p>
            <label className="flex items-center gap-2">
              <span className="font-mono text-xs">Columns</span>
              <input
                type="number"
                min={1}
                max={24}
                value={cols}
                onChange={(e) =>
                  setCols(Math.max(1, Math.min(24, Number(e.target.value) || 1)))
                }
                className="w-16 rounded-xl border border-secondary/40 bg-primary px-2 py-1 text-secondary"
              />
            </label>
            <label className="flex items-center gap-2">
              <span className="font-mono text-xs">Body rows</span>
              <input
                type="number"
                min={0}
                max={99}
                value={rows}
                onChange={(e) =>
                  setRows(Math.max(0, Math.min(99, Number(e.target.value) || 0)))
                }
                className="w-16 rounded-xl border border-secondary/40 bg-primary px-2 py-1 text-secondary"
              />
            </label>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            type="button"
            variant="outline"
            surface="secondary"
            onClick={() => setImportOpen(true)}
          >
            Import CSV/TSV…
          </Button>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              surface="secondary"
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              surface="secondary"
              onClick={() => {
                if (view) insertMarkdownTable(view, { columns: cols, rows });
                onClose();
              }}
            >
              Insert
            </Button>
          </div>
        </div>
      </div>
      <TableImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onApply={(dataRows, firstRowHeadings) => {
          if (view && dataRows.length) {
            const count = Math.max(...dataRows.map((r) => r.length), 1);
            const data = firstRowHeadings
              ? { header: dataRows[0], body: dataRows.slice(1) }
              : {
                  header: Array.from(
                    { length: count },
                    (_, i) => `Column ${i + 1}`,
                  ),
                  body: dataRows,
                };
            if (insertMarkdownTable(view, { data }) === false) return false;
          }
          onClose();
          return true;
        }}
      />
    </ModalCard>
  );
}

TableCreateDialog.propTypes = {
  open: PropTypes.bool.isRequired,
  view: PropTypes.object,
  onClose: PropTypes.func.isRequired,
};

/**
 * First-class Markdown editing surface for .md/.markdown drive files,
 * bound to the shared `Y.Text` owned by TextFileEditor's collab session.
 *
 * `mode` is controlled by the header's segmented control:
 *   - "write"  — live preview: real typography as you type, syntax marks
 *                surface only where the cursor sits (the default)
 *   - "source" — raw Markdown with syntax highlighting
 *   - "read"   — rendered document, no cursor (react-markdown, sanitized)
 *
 * @param {{
 *   sync: import("./collabDocSync.js").CollabDocSync,
 *   driveId: string,
 *   path: string,
 *   name: string,
 *   canWrite?: boolean,
 *   mode?: "write" | "source" | "read",
 *   error?: string | null,
 *   fill?: boolean,
 *   onStats?: (stats: { line: number, col: number, words: number }) => void,
 * }} props
 */
export default function MarkdownEditor({
  sync,
  driveId,
  path,
  name,
  canWrite = true,
  mode = "write",
  error = null,
  fill = false,
  onStats,
}) {
  // Read mode renders the live shared document — subscribe so remote edits
  // repaint the preview too. Entering the mode refreshes the snapshot via a
  // render-phase adjust (no setState inside the effect body).
  const [readText, setReadText] = useState(() => sync.serialize());
  const [prevMode, setPrevMode] = useState(mode);
  if (prevMode !== mode) {
    setPrevMode(mode);
    if (mode === "read") setReadText(sync.serialize());
  }
  useEffect(() => {
    if (mode !== "read") return undefined;
    const onUpdate = () => setReadText(sync.serialize());
    sync.ydoc.on("update", onUpdate);
    return () => sync.ydoc.off("update", onUpdate);
  }, [sync, mode]);

  // Stable identity — the hook's mode-flip effect depends on it.
  const source = useFileSource();
  const resolveImageSrc = useCallback(
    (/** @type {string} */ src) => {
      const raw = src.trim();
      if (!raw) return null;
      if (/^(https?:|data:|blob:)/i.test(raw)) return raw;
      const folder = parentPath(path) ?? "";
      return source.contentHref(driveId, joinPath(folder, raw));
    },
    [source, driveId, path],
  );

  // Draft text recovered from a torn-down table widget (remote delete,
  // mode flip mid-edit). Editor-owned state survives the CodeMirror view
  // itself, so the panel is reachable in Read and Source too — copy or
  // dismiss only, never auto-applied.
  const recoverySeq = useRef(0);
  const [recovered, setRecovered] = useState(
    /** @type {{ id: number, text: string }[]} */ ([]),
  );
  const onTableRecovery = useCallback((text) => {
    recoverySeq.current += 1;
    const id = recoverySeq.current;
    setRecovered((list) => [...list, { id, text }]);
  }, []);
  const dismissRecovered = useCallback((id) => {
    setRecovered((list) => list.filter((item) => item.id !== id));
  }, []);
  const copyRecovered = useCallback(async (item) => {
    if (!navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(item.text);
      setRecovered((list) => list.filter((x) => x.id !== item.id));
    } catch {
      // A refused clipboard keeps the text on screen for manual copy.
    }
  }, []);

  const { attachHost, viewRef } = useFileEditor({
    ytext: sync.ytext,
    awareness: sync.awareness,
    canWrite: canWrite && mode !== "read",
    markdown: true,
    livePreview: mode !== "source",
    ariaLabel: `Contents of ${name}`,
    onStats,
    onTableRecovery,
    resolveImage: resolveImageSrc,
  });

  const [tableDialogOpen, setTableDialogOpen] = useState(false);

  /** @param {string} action */
  function applyAction(action) {
    const view = viewRef.current;
    if (!view || !canWrite) return;
    if (action === "table") {
      setTableDialogOpen(true);
      return;
    }
    runMarkdownAction(view, action);
  }

  const showToolbar = canWrite && mode !== "read";

  return (
    <div className={cn("min-h-0 flex-col", fill ? "flex h-full" : "flex")}>
      {showToolbar && (
        <ActionTooltipGroup className="mb-2">
          <div
            className="flex flex-wrap items-center gap-0.5"
            role="toolbar"
            aria-label="Formatting"
            data-slot="markdown-toolbar"
          >
            {TOOLBAR_ACTIONS.map(({ action, icon: Icon, label, keys }) =>
              action === "heading" ? (
                <div key={action} onMouseDown={(e) => e.preventDefault()}>
                  <Tooltip content={label}>
                    <Dropdown
                      options={HEADING_OPTIONS}
                      value=""
                      icon={Icon}
                      aria-label="Heading level"
                      bg="primary"
                      ghost
                      onChange={(headingAction) => {
                        queueMicrotask(() => applyAction(headingAction));
                      }}
                    />
                  </Tooltip>
                </div>
              ) : (
                <Tooltip key={action} content={keys ? `${label} (${keys})` : label}>
                  <Button
                    variant="ghost"
                    surface="primary"
                    size="iconSm"
                    aria-label={label}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => applyAction(action)}
                  >
                    <Icon size={ICON_SIZE.md} aria-hidden="true" />
                  </Button>
                </Tooltip>
              ),
            )}
          </div>
        </ActionTooltipGroup>
      )}
      {recovered.length > 0 && (
        <div className="md-table-recoverylist" role="status">
          {recovered.map((item) => (
            <div key={item.id} className="md-table-recovery">
              <span>Text recovered from an unfinished table cell edit:</span>
              <textarea
                className="md-table-sourceta"
                readOnly
                rows={2}
                value={item.text}
                aria-label="Recovered cell text"
                onFocus={(e) => e.target.select()}
              />
              <span className="md-table-recovery-actions">
                <Button
                  variant="outline"
                  surface="primary"
                  size="sm"
                  onClick={() => void copyRecovered(item)}
                >
                  Copy text
                </Button>
                <Button
                  variant="ghost"
                  surface="primary"
                  size="sm"
                  onClick={() => dismissRecovered(item.id)}
                >
                  Dismiss
                </Button>
              </span>
            </div>
          ))}
        </div>
      )}
      <ShakeTarget
        shake={error}
        className={cn("min-h-0", fill && "flex flex-1 flex-col")}
      >
        {mode === "read" ? (
          <MarkdownPreview
            text={readText}
            name={name}
            className={cn(
              "rounded-large-element",
              fill ? "h-full" : "max-h-[65vh] min-h-[50vh]",
            )}
            emptyHint="Nothing here yet. Switch to Write and start typing."
          />
        ) : (
          <div
            ref={attachHost}
            data-slot="markdown-editor-surface"
            className={cn(
              "h-full min-h-0 overflow-hidden",
              !fill && "min-h-[50vh]",
            )}
          />
        )}
      </ShakeTarget>
      <TableCreateDialog
        open={tableDialogOpen}
        view={viewRef.current}
        onClose={() => setTableDialogOpen(false)}
      />
    </div>
  );
}

MarkdownEditor.propTypes = {
  sync: PropTypes.object.isRequired,
  driveId: PropTypes.string.isRequired,
  path: PropTypes.string.isRequired,
  name: PropTypes.string.isRequired,
  canWrite: PropTypes.bool,
  mode: PropTypes.oneOf(["write", "source", "read"]),
  error: PropTypes.string,
  fill: PropTypes.bool,
  onStats: PropTypes.func,
};
