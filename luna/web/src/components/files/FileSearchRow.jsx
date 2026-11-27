import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Copy,
  Download,
  File as FileIcon,
  Folder,
  FolderInput,
  FolderOpen,
  Trash2,
} from "lucide-react";
import Share from "@libreloom/ui/components/common/ShareIcon.jsx";
import RowActionMenu from "@libreloom/ui/components/ui/RowActionMenu.jsx";
import IconActions from "@libreloom/ui/components/ui/IconActions.jsx";
import { iconStripStyle } from "@libreloom/ui/lib/iconImage.js";
import PrivateBadge from "../private/PrivateBadge.jsx";
import { highlightParts, locationParts, searchWhen } from "../../lib/fileSearch.js";
import { canViewerOpen } from "../../lib/officeConvert.js";
import { downloadHref, fileHref, fmtSize, parentPath, searchResultHref } from "../../lib/paths";
import { capsOnPath, memberFileHref, memberSearchHref } from "../../lib/shareTree.js";
import { CAP, canSeeLinks } from "../../lib/access.js";

// Worked out once, not per row: every result carries these.
const ROW_CLASS = "file-search-row-enter min-w-0 group relative rounded-large-element surface-primary px-3 py-2 "
  + "motion-safe:transition-shadow hover:ring-2 hover:ring-accent "
  + "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent";
const HIT_CLASS = "underline decoration-accent decoration-2 underline-offset-4";
/** The action buttons' spacing (`gap-1` on IconActions below), for the still picture of them. */
const ACTIONS_GEOMETRY = { iconSize: 14, pad: 6, gap: 4 };

/** @param {{ text: string, hit: boolean }[]} parts */
function underlined(parts) {
  return parts.map((part, i) =>
    part.hit ? <span key={i} className={HIT_CLASS}>{part.text}</span> : part.text,
  );
}

function folderOf(path) {
  return parentPath(path) ?? "";
}

/** `Drive / … / folder`, plus size and when it last changed. */
function detailLine(item, driveLabel, isDir) {
  const folder = item.parent != null ? item.parent : folderOf(item.path);
  const size = !isDir && item.size != null ? fmtSize(item.size) : "";
  return {
    path: locationParts(driveLabel, folder).join(" / "),
    size,
    when: searchWhen(item.modified) || "",
    full: [driveLabel, folder].filter(Boolean).join(" / ") };
}

/**
 * One search hit: a stretched link that opens it, plus the same actions a
 * file row has (open, download, share, copy, move, trash).
 *
 * @param {{
 *   item: import("../../lib/fileSearch.js").SearchHit,
 *   query: string,
 *   driveLabel: string,
 *   isAdmin: boolean,
 *   memberAccess: any,
 *   index: number,
 *   isSmUp: boolean,
 *   iconColor: string | null,
 *   actionsLive: boolean,
 *   onNavigate: (feedback?: any) => void,
 *   onShare: (item: any) => void,
 *   onCopy: (kind: "copy" | "move", item: any) => void,
 *   onTrash: (item: any) => void,
 * }} props
 */
