import { memo, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import {
  Copy,
  Download,
  File as FileIcon,
  Folder,
  FolderInput,
  FolderOpen,
  Trash2,
  Users,
} from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import RowActionMenu from "@libreloom/ui/components/ui/RowActionMenu.jsx";
import { ActionTooltipGroup, Tooltip } from "@libreloom/ui/components/ui/Tooltip.jsx";
import PrivateBadge from "../private/PrivateBadge.jsx";
import { highlightParts, locationParts, searchWhen } from "../../lib/fileSearch.js";
import { canViewerOpen } from "../../lib/officeConvert.js";
import { downloadHref, fileHref, fmtSize, parentPath, searchResultHref } from "../../lib/paths";
import { capsOnPath, memberFileHref, memberSearchHref } from "../../lib/shareTree.js";
import { CAP } from "../../lib/access.js";
import { cn } from "@libreloom/ui/lib/utils.js";
import { useIsSmUp } from "./fileRowUtils.js";

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
  onNavigate,
  onShare,
  onCopy,
  onTrash,
}) {
  const isDir = item.kind === "dir";
  const isSmUp = useIsSmUp();
  const actionsRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  // The row link is the row's one Tab stop; ←/→ (see FileSearch) reach the
  // actions, so a long list isn't six Tab presses per row.
  useEffect(() => {
    actionsRef.current
      ?.querySelectorAll("a, button")
      .forEach((el) => el.setAttribute("tabindex", "-1"));
  });
  const href = memberAccess ? memberSearchHref(memberAccess, item) : searchResultHref(item);
  // Hits only prove VIEW. Everything else is gated on the member's real
  // caps — share needs the share bit, move/trash need edit.
  const itemCaps = isAdmin
    ? CAP.VIEW | CAP.UPLOAD | CAP.EDIT | CAP.SHARE
    : capsOnPath(memberAccess, item.drive_id, item.path);
  const canShare = (itemCaps & CAP.SHARE) !== 0;
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
  const detail = detailLine(item, driveLabel, isDir);
  const parts = item.match === "close"
    ? [{ text: item.name, hit: false }]
    : highlightParts(item.name, query);

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
      icon: Users,
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

  return (
    <li
      data-slot="file-search-item"
      className="file-search-row-enter min-w-0"
      style={{ animationDelay: `${Math.min(index, 8) * 28}ms` }}
    >
      <div
        className={cn(
          "group relative rounded-large-element surface-primary px-3 py-2",
          "motion-safe:transition-shadow hover:ring-2 hover:ring-accent",
          "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent",
        )}
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
            <p className="flex items-center gap-1.5 min-w-0 text-secondary">
              <span className="font-mono text-sm truncate">
                {parts.map((part, i) =>
                  part.hit ? (
                    <span key={i} className="underline decoration-accent decoration-2 underline-offset-4">
                      {part.text}
                    </span>
                  ) : (
                    part.text
                  ),
                )}
              </span>
              {item.private ? <PrivateBadge size={12} /> : null}
            </p>
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
          {isSmUp ? (
            <ActionTooltipGroup>
              <div
                ref={actionsRef}
                data-slot="file-search-actions"
                className="flex items-center gap-1 shrink-0 pointer-events-auto"
                onClick={(event) => event.stopPropagation()}
              >
                {actions.map(({ key, label, aria, icon: Icon, to, href, run }) => (
                  <Tooltip key={key} content={label}>
                    {to ? (
                      <Button variant="ghost" surface="primary" size="iconSm" asChild aria-label={aria}>
                        <Link
                          to={to}
                          onClick={(event) => {
                            event.stopPropagation();
                            onNavigate();
                          }}
                        >
                          <Icon size={14} />
                        </Link>
                      </Button>
                    ) : href ? (
                      <Button variant="ghost" surface="primary" size="iconSm" asChild aria-label={aria}>
                        <a href={href}>
                          <Icon size={14} />
                        </a>
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        surface="primary"
                        size="iconSm"
                        aria-label={aria}
                        onClick={run}
                      >
                        <Icon size={14} />
                      </Button>
                    )}
                  </Tooltip>
                ))}
              </div>
            </ActionTooltipGroup>
          ) : (
            <div
              ref={actionsRef}
              data-slot="file-search-actions"
              className="shrink-0 pointer-events-auto"
              onClick={(event) => event.stopPropagation()}
            >
              <RowActionMenu label={item.name} actions={actions} surface="primary" />
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
export default memo(FileSearchRow);
