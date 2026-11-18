import { AlertTriangle, CheckCircle2, File, Folder, HardDrive } from "lucide-react";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import { InfoHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { formatBytes } from "../../lib/formatBytes.js";
import { partitionStateLine, previewHeadline } from "../../lib/driveFormat.js";

/** How many top-level names to show per part before "and N more". */
const SHOWN_ENTRIES = 8;

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Luna's own bookkeeping folders (thumbnail caches): not something a person put there. */
const isLunaOwn = (name) => name.startsWith(".luna-");

function PartContents({ part }) {
  const stateLine = partitionStateLine(part.state);
  if (stateLine) return <p className="text-sm">{stateLine}</p>;
  const total = part.folders + part.files;
  if (part.state === "empty" || total === 0) return <p className="text-sm">Nothing on this part.</p>;
  const shown = (part.entries || []).filter((e) => !isLunaOwn(e.name)).slice(0, SHOWN_ENTRIES);
  const more = total - shown.length;
  return (
    <div className="space-y-2">
      <p className="text-sm">
        At the top level: {count(part.folders, "folder", "folders")}, {count(part.files, "file", "files")}
        {part.used_bytes != null ? `, ${formatBytes(part.used_bytes)} used` : ""}
      </p>
      {shown.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Names on this part">
          {shown.map((entry) => (
            <li key={`${entry.kind}:${entry.name}`} className="flex min-w-0 items-center gap-1">
              {entry.kind === "folder"
                ? <Folder size={14} className="shrink-0" aria-hidden="true" />
                : <File size={14} className="shrink-0" aria-hidden="true" />}
              <InlinePill>{entry.name}</InlinePill>
            </li>
          ))}
          {more > 0 && <li className="self-center text-xs">and {more} more</li>}
        </ul>
      )}
      {part.unreadable > 0 && <p className="text-xs">{count(part.unreadable, "item", "items")} couldn&apos;t be read.</p>}
    </div>
  );
}

/**
 * What is on the drive, recognisably: one card with the drive's name and size,
 * one status line, then each part's counts and top-level names. This is what
 * stops a wrong-drive erase, so it shows the server's findings and never
 * decides "empty" itself. The kernel name and serial sit one step in (ⓘ).
 *
 * Sits on a card (surface-secondary); the card it draws is surface-primary.
 *
 * @param {{ preview: any }} props the body of POST /api/v1/drive-format/preview
 */
export default function FormatPreview({ preview }) {
  const { device, partitions = [] } = preview;
  const headline = previewHeadline(preview);
  const StatusIcon = headline.tone === "calm" ? CheckCircle2 : AlertTriangle;
  const onePart = partitions.length === 1 && !partitions[0].label;
  return (
    <section className="surface-primary rounded-large-element p-4" aria-label="What is on this drive">
      <div className="flex items-center gap-3">
        <HardDrive size={20} className="shrink-0" aria-hidden="true" />
        <p className="min-w-0 flex-1 break-words font-mono text-base">
          {device.model || device.name}{" "}
          <InfoHint
            surface="primary"
            label="Which drive is this?"
            content={(
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <dt>System name</dt>
                <dd><InlinePill>{device.name}</InlinePill></dd>
                {device.serial ? <><dt>Serial number</dt><dd><InlinePill>{device.serial}</InlinePill></dd></> : null}
              </dl>
            )}
          />
        </p>
        {device.size_bytes ? <p className="shrink-0 font-mono text-sm">{formatBytes(device.size_bytes)}</p> : null}
      </div>
      <p className="mt-2 flex items-center gap-2 text-sm">
        <StatusIcon
          size={16}
          className={`shrink-0 ${headline.tone === "calm" ? "text-success" : "text-warning"}`}
          aria-hidden="true"
        />
        {headline.title}
      </p>
      {partitions.length > 0 && (
        <div className="mt-3 space-y-3 border-t border-accent pt-3">
          {partitions.map((part, i) => (
            <div key={part.name}>
              {!onePart && (
                <p className="mb-1 font-mono text-sm">
                  {part.label ? <InlinePill>{part.label}</InlinePill> : `Part ${i + 1}`}
                  {part.size_bytes ? `, ${formatBytes(part.size_bytes)}` : ""}
                </p>
              )}
              <PartContents part={part} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
