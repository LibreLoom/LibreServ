import { File, Folder } from "lucide-react";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import { formatBytes } from "../../lib/formatBytes.js";
import { partitionStateLine, previewHeadline } from "../../lib/driveFormat.js";

/** How many top-level names to list per part before "and N more". */
const SHOWN_ENTRIES = 12;

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function PartContents({ part }) {
  const stateLine = partitionStateLine(part.state);
  if (stateLine) return <p className="text-sm">{stateLine}</p>;
  const total = part.folders + part.files;
  if (part.state === "empty" || total === 0) return <p className="text-sm">Nothing on this part.</p>;
  const shown = (part.entries || []).slice(0, SHOWN_ENTRIES);
  const more = total - shown.length;
  return (
    <>
      <p className="text-sm">
        {count(part.folders, "folder", "folders")}, {count(part.files, "file", "files")}
        {part.used_bytes != null ? `, ${formatBytes(part.used_bytes)} used` : ""}
      </p>
      {shown.length > 0 && (
        <ul className="mt-2 space-y-1" aria-label="Names on this part">
          {shown.map((entry) => (
            <li key={`${entry.kind}:${entry.name}`} className="flex items-center gap-2 text-sm">
              {entry.kind === "folder"
                ? <Folder size={14} className="shrink-0" aria-hidden="true" />
                : <File size={14} className="shrink-0" aria-hidden="true" />}
              <InlinePill>{entry.name}</InlinePill>
            </li>
          ))}
        </ul>
      )}
      {more > 0 && <p className="mt-2 text-xs">and {more} more at the top level of this part</p>}
      {part.unreadable > 0 && (
        <p className="mt-2 text-xs">{count(part.unreadable, "item", "items")} couldn&apos;t be read.</p>
      )}
    </>
  );
}

/**
 * What is on the drive, recognisably: the volume name, top-level folder and
 * file names, counts and space used. This is what stops a wrong-drive erase,
 * so it shows the server's findings and never decides "empty" itself.
 *
 * Sits on a card (surface-secondary); its panels are surface-primary.
 *
 * @param {{ preview: any }} props the body of POST /api/v1/drive-format/preview
 */
export default function FormatPreview({ preview }) {
  const { device, partitions = [] } = preview;
  const headline = previewHeadline(preview);
  const used = preview.used_bytes;
  return (
    <div className="space-y-3">
      <div className="surface-primary rounded-large-element p-4">
        <p className="font-mono text-base">{headline.title}</p>
        <p className="mt-1 text-sm">
          <InlinePill>{device.model || device.name}</InlinePill>
          {device.size_bytes ? <>, {formatBytes(device.size_bytes)}</> : null}
          {used != null && !preview.empty ? <>, {formatBytes(used)} used</> : null}
        </p>
      </div>
      {partitions.map((part, i) => (
        <div key={part.name} className="surface-primary rounded-large-element p-4">
          <p className="font-mono text-sm">
            {part.label ? <InlinePill>{part.label}</InlinePill> : `Part ${i + 1}`}
            {part.size_bytes ? `, ${formatBytes(part.size_bytes)}` : ""}
          </p>
          <div className="mt-2"><PartContents part={part} /></div>
        </div>
      ))}
      <p className="text-xs">
        Connected as <InlinePill>{device.name}</InlinePill>
        {device.serial ? <>, serial number <InlinePill>{device.serial}</InlinePill></> : null}
      </p>
    </div>
  );
}