function FileSearchRow({
  item,
  query,
  driveLabel,
  isAdmin,
  memberAccess,
  index,
  isSmUp,
  iconColor,
  actionsLive,
  onNavigate,
  onShare,
  onCopy,
  onTrash,
}) {
  const isDir = item.kind === "dir";
  const actionsRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  // Wide rows first paint their action icons as one still picture and mount
  // the buttons once the rest of the answer has rendered (`actionsLive`), or
  // at once when a mouse points at the row or focus enters it: twelve rows of
  // buttons were a third of a search's first paint (W10). Once live, they stay.
  const [live, setLive] = useState(actionsLive);
  if (actionsLive && !live) setLive(true);
  const wake = live ? undefined : () => setLive(true);
  // A touch reaches the row at the moment it lands, so swapping the picture
  // for buttons then would lose the tap: the picture takes the tap itself and
  // passes it to the button at that spot once mounted.
  const tappedAction = useRef(-1);
  useEffect(() => {
    const at = tappedAction.current;
    if (!live || at < 0) return;
    tappedAction.current = -1;
    /** @type {HTMLElement | undefined} */ (actionsRef.current?.querySelectorAll("[data-slot=button]")[at])?.click();
  }, [live]);
  // The row link is the row's one Tab stop; ←/→ (see FileSearch) reach the
  // actions, so a long list isn't six Tab presses per row.
  // The wide layout passes tabIndex to its buttons itself; the phone menu
  // has no prop for it.
  const href = memberAccess ? memberSearchHref(memberAccess, item) : searchResultHref(item);
  // Hits only prove VIEW. Everything else is gated on the member's real
  // caps — the share sheet opens on Read (links belong to the item), the
  // sheet itself gates changes, and move/trash need edit.
  const itemCaps = isAdmin
    ? CAP.VIEW | CAP.UPLOAD | CAP.EDIT | CAP.SHARE
    : capsOnPath(memberAccess, item.drive_id, item.path);
  const canShare = canSeeLinks(itemCaps);
  const canEdit = (itemCaps & CAP.EDIT) !== 0;
  // Openable files open in the viewer on a plain click; the folder icon still
  // jumps to the file's folder.
  const opensInViewer = !isDir && canViewerOpen(item.name);
  const rowHref = opensInViewer
    ? (memberAccess
      ? memberFileHref(memberAccess, item.drive_id, item.path)
      : fileHref(item.drive_id, item.path))
    : href;
  const openLabel = isDir || opensInViewer
    ? `Open ${item.name}`
    : `Show ${item.name} in its folder`;
  // A near miss wasn't typed exactly, so underlining "the match" would lie.
  const detail = useMemo(() => detailLine(item, driveLabel, isDir), [item, driveLabel, isDir]);
  // Only a name match underlines the name: a file found by its words or
  // meaning would otherwise show a few stray letters underlined.
  const parts = useMemo(() => item.match === "name"
    ? highlightParts(item.name, query)
    : [{ text: item.name, hit: false }], [item.match, item.name, query]);
  const snippet = Array.isArray(item.snippet) && item.snippet.length ? item.snippet : null;

  // One action list, rendered two ways: icon buttons in the row on wide
  // screens, labeled rows in the phone sheet. Same order, same words, and
  // `aria` is the icon's accessible name, which is not always the sheet's
  // label (the trash button puts the verb on the name).
  const actions = [];
  if (!isDir) {
    actions.push({
      key: "folder",
      label: "Go to folder",
      aria: `Go to folder for ${item.name}`,
      icon: FolderOpen,
      to: href,
      run: onNavigate,
    });
  }
  actions.push({
    key: "download",
    label: "Download",
    aria: `Download ${item.name}`,
    icon: Download,
    href: downloadHref(item.drive_id, item.path),
    run: () => window.location.assign(downloadHref(item.drive_id, item.path)),
  });
  if (canShare) {
    actions.push({
      key: "share",
      label: "Share",
      aria: `Sharing for ${item.name}`,
      icon: Share,
      run: () => onShare(item),
    });
  }
  actions.push({
    key: "copy",
    label: "Copy",
    aria: `Copy ${item.name}`,
    icon: Copy,
    run: () => onCopy("copy", item),
  });
  if (canEdit) {
    actions.push({
      key: "move",
      label: "Move",
      aria: `Move ${item.name}`,
      icon: FolderInput,
      run: () => onCopy("move", item),
    });
    actions.push({
      key: "delete",
      label: "Move to trash",
      aria: `Move ${item.name} to trash`,
      icon: Trash2,
      danger: true,
      run: () => onTrash(item),
    });
  }

  const picture = isSmUp && !live
    ? iconStripStyle(actions.map((action) => action.icon), iconColor, ACTIONS_GEOMETRY)
    : null;

  return (
    <li
      data-slot="file-search-item"
      className={ROW_CLASS}
      style={{ animationDelay: `${Math.min(index, 8) * 8}ms` }}
      onPointerEnter={live ? undefined : (event) => {
        if (event.pointerType === "mouse") setLive(true);
      }}
      onFocus={wake}
    >
      {/* Stretched link: row body navigates; action icons sit above it. */}
      <Link
        to={rowHref}
        aria-label={openLabel}
        data-slot="file-search-link"
        className="absolute inset-0 z-0 rounded-large-element no-focus-outline"
        onClick={() => onNavigate("medium")}
      />
      <div className="relative z-10 flex items-center sm:flex-wrap gap-x-2 gap-y-1 min-w-0 pointer-events-none">
        {isDir ? (
          <Folder size={16} className="shrink-0" aria-hidden="true" />
        ) : (
          <FileIcon size={16} className="shrink-0" aria-hidden="true" />
        )}
        <div className="@container min-w-0 flex-1 sm:basis-40">
          {item.private ? (
            <p className="flex items-center gap-1.5 min-w-0 text-secondary">
              <span className="font-mono text-sm truncate">{underlined(parts)}</span>
              <PrivateBadge size={12} />
            </p>
          ) : (
            <p className="font-mono text-sm truncate text-secondary">{underlined(parts)}</p>
          )}
          {snippet ? (
            // Why a file found by its words matched: the passage, with the matched words underlined.
            <p data-slot="file-search-snippet" className="text-xs text-secondary line-clamp-2 break-words">
              {snippet.map((part, i) =>
                part.hit ? (
                  <span key={i} className={HIT_CLASS}>
                    {part.text}
                  </span>
                ) : (
                  <span key={i}>{part.text}</span>
                ),
              )}
            </p>
          ) : null}
          {/* Short on room, the folder end matters most: cut the start of the path. */}
          <p className="flex text-xs text-secondary" title={detail.full}>
            <span className="min-w-0 truncate text-left" dir="rtl">
              <span dir="ltr">{detail.path}</span>
            </span>
            {/* Size is the first thing to go when the row is narrow. */}
            {detail.size && <span className="hidden shrink-0 whitespace-pre @[22rem]:inline">{` · ${detail.size}`}</span>}
            {detail.when && <span className="shrink-0 whitespace-pre">{` · ${detail.when}`}</span>}
          </p>
        </div>
        {picture ? (
          // Just the icons, where the buttons will be; a tap here reaches the button at that spot.
          <span
            aria-hidden="true"
            data-slot="file-search-actions-picture"
            className="shrink-0 pointer-events-auto"
            style={picture}
            onClick={(event) => {
              event.stopPropagation();
              const { iconSize, pad, gap } = ACTIONS_GEOMETRY;
              const x = event.clientX - event.currentTarget.getBoundingClientRect().left;
              const at = Math.floor(x / (iconSize + pad * 2 + gap));
              // Between two icons is the gap, as between two buttons.
              if (x - at * (iconSize + pad * 2 + gap) < iconSize + pad * 2) tappedAction.current = at;
              setLive(true);
            }}
          />
        ) : isSmUp ? (
          // Plain icon buttons with one shared tooltip: every result row
          // carries these, and a Button plus a Tooltip each made a long
          // answer slow to paint (W10).
          <IconActions
            ref={actionsRef}
            data-slot="file-search-actions"
            className="gap-1 shrink-0 pointer-events-auto flex-nowrap"
            onClick={(event) => event.stopPropagation()}
            actions={actions}
            surface="primary"
            tabIndex={-1}
          />
        ) : (
          <div
            ref={actionsRef}
            data-slot="file-search-actions"
            className="shrink-0 pointer-events-auto"
            onClick={(event) => event.stopPropagation()}
          >
            <RowActionMenu label={item.name} actions={actions} surface="primary" tabIndex={-1} />
          </div>
        )}
      </div>
    </li>
  );
}
export default memo(FileSearchRow);
