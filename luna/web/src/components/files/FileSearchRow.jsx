import { useEffect, useRef, useState } from "react";
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
  Zap,
} from "lucide-react";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import CardButton from "@libreloom/ui/components/ui/CardButton.jsx";
import { ActionTooltipGroup, Tooltip } from "@libreloom/ui/components/ui/Tooltip.jsx";
import PrivateBadge from "../private/PrivateBadge.jsx";
import { ShareButton } from "../share/ShareSheet.jsx";
import { highlightParts, locationParts, searchWhen } from "../../lib/fileSearch.js";
import { canViewerOpen } from "../../lib/officeConvert.js";
import { downloadHref, fileHref, fmtSize, parentPath, searchResultHref } from "../../lib/paths";
import { capsOnPath, memberFileHref, memberSearchHref } from "../../lib/shareTree.js";
import { CAP } from "../../lib/access.js";
import { cn } from "@libreloom/ui/lib/utils.js";

const SM_UP_QUERY = "(min-width: 640px)";

/** Phones get one action button; a missing matchMedia (tests) counts as desktop. */
function useIsSmUp() {
  const read = () =>
    typeof window === "undefined" || typeof window.matchMedia !== "function"
      ? true
      : window.matchMedia(SM_UP_QUERY).matches;
  const [isSmUp, setIsSmUp] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const mq = window.matchMedia(SM_UP_QUERY);
    const onChange = () => setIsSmUp(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return isSmUp;
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
 *   onNavigate: (feedback?: any) => void,
 *   onShare: (item: any) => void,
 *   onCopy: (kind: "copy" | "move", item: any) => void,
 *   onTrash: (item: any) => void,
 * }} props
 */
export default function FileSearchRow({
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
  const [sheetOpen, setSheetOpen] = useState(false);
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
              {!isDir && (
              <Tooltip content="Go to folder">
                <Button
                  variant="ghost"
                  surface="primary"
                  size="iconSm"
                  asChild
                  aria-label={`Go to folder for ${item.name}`}
                >
                  <Link
                    to={href}
                    onClick={(event) => {
                      event.stopPropagation();
                      onNavigate();
                    }}
                  >
                    <FolderOpen size={14} />
                  </Link>
                </Button>
              </Tooltip>
              )}
              <Tooltip content="Download">
                <Button
                  variant="ghost"
                  surface="primary"
                  size="iconSm"
                  asChild
                  aria-label={`Download ${item.name}`}
                >
                  <a href={downloadHref(item.drive_id, item.path)}>
                    <Download size={14} />
                  </a>
                </Button>
              </Tooltip>
              {canShare && (
                <ShareButton
                  label={item.name}
                  surface="primary"
                  onClick={() => onShare(item)}
                />
              )}
              <Tooltip content="Copy">
                <Button
                  variant="ghost"
                  surface="primary"
                  size="iconSm"
                  aria-label={`Copy ${item.name}`}
                  onClick={() => onCopy("copy", item)}
                >
                  <Copy size={14} />
                </Button>
              </Tooltip>
              {canEdit && (
                <>
                  <Tooltip content="Move">
                    <Button
                      variant="ghost"
                      surface="primary"
                      size="iconSm"
                      aria-label={`Move ${item.name}`}
                      onClick={() => onCopy("move", item)}
                    >
                      <FolderInput size={14} />
                    </Button>
                  </Tooltip>
                  <Tooltip content="Move to trash">
                    <Button
                      variant="ghost"
                      surface="primary"
                      size="iconSm"
                      aria-label={`Move ${item.name} to trash`}
                      onClick={() => onTrash(item)}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </Tooltip>
                </>
              )}
            </div>
          </ActionTooltipGroup>
          ) : (
            <div
              ref={actionsRef}
              data-slot="file-search-actions"
              className="shrink-0 pointer-events-auto"
              onClick={(event) => event.stopPropagation()}
            >
              <Button
                variant="outline"
                surface="primary"
                size="icon"
                className="size-11"
                aria-label={`Actions for ${item.name}`}
                aria-haspopup="dialog"
                onClick={() => setSheetOpen(true)}
              >
                <Zap size={24} aria-hidden="true" />
              </Button>
            </div>
          )}
        </div>
      </div>
      <ModalCard open={sheetOpen} title={item.name} size="sm" onClose={() => setSheetOpen(false)}>
        {({ close }) => {
          const run = (fn) => () => {
            close();
            fn();
          };
          return (
            <div className="grid gap-2">
              {!isDir && (
                <CardButton action={href} actionLabel="Go to folder" icon={FolderOpen} align="start" className="mt-0" onClick={() => { close(); onNavigate(); }}>
                  Go to folder
                </CardButton>
              )}
              <CardButton
                actionLabel="Download"
                icon={Download}
                align="start"
                className="mt-0"
                onClick={run(() => window.location.assign(downloadHref(item.drive_id, item.path)))}
              >
                Download
              </CardButton>
              {canShare && (
                <CardButton actionLabel="Share" icon={Users} align="start" className="mt-0" onClick={run(() => onShare(item))}>
                  Share
                </CardButton>
              )}
              <CardButton actionLabel="Copy" icon={Copy} align="start" className="mt-0" onClick={run(() => onCopy("copy", item))}>
                Copy
              </CardButton>
              {canEdit && (
                <>
                  <CardButton actionLabel="Move" icon={FolderInput} align="start" className="mt-0" onClick={run(() => onCopy("move", item))}>
                    Move
                  </CardButton>
                  <CardButton variant="danger" actionLabel="Move to trash" icon={Trash2} align="start" className="mt-0 py-2" onClick={run(() => onTrash(item))}>
                    Move to trash
                  </CardButton>
                </>
              )}
            </div>
          );
        }}
      </ModalCard>
    </li>
  );
}
