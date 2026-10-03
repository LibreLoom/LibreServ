import { memo, useMemo } from "react";
import { Link } from "react-router-dom";
import {
  Check,
  Copy,
  Download,
  File as FileIcon,
  Folder,
  FolderInput,
  Pencil,
  Trash2,
} from "lucide-react";
import Pill from "@libreloom/ui/components/common/Pill.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import AnimatedCheckbox from "@libreloom/ui/components/ui/AnimatedCheckbox.jsx";
import { ActionTooltipGroup, Tooltip } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { useFileSource } from "../../lib/fileSource.jsx";
import { CAP, capsBits } from "../../lib/access.js";
import { isFormFile } from "../../lib/fileKinds.js";
import { joinPath } from "../../lib/paths.js";
import FormResponseBadge from "./forms/FormResponseBadge.jsx";
import PrivateBadge from "../private/PrivateBadge.jsx";
import { PropertiesButton } from "./PropertiesSheet.jsx";
import { canOpenRow, displayNameOf } from "./fileRowUtils.js";

/**
 * One file or folder row. Memoized: a row only re-renders when its own entry,
 * selection, or drop state changes, so selecting one row in a folder of
 * thousands no longer re-renders the rest. Every callback goes through `api`,
 * which FileBrowser keeps referentially stable and always points at the latest
 * handlers.
 */
