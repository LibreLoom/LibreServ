import { useCallback, useEffect, useState } from "react";
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
import ShakeTarget from "@libreloom/ui/components/ui/ShakeTarget.jsx";
import MarkdownPreview from "./MarkdownPreview.jsx";
import { ActionTooltipGroup, Tooltip } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { useFileEditor, runMarkdownAction } from "./useFileEditor.js";
import { insertMarkdownTable, runActiveTableAction } from "./markdownTables.js";
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

  const { attachHost, viewRef } = useFileEditor({
    ytext: sync.ytext,
    awareness: sync.awareness,
    canWrite: canWrite && mode !== "read",
    markdown: true,
    livePreview: mode !== "source",
    ariaLabel: `Contents of ${name}`,
    onStats,
    resolveImage: resolveImageSrc,
  });

  /** @param {string} action */
  function applyAction(action) {
    const view = viewRef.current;
    if (!view || !canWrite) return;
    // Like Nextcloud: the Table button drops in a 3×3 table right away and
    // puts the caret in its first heading cell. Inside a cell it does
    // nothing — tables don't nest.
    if (action === "table") {
      if (runActiveTableAction(view, action)) return;
      insertMarkdownTable(view);
      view.focus();
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
