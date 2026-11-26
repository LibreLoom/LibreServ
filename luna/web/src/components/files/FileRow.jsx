import { memo, useMemo } from "react";
import { Link } from "react-router-dom";
import {
  Check,
  Copy,
  Download,
  File as FileIcon,
  Folder,
  FolderInput,
  Info,
  Pencil,
  Trash2,
  Users,
} from "lucide-react";
import Pill from "@libreloom/ui/components/common/Pill.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import RowActionMenu from "@libreloom/ui/components/ui/RowActionMenu.jsx";
import AnimatedCheckbox from "@libreloom/ui/components/ui/AnimatedCheckbox.jsx";
import IconActions from "@libreloom/ui/components/ui/IconActions.jsx";
import { iconImageElement } from "@libreloom/ui/components/ui/IconImage.jsx";
import { useToneColor } from "@libreloom/ui/lib/iconImage.js";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { useFileSource } from "../../lib/fileSource.jsx";
import { CAP, canSeeLinks } from "../../lib/access.js";
import { openableKind, isFormFile } from "../../lib/fileKinds.js";
import FormResponseBadge from "./forms/FormResponseBadge.jsx";
import PrivateBadge from "../private/PrivateBadge.jsx";
import BackupNotes from "../protect/BackupNotes.jsx";
import { backupStatus, backupWaitingReason } from "../../lib/backupRows.js";
import PausedByLockNote from "../protect/PausedByLockNote.jsx";
import { canOpenRow, displayNameOf } from "./fileRowUtils.js";
import { warmTextEditor } from "./editorWarm.js";

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
  fullPath,
  striped,
  isSelected,
  isDrop,
  isPicker,
  pickerMode,
  pickSelected,
  pickBlocked = false,
  multiSelect,
  linkNavigation,
  canDragRow,
  dropEnabled,
  trashView,
  driveId,
  surface,
  dense,
  isSmUp,
  hasShare,
  hasCopy,
  hasMove,
  hasRename,
  hasDelete,
  enableDownload,
  renderRowActions,
  renderRowSheetActions = undefined,
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
  const ctx = useMemo(
    () => ({ entry, path, fullPath, displayName }),
    [entry, path, fullPath, displayName],
  );

  const well = surface === "primary" ? "secondary" : "primary";
  // The row's text color, for its icon image (an inline SVG per row cost
  // scroll frames, W6).
  const iconColor = useToneColor(well);
  const fg = surface === "primary" ? "text-secondary" : "text-primary";
  const cardSurface = surface === "primary" ? "surface-primary" : "surface-secondary";
  // color-scan: ignore-next-line mixes theme CSS vars only (no hardcoded hex)
  const stripeBg = surface === "primary"
    ? "bg-[color-mix(in_oklab,var(--primary)_92%,var(--secondary))]"
    : "bg-[color-mix(in_oklab,var(--secondary)_92%,var(--primary))]";
  // min-h pins every row to one whole-pixel height, so the list window knows
  // it before measuring anything (see VirtualRowWindow).
  // Selected rows dim whichever background they sit on (plain or striped), so
  // all four row looks stay distinguishable from one another.
  const baseBg = surface === "primary" ? "var(--primary)" : "var(--secondary)";
  const stripeMix = surface === "primary"
    ? "color-mix(in_oklab,var(--primary)_92%,var(--secondary))"
    : "color-mix(in_oklab,var(--secondary)_92%,var(--primary))";
  const selectedBg = `bg-[color-mix(in_oklab,currentColor_14%,${striped ? stripeMix : baseBg})]`;
  const padY = dense ? "py-2 min-h-11" : "py-2.5 min-h-12";

  const openable = canOpenRow(entry, displayName, trashView);
  const isDir = entry.kind === "dir";
  // A text-ish file will open in the CodeMirror editor; fetch that chunk as
  // soon as the pointer says this row is the likely target.
  const warmsEditor = !isDir && openable
    && ["text", "markdown", "csv", "notebook", "calendar", "contact", "geo"].includes(openableKind(entry.name));
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

  // One action list for both sizes: icon buttons in the row on wide screens,
  // labeled rows in the phone sheet. `aria` is the icon's accessible name,
  // which is not always the sheet's label.
  const canShareRow = hasShare && canSeeLinks(entry.caps || "");
  const canDownload = enableDownload && (entry.kind === "file" || isDir);
  const actions = [];
  // Per-entry: anyone who can read the entry gets the Sharing button (it
  // shows the item's links; the sheet gates every change). Entries without
  // stamped caps fail closed.
  if (canShareRow) {
    actions.push({
      key: "share",
      label: "Sharing",
      aria: `Sharing for ${displayName}`,
      icon: Users,
      // The row has always spelled this one out; the sheet says the same word.
      text: true,
      run: () => api.share(ctx),
    });
  }
  if (hasCopy) {
    actions.push({
      key: "copy",
      label: "Copy",
      aria: `Copy ${displayName}`,
      icon: Copy,
      run: () => api.copy([fullPath]),
    });
  }
  if (hasMove) {
    actions.push({
      key: "move",
      label: "Move",
      aria: `Move ${displayName}`,
      icon: FolderInput,
      run: () => api.move([fullPath]),
    });
  }
  if (hasRename) {
    actions.push({
      key: "rename",
      label: "Rename",
      aria: `Rename ${displayName}`,
      icon: Pencil,
      run: () => api.rename(ctx),
    });
  }
  if (canDownload) {
    actions.push({
      key: "download",
      label: "Download",
      aria: `Download ${displayName}`,
      icon: Download,
      href: source.downloadHref(driveId, fullPath, entry.kind),
      run: () => window.location.assign(source.downloadHref(driveId, fullPath, entry.kind)),
    });
  }
  // The row draws Properties in the same icon row as the rest, so the folder
  // does not mount a second IconActions for every row (W4). It stays out of
  // the row's own action list (`rowHidden`) but remains in the phone sheet.
  const propertiesAction = {
    key: "properties",
    label: "Properties",
    aria: `Properties for ${displayName}`,
    icon: Info,
    rowHidden: true,
    run: () => api.openProperties(ctx),
  };
  actions.push(propertiesAction);
  if (hasDelete) {
    actions.push({
      key: "delete",
      label: "Move to trash",
      aria: `Move ${displayName} to trash`,
      icon: Trash2,
      danger: true,
      run: () => api.remove([fullPath]),
    });
  }

  function renderActions() {
    // Phones get one three-dot button that opens every action, as in search
    // results. This must come before renderRowActions: the explorer supplies
    // its own action row, and on a phone that row is a wall of buttons that
    // squeezes the file name down to nothing.
    if (!isSmUp && !isPicker) {
      return (
        <RowActionMenu
          // Long folders recycle row elements (VirtualRowWindow): a sheet left
          // open must not carry over to the next file that takes this row.
          key={fullPath}
          label={displayName}
          actions={actions}
          renderSheet={renderRowSheetActions ? (close) => renderRowSheetActions(ctx, close) : undefined}
          surface={surface}
        />
      );
    }

    // The explorer supplies its own action row; hand it Properties so the
    // whole row is one icon group instead of a second IconActions beside it.
    if (renderRowActions) {
      return renderRowActions(ctx, !isPicker && isSmUp ? [propertiesAction] : []);
    }
    if (isPicker) {
      const canPick = pickerMode === "any"
        || (pickerMode === "folder" && isDir)
        || (pickerMode === "file" && entry.kind === "file");
      if (!canPick || pickBlocked || api.isTrash(fullPath)) return null;
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

    const rowActions = actions.filter((action) => !action.rowHidden);
    if (!rowActions.length) return null;
    const share = rowActions.find((action) => action.text);
    // Plain icon buttons with one shared tooltip: every row carries these,
    // and a Button plus a Tooltip each made rows slow to mount (W4/W6).
    // Properties rides in the same group on wide screens.
    const icons = rowActions.filter((action) => !action.text);
    if (!isPicker && isSmUp) icons.push(propertiesAction);
    return (
      <div className="flex items-center gap-0.5 flex-wrap justify-end">
        {share ? (
          <Button
            variant="ghost"
            surface={surface}
            size="sm"
            // Its word never changes, so it skips the resize probe.
            smoothResize={false}
            aria-label={share.aria}
            onClick={share.run}
          >
            {share.label}
          </Button>
        ) : null}
        {icons.length ? <IconActions actions={icons} surface={surface} /> : null}
      </div>
    );
  }

  const backup = entry.backupRoot ? { ...entry.backup, kind: "drive" } : null;
  const backupHealth = backup ? backupStatus(backup) : null;
  const waiting = backupHealth?.label === "Waiting" ? backupWaitingReason(backup) : null;
  const Icon = isDir ? Folder : FileIcon;
  const label = (
    <>
      {iconImageElement(Icon, { size: 16, color: iconColor, className: "shrink-0" })}
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
    : warmsEditor
      ? { onPointerEnter: () => warmTextEditor(), onFocus: () => warmTextEditor() }
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
        `bg-clip-padding ${isDrop ? "bg-current/10" : isSelected ? selectedBg : striped ? stripeBg : cardSurface} ${fg}`,
        // One outline: the drop ring replaces the row separator
        // (border-b kept transparent so the row height doesn't
        // shift). The last row always rounds to hug the card's
        // bottom edge — same geometry whether or not it's the
        // drop target.
        // Every row, the last included, keeps its 1px bottom border (the last
        // one's is transparent), so all rows are exactly one height and the
        // list's total never jumps when the last row is measured.
        isDrop
          ? "ring-2 ring-accent ring-inset border-b border-transparent last:rounded-b-large-element"
          : `border-b ${isLast ? "border-transparent" : "border-primary/15 last:border-transparent"} last:rounded-b-large-element`,
        // `last:` can't see the real last row while the list window has a
        // spacer after it, so the flag says it explicitly.
        isLast ? "rounded-b-large-element" : "",
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
        {backup ? (
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              {name}
              <Pill variant={backupHealth.variant}>{backupHealth.label}</Pill>
            </div>
            {waiting && <p className="text-sm break-words">{waiting}</p>}
            {backup.status === "active" && !backup.covered_by && <PausedByLockNote backup={backup} />}
            <BackupNotes notes={backup.notes} />
          </div>
        ) : name}
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
      </div>
    </li>
  );
}

export default memo(FileRow);
