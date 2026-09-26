import { useQuery } from "@tanstack/react-query";
import {
  BookOpen,
  CalendarPlus,
  Clock,
  Contact,
  Download,
  Eye,
  EyeOff,
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileQuestion,
  FileText,
  FileType,
  Film,
  Folder,
  FolderTree,
  HardDrive,
  Image,
  Info,
  Link2,
  Map,
  NotebookPen,
  Pencil,
  Shapes,
  Table,
  Trash2,
  Undo2,
} from "lucide-react";
import PropTypes from "prop-types";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import IconCircle from "@libreloom/ui/components/ui/IconCircle.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import Pill from "@libreloom/ui/components/common/Pill.jsx";
import { TermHint, Tooltip } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { apiErrorMessage } from "../../lib/api.js";
import { fileExtension, openableKind } from "../../lib/fileKinds.js";
import { fileSourceScope, useFileSource } from "../../lib/fileSource.jsx";
import {
  fmtSize,
  homeAwareLabel,
  isMemberHomePath,
  parentPath,
  pathBasename,
} from "../../lib/paths.js";
import { useOptionalAuth } from "../../context/AuthContext.jsx";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";

const TYPE_LABELS = {
  image: "Image",
  video: "Video",
  office: "Office document",
  pdf: "PDF document",
  audio: "Audio",
  ebook: "E-book",
  comic: "Comic archive",
  font: "Font",
  notebook: "Notebook",
  geo: "Map data",
  calendar: "Calendar file",
  contact: "Contact card",
  archive: "Archive",
  csv: "Table data",
  markdown: "Markdown document",
  text: "Text file",
};

const KIND_ICONS = {
  image: Image,
  video: Film,
  office: FileText,
  pdf: FileText,
  audio: FileAudio,
  ebook: BookOpen,
  comic: FileArchive,
  font: FileType,
  notebook: NotebookPen,
  geo: Map,
  calendar: CalendarPlus,
  contact: Contact,
  archive: FileArchive,
  csv: Table,
  markdown: FileText,
  text: FileText,
};

/** The hero icon matching this entry — folder, link, or a file-type glyph. */
function kindIcon(name, kind) {
  if (kind === "dir") return Folder;
  if (kind === "symlink") return Link2;
  if (kind === "other") return FileQuestion;
  return KIND_ICONS[openableKind(name)] || FileIcon;
}

/** Plain-language type for the row — "Folder", "Image (.jpg)", "File". */
function typeLabel(name, kind) {
  if (kind === "dir") return "Folder";
  if (kind === "symlink") return "Link";
  if (kind === "other") return "Special item";
  const base = TYPE_LABELS[openableKind(name)] || "File";
  const ext = fileExtension(name);
  return ext ? `${base} (.${ext})` : base;
}