function FileRow({
  entry,
  path,
  fileRoot,
  striped,
  isSelected,
  isDrop,
  isPicker,
  pickerMode,
  pickSelected,
  multiSelect,
  linkNavigation,
  canDragRow,
  dropEnabled,
  trashView,
  driveId,
  surface,
  dense,
  hasShare,
  hasCopy,
  hasMove,
  hasRename,
  hasDelete,
  enableDownload,
  renderRowActions,
  folderHref,
  fileHref,
  api,
  isLast = false,
  measureRef = undefined,
  dataIndex = undefined,
  setSize = undefined,
}) {
  const source = useFileSource();
  const displayName = displayNameOf(entry);
  const fullPath = fileRoot ? path : joinPath(path, entry.name);
  const ctx = useMemo(
    () => ({ entry, path, fullPath, displayName }),
    [entry, path, fullPath, displayName],
  );

  const well = surface === "primary" ? "secondary" : "primary";
  const fg = surface === "primary" ? "text-secondary" : "text-primary";
  const cardSurface = surface === "primary" ? "surface-primary" : "surface-secondary";
  // color-scan: ignore-next-line mixes theme CSS vars only (no hardcoded hex)
  const stripeBg = surface === "primary"
    ? "bg-[color-mix(in_oklab,var(--primary)_92%,var(--secondary))]"
    : "bg-[color-mix(in_oklab,var(--secondary)_92%,var(--primary))]";
  const padY = dense ? "py-2" : "py-2.5";

  const openable = canOpenRow(entry, displayName, trashView);
  const isDir = entry.kind === "dir";
  const showFormBadge = !isPicker && !trashView
    && (!source.guest || ((source.capsBits ?? 0) & CAP.VIEW) !== 0)
    && entry.kind === "file" && isFormFile(entry.name);

  const dropProps = isDir && dropEnabled
    ? {
      onDragOver: (e) => api.folderDragOver(fullPath, e),
      onDragLeave: (e) => api.folderDragLeave(fullPath, e),
      onDrop: (e) => api.folderDrop(fullPath, e),
    }
    : {};

  function renderActions() {
    if (renderRowActions) return renderRowActions(ctx);
    if (isPicker) {
      const canPick = pickerMode === "any"
        || (pickerMode === "folder" && isDir)
        || (pickerMode === "file" && entry.kind === "file");
      if (!canPick || api.isTrash(fullPath)) return null;
      return (
        <Button
          variant={pickSelected ? well : "outline"}
          surface={surface}
          size="sm"
          aria-label={pickSelected ? `Selected ${displayName}` : `Select ${displayName}`}
          aria-pressed={pickSelected}
          onClick={() => api.select(ctx)}
        >
          {pickSelected ? <Check size={14} aria-hidden="true" /> : null}
          {pickSelected ? "Selected" : "Select"}
        </Button>
      );
    }

    const actions = [];
    // The share bit is per-entry: a view-only member sees the row but
    // never the Sharing button. Entries without stamped caps fail closed.
    if (hasShare && (capsBits(entry.caps || "") & CAP.SHARE) !== 0) {
      actions.push(
        <Button
          key="share"
          variant="ghost"
          surface={surface}
          size="sm"
          onClick={() => api.share(ctx)}
        >
          Sharing
        </Button>,
      );
    }
    if (hasCopy) {
      actions.push(
        <Tooltip key="copy" content="Copy">
          <Button
            variant="ghost"
            surface={surface}
            size="iconSm"
            aria-label={`Copy ${displayName}`}
            onClick={() => api.copy([fullPath])}
          >
            <Copy size={14} />
          </Button>
        </Tooltip>,
      );
    }
    if (hasMove) {
      actions.push(
        <Tooltip key="move" content="Move">
          <Button
            variant="ghost"
            surface={surface}
            size="iconSm"
            aria-label={`Move ${displayName}`}
            onClick={() => api.move([fullPath])}
          >
            <FolderInput size={14} />
          </Button>
        </Tooltip>,
      );
    }
    if (hasRename) {
      actions.push(
        <Tooltip key="rename" content="Rename">
          <Button
            variant="ghost"
            surface={surface}
            size="iconSm"
            aria-label={`Rename ${displayName}`}
            onClick={() => api.rename(ctx)}
          >
            <Pencil size={14} />
          </Button>
        </Tooltip>,
      );
    }
    if (hasDelete) {
      actions.push(
        <Tooltip key="delete" content="Move to trash">
          <Button
            variant="ghost"
            surface={surface}
            size="iconSm"
            aria-label={`Move ${displayName} to trash`}
            onClick={() => api.remove([fullPath])}
          >
            <Trash2 size={14} />
          </Button>
        </Tooltip>,
      );
    }
    if (enableDownload && (entry.kind === "file" || isDir)) {
      actions.push(
        <Tooltip key="download" content="Download">
          <Button
            variant="ghost"
            surface={surface}
            size="iconSm"
            asChild
            aria-label={`Download ${displayName}`}
          >
            <a href={source.downloadHref(driveId, fullPath, entry.kind)}>
              <Download size={14} />
            </a>
          </Button>
        </Tooltip>,
      );
    }
    return actions.length ? (
      <ActionTooltipGroup>
        <div className="flex items-center gap-0.5 flex-wrap justify-end">{actions}</div>
      </ActionTooltipGroup>
    ) : null;
  }

  const Icon = isDir ? Folder : FileIcon;
  const label = (
    <>
      <Icon size={16} className="shrink-0" aria-hidden="true" />
      <span className="font-mono text-sm truncate">{displayName}</span>
    </>
  );
  // Folders warm their listing before the click; mouse hover waits a beat,
  // press/keyboard focus fetch at once.
  const prefetchProps = isDir
    ? {
      onPointerEnter: (e) => { if (e.pointerType === "mouse") api.prefetchFolder(fullPath); },
      onPointerLeave: () => api.cancelPrefetch(),
      onPointerDown: () => api.prefetchFolder(fullPath, true),
      onFocus: () => api.prefetchFolder(fullPath, true),
    }
    : {};
  const linkClass = `flex items-center gap-2 min-w-0 ${fg} hover:underline`;
  const buttonClass = `flex items-center gap-2 min-w-0 text-left ${fg} hover:underline`;

  let name;
  if (isDir || openable) {
    if (linkNavigation) {
      name = (
        <Link
          to={isDir ? folderHref(driveId, fullPath) : fileHref(driveId, fullPath)}
          draggable={false}
          className={linkClass}
          {...prefetchProps}
          onClick={isDir ? undefined : () => {
            haptic("medium");
            api.openFile(ctx);
          }}
        >
          {label}
        </Link>
      );
    } else {
      name = (
        <button
          type="button"
          draggable={false}
          className={buttonClass}
          {...prefetchProps}
          onClick={() => api.openEntry(ctx)}
        >
          {label}
        </button>
      );
    }
  } else {
    name = (
      <div className={`flex items-center gap-2 min-w-0 ${fg}`} draggable={false}>
        {label}
      </div>
    );
  }

  return (
    <li
      ref={measureRef}
      data-index={dataIndex}
      aria-setsize={setSize}
      aria-posinset={setSize != null && dataIndex != null ? dataIndex + 1 : undefined}
      data-file-path={fullPath}
      className={[
        "flex items-center gap-2 px-3",
        padY,
        // The stripe IS the row's background — the only place it
        // may ever paint. Selection and drop-target states own the
        // whole row color, so the stripe is omitted there rather
        // than stacked under them (two bg-* utilities resolve by
        // stylesheet order, not class order). bg-clip-padding keeps
        // the fill out of the border box, so the translucent
        // divider always blends over the card behind it instead of
        // being tinted by the stripe/selection color.
        `bg-clip-padding ${isSelected || isDrop ? "bg-current/10" : striped ? stripeBg : cardSurface} ${fg}`,
        // One outline: the drop ring replaces the row separator
        // (border-b kept transparent so the row height doesn't
        // shift). The last row always rounds to hug the card's
        // bottom edge — same geometry whether or not it's the
        // drop target.
        isDrop
          ? "ring-2 ring-accent ring-inset border-b border-transparent last:border-b-0 last:rounded-b-large-element"
          : "border-b border-primary/15 last:border-b-0 last:rounded-b-large-element",
        // `last:` can't see the real last row while the list window has a
        // spacer after it, so the flag says it explicitly.
        isLast ? "border-b-0 rounded-b-large-element" : "",
        "motion-safe:transition-colors",
        canDragRow ? "cursor-grab active:cursor-grabbing select-none" : "",
      ].filter(Boolean).join(" ")}
      draggable={canDragRow}
      onDragStart={(e) => api.dragStart(ctx, e)}
      {...dropProps}
    >
      {!isPicker && multiSelect ? (
        <div
          data-no-row-drag
          draggable={false}
          onMouseDown={(e) => e.stopPropagation()}
          className="shrink-0"
        >
          <AnimatedCheckbox
            checked={isSelected}
            onChange={(next, e) => {
              const shift = Boolean(
                /** @type {MouseEvent|undefined} */ (e?.nativeEvent)?.shiftKey,
              );
              api.checkboxChange(fullPath, next, shift);
            }}
            aria-label={`Select ${displayName}`}
            surface={surface}
          />
        </div>
      ) : null}

      <div className="flex items-center gap-2 flex-1 min-w-0">
        {name}
        {entry.private || entry.in_private ? (
          <PrivateBadge
            className={fg}
            label={entry.private ? "Private folder" : "In a private folder"}
          />
        ) : null}
        {entry.saving ? (
          <span className="text-xs shrink-0" aria-live="polite">
            Saving…
          </span>
        ) : entry.save_failed ? (
          <Pill variant="custom" className="bg-error/20 border-error/30 text-primary shrink-0">
            Didn&apos;t save
          </Pill>
        ) : null}
        {showFormBadge ? <FormResponseBadge driveId={driveId} formPath={fullPath} /> : null}
      </div>

      <div
        data-no-row-drag
        className="shrink-0 max-w-[40%] sm:max-w-none flex flex-wrap items-center justify-end gap-0.5"
        draggable={false}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {renderActions()}
        {!isPicker && (
          <PropertiesButton
            label={displayName}
            onClick={() => api.openProperties(ctx)}
            surface={surface}
          />
        )}
      </div>
    </li>
  );
}

export default memo(FileRow);