/** Full timestamp for the modal — the list only had room for a short date. */
function fmtWhen(unix) {
  const seconds = Number(unix) || 0;
  if (seconds <= 0) return "";
  return new Date(seconds * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function childrenLabel(children) {
  if (!children) return "";
  const parts = [];
  if (children.dirs) {
    parts.push(`${children.dirs} ${children.dirs === 1 ? "folder" : "folders"}`);
  }
  if (children.files) {
    parts.push(`${children.files} ${children.files === 1 ? "file" : "files"}`);
  }
  if (children.other) {
    parts.push(`${children.other} other ${children.other === 1 ? "item" : "items"}`);
  }
  return parts.length ? parts.join(", ") : "Nothing inside";
}

/** "Drive / folder / subfolder" — the folder this item lives in. */
function locationLabel(driveLabel, rel, ownHomePath = "") {
  if (isMemberHomePath(rel)) {
    return `${driveLabel} / ${homeAwareLabel(rel, ownHomePath)}`;
  }
  const segments = rel ? rel.split("/").filter(Boolean) : [];
  return [driveLabel, ...segments].join(" / ");
}

/** A layered panel inside the sheet — primary surface on the secondary card. */
function Section({ title = "", children }) {
  return (
    <section className="rounded-large-element bg-primary p-4 text-secondary">
      {title ? (
        <h3 className="mb-1 flex items-center gap-2 text-xs font-mono uppercase tracking-widest text-secondary">
          {title}
        </h3>
      ) : null}
      {children}
    </section>
  );
}

Section.propTypes = {
  title: PropTypes.string,
  children: PropTypes.node.isRequired,
};

/** Icon + label + value — one scannable fact. */
function DetailRow({ icon: Icon, label, value, mono = false }) {
  if (!value) return null;
  return (
    <div className="flex items-center gap-3 py-2 border-b border-secondary/15 last:border-b-0">
      <Icon size={ICON_SIZE.sm} className="shrink-0 text-accent" aria-hidden="true" />
      <span className="shrink-0 text-xs font-mono uppercase tracking-widest text-secondary">
        {label}
      </span>
      <span
        className={`ml-auto min-w-0 break-all text-right text-sm text-secondary ${mono ? "font-mono" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}

DetailRow.propTypes = {
  icon: PropTypes.elementType.isRequired,
  label: PropTypes.string.isRequired,
  value: PropTypes.node,
  mono: PropTypes.bool,
};

/** One mini-stat inside the totals grid — inverted layer for depth. */
function MiniStat({ icon: Icon, value, label }) {
  return (
    <div className="flex flex-1 flex-col items-center gap-1 rounded-large-element bg-secondary px-2 py-3 text-primary">
      <Icon size={ICON_SIZE.sm} className="text-accent" aria-hidden="true" />
      <span className="font-mono text-lg leading-none text-primary">{value}</span>
      <span className="text-[11px] font-mono uppercase tracking-widest text-primary">{label}</span>
    </div>
  );
}

MiniStat.propTypes = {
  icon: PropTypes.elementType.isRequired,
  value: PropTypes.oneOfType([PropTypes.number, PropTypes.string]).isRequired,
  label: PropTypes.string.isRequired,
};

/**
 * @param {{ label: string, onClick: () => void }} props
 */
/** @param {{ label: string, onClick: () => void, surface?: "primary" | "secondary" }} props */
export function PropertiesButton({ label, onClick, surface = "secondary" }) {
  return (
    <Tooltip content="Properties">
      <Button
        variant="ghost"
        surface={surface}
        size="iconSm"
        aria-label={`Properties for ${label}`}
        onClick={onClick}
      >
        <Info size={ICON_SIZE.sm} />
      </Button>
    </Tooltip>
  );
}

PropertiesButton.propTypes = {
  label: PropTypes.string.isRequired,
  onClick: PropTypes.func.isRequired,
  surface: PropTypes.oneOf(["primary", "secondary"]),
};

/**
 * Details for one file or folder, fetched fresh each time it opens.
 *
 * @param {{
 *   open?: boolean,
 *   onClose: () => void,
 *   driveId: string,
 *   driveLabel?: string,
 *   path: string,
 *   parent?: string,
 *   entry?: { name?: string, kind?: string, size?: number, modified?: number, hidden?: boolean, saving?: boolean } | null,
 *   inTrash?: boolean,
 * }} props
 */
export default function PropertiesSheet({
  open = true,
  onClose,
  driveId,
  driveLabel = "Drive",
  path,
  parent = "",
  entry = null,
  inTrash = false,
}) {
  const source = useFileSource();
  const ownHomePath = useOptionalAuth()?.user?.home?.path || "";
  const stat = useQuery({
    queryKey: ["file-stat", fileSourceScope(source, driveId), path],
    queryFn: () => source.stat(driveId, path),
    enabled: open && Boolean(driveId),
  });

  const data = stat.data && !Array.isArray(stat.data) ? stat.data : null;
  const name = data?.name || entry?.name || pathBasename(path) || driveLabel;
  const kind = data?.kind || entry?.kind || "file";
  const HeroIcon = kindIcon(name, kind);
  const trashedParent = data?.trashed_from ? parentPath(data.trashed_from) : null;
  const location = inTrash
    ? `Trash on ${driveLabel}`
    : locationLabel(driveLabel, parent, ownHomePath);
  const saving = Boolean(data?.saving ?? entry?.saving);
  const hidden = Boolean(data?.hidden ?? entry?.hidden);
  const modified = data?.modified ?? entry?.modified;
  const totals = kind === "dir" && data?.totals ? data.totals : null;
  const totalsComplete = totals?.complete !== false;
  const emptyFolder = totalsComplete && totals && !totals.dirs && !totals.files && !totals.other;
  // Trash is read-only, not unreadable — downloads stay on; "other" (fifo,
  // socket…) has nothing to fetch.
  const canDownload = kind !== "other";

  return (
    <ModalCard
      open={open}
      onClose={onClose}
      loading={stat.isLoading}
      title={<span className="break-all">{name}</span>}
    >
      {stat.isError ? (
        <>
          <PageNotice variant="error" className="mb-3">
            {apiErrorMessage(stat.error, "Couldn't load the details. Try again.")}
          </PageNotice>
          <Button variant="outline" surface="secondary" size="sm" onClick={() => stat.refetch()}>
            Try again
          </Button>
        </>
      ) : (
        <div className="space-y-3">
          {/* Identity: type glyph + the pills that describe it at a glance. */}
          <div className="flex items-center gap-3">
            <IconCircle icon={HeroIcon} size="lg" variant="default" className="shrink-0" />
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <Pill variant="accent" className="max-w-full">
                <span className="truncate">{typeLabel(name, kind)}</span>
              </Pill>
              {data ? (
                <Pill variant={data.writable ? "success" : "muted"}>
                  {data.writable ? (
                    <>
                      <Pencil size={ICON_SIZE.xs} aria-hidden="true" />
                      <TermHint content="You can rename, move, or delete this item.">
                        View and change
                      </TermHint>
                    </>
                  ) : (
                    <>
                      <Eye size={ICON_SIZE.xs} aria-hidden="true" />
                      <TermHint content="You can open this item, but not change it.">
                        View only
                      </TermHint>
                    </>
                  )}
                </Pill>
              ) : null}
              {inTrash ? (
                <Pill variant="warning">
                  <Trash2 size={ICON_SIZE.xs} aria-hidden="true" />
                  In Trash
                </Pill>
              ) : null}
              {hidden ? (
                <Pill variant="warning">
                  <EyeOff size={ICON_SIZE.xs} aria-hidden="true" />
                  <TermHint content="Its name starts with a dot, so it stays out of the way.">
                    Hidden
                  </TermHint>
                </Pill>
              ) : null}
              {saving ? (
                <Pill variant="info">
                  <Clock size={ICON_SIZE.xs} aria-hidden="true" />
                  Still saving
                </Pill>
              ) : null}
            </div>
          </div>

          {/* The headline number: size for files, everything-inside for folders. */}
          {kind === "file" && data ? (
            <Section>
              <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-widest text-secondary">
                <HardDrive size={ICON_SIZE.sm} className="text-accent" aria-hidden="true" />
                Size
              </div>
              <p className="mt-1 font-mono text-3xl leading-none text-secondary">
                {fmtSize(data.size)}
              </p>
              <p className="mt-2 text-xs text-secondary">
                {Number(data.size || 0).toLocaleString()} bytes
              </p>
            </Section>
          ) : null}

          {kind === "dir" && data ? (
            <Section>
              {totals ? (
                <>
                  <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-widest text-secondary">
                    <HardDrive size={ICON_SIZE.sm} className="text-accent" aria-hidden="true" />
                    {emptyFolder || !totalsComplete ? "Inside" : "Total size"}
                  </div>
                  {emptyFolder ? (
                    <p className="mt-1 text-sm text-secondary">
                      Nothing inside — this folder is empty.
                    </p>
                  ) : (
                    <>
                      <p className="mt-1 font-mono text-3xl leading-none text-secondary">
                        {totalsComplete ? fmtSize(totals.bytes) : `≥ ${fmtSize(totals.bytes)}`}
                      </p>
                      <p className="mt-2 text-xs text-secondary">
                        {totalsComplete
                          ? `${Number(totals.bytes).toLocaleString()} bytes altogether`
                          : `at least ${Number(totals.bytes).toLocaleString()} bytes — there's too much inside to count it all`}
                      </p>
                      <div className="mt-3 flex gap-2">
                        <MiniStat
                          icon={Folder}
                          value={totalsComplete ? totals.dirs : `${totals.dirs}+`}
                          label={totals.dirs === 1 && totalsComplete ? "folder" : "folders"}
                        />
                        <MiniStat
                          icon={FileIcon}
                          value={totalsComplete ? totals.files : `${totals.files}+`}
                          label={totals.files === 1 && totalsComplete ? "file" : "files"}
                        />
                        {totals.other ? (
                          <MiniStat
                            icon={Link2}
                            value={totalsComplete ? totals.other : `${totals.other}+`}
                            label={totals.other === 1 && totalsComplete ? "link" : "links"}
                          />
                        ) : null}
                      </div>
                    </>
                  )}
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-widest text-secondary">
                    <Shapes size={ICON_SIZE.sm} className="text-accent" aria-hidden="true" />
                    Inside
                  </div>
                  {data.children && (data.children.dirs || data.children.files || data.children.other) ? (
                    <p className="mt-1 text-sm text-secondary">{childrenLabel(data.children)}</p>
                  ) : (
                    <p className="mt-1 text-sm text-secondary">
                      Nothing inside — this folder is empty.
                    </p>
                  )}
                </>
              )}
            </Section>
          ) : null}

          {/* Where it is and what it is. */}
          <Section title="Details">
            <DetailRow icon={Shapes} label="Type" value={typeLabel(name, kind)} mono />
            <DetailRow icon={FolderTree} label="Location" value={location} mono />
            {inTrash && data?.trashed_from ? (
              <DetailRow
                icon={Undo2}
                label="Was in"
                value={locationLabel(driveLabel, trashedParent || "", ownHomePath)}
                mono
              />
            ) : null}
            {data?.link_target ? (
              <DetailRow icon={Link2} label="Links to" value={data.link_target} mono />
            ) : null}
          </Section>

          {/* Timeline facts. */}
          <Section title="Activity">
            <DetailRow icon={Clock} label="Last changed" value={fmtWhen(modified)} mono />
            {data?.created ? (
              <DetailRow icon={CalendarPlus} label="Added" value={fmtWhen(data.created)} mono />
            ) : null}
          </Section>

          {canDownload ? (
            <Button variant="outline" surface="secondary" size="sm" asChild>
              <a href={source.downloadHref(driveId, path)}>
                <Download size={ICON_SIZE.sm} aria-hidden="true" />
                Download
              </a>
            </Button>
          ) : null}
        </div>
      )}
    </ModalCard>
  );
}

PropertiesSheet.propTypes = {
  open: PropTypes.bool,
  onClose: PropTypes.func.isRequired,
  driveId: PropTypes.string.isRequired,
  driveLabel: PropTypes.string,
  path: PropTypes.string.isRequired,
  parent: PropTypes.string,
  entry: PropTypes.object,
  inTrash: PropTypes.bool,
};
