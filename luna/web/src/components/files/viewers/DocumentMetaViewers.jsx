import { useMemo, useState } from "react";
import PropTypes from "prop-types";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import { BytesLoader } from "./bytesLoader.jsx";
import { fileExtension } from "../../../lib/fileKinds.js";
import { parseDelimited } from "../../../lib/delimited.js";
import { parseIcsEvents, parseVcf } from "../../../lib/officeConvert.js";

const TEXT_DECODER = new TextDecoder("utf-8");
const GEO_PREVIEW_LIMIT = 200_000;

/** @param {{ page: number, size: number, count: number, label: string, onChange: (page: number) => void }} props */
function PreviewPager({ page, size, count, label, onChange }) {
  if (count <= size) return null;
  const start = page * size;
  const end = Math.min(start + size, count);
  return (
    <nav aria-label={label} className="flex flex-wrap items-center justify-end gap-2">
      <span className="text-sm" role="status">{start + 1}–{end} of {count}</span>
      <Button variant="outline" size="sm" disabled={start === 0} onClick={() => onChange(page - 1)}>
        Previous
      </Button>
      <Button variant="outline" size="sm" disabled={end === count} onClick={() => onChange(page + 1)}>
        Next
      </Button>
    </nav>
  );
}

/** Read-only Jupyter notebook renderer. */
export default function NotebookViewer({ driveId, path }) {
  return (
    <BytesLoader driveId={driveId} path={path} loadingLabel="Opening notebook…">
      {({ bytes }) => <NotebookBody bytes={bytes} />}
    </BytesLoader>
  );
}

NotebookViewer.propTypes = {
  driveId: PropTypes.string.isRequired,
  path: PropTypes.string.isRequired,
};

function NotebookBody({ bytes }) {
  const [page, setPage] = useState(0);
  const size = 30;
  const cells = useMemo(() => {
    try {
      const json = JSON.parse(TEXT_DECODER.decode(bytes));
      return Array.isArray(json.cells) ? json.cells : [];
    } catch {
      return null;
    }
  }, [bytes]);

  if (!cells) {
    return <p className="text-primary text-sm">This notebook file looks damaged.</p>;
  }
  if (cells.length === 0) {
    return <p className="text-primary text-sm">This notebook has no cells.</p>;
  }

  return (
    <div className="space-y-2">
      <PreviewPager page={page} size={size} count={cells.length} label="Notebook pages" onChange={setPage} />
      <div key={page} className="space-y-3 max-h-[65vh] overflow-auto">
        {cells.slice(page * size, (page + 1) * size).map((cell, i) => {
          const source = Array.isArray(cell.source) ? cell.source.join("") : String(cell.source || "");
          const kind = cell.cell_type || "code";
          return (
            <div
              key={i}
              className="rounded-large-element surface-primary border-2 border-secondary/20 p-4"
            >
              <p className="text-xs mb-2 opacity-80">{kind}</p>
              <pre className="whitespace-pre-wrap font-mono text-sm break-words">{source}</pre>
            </div>
          );
        })}
      </div>
    </div>
  );
}

NotebookBody.propTypes = {
  bytes: PropTypes.any.isRequired,
};

/** GeoJSON / GPX / KML structured text preview. */
export function GeoViewer({ driveId, path }) {
  return (
    <BytesLoader driveId={driveId} path={path} loadingLabel="Opening map file…">
      {({ bytes }) => <GeoPreview bytes={bytes} />}
    </BytesLoader>
  );
}

GeoViewer.propTypes = {
  driveId: PropTypes.string.isRequired,
  path: PropTypes.string.isRequired,
};

function GeoPreview({ bytes }) {
  const preview = useMemo(() => {
    // Four bytes per code point is enough to reach the character preview cap.
    const prefix = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, GEO_PREVIEW_LIMIT * 4));
    const text = TEXT_DECODER.decode(prefix);
    if (bytes.byteLength > GEO_PREVIEW_LIMIT) return text;
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }, [bytes]);
  return (
    <pre className="rounded-large-element surface-primary border-2 border-secondary/20 p-4 max-h-[65vh] overflow-auto font-mono text-sm whitespace-pre-wrap break-words">
      {preview.slice(0, GEO_PREVIEW_LIMIT)}
      {preview.length > GEO_PREVIEW_LIMIT ? "\n\nShowing the first 200,000 characters. Download the file to see the rest." : ""}
    </pre>
  );
}
GeoPreview.propTypes = { bytes: PropTypes.any.isRequired };

/** ICS event list. */
export function CalendarViewer({ driveId, path }) {
  return (
    <BytesLoader driveId={driveId} path={path} loadingLabel="Opening calendar…">
      {({ bytes }) => <CalendarList bytes={bytes} />}
    </BytesLoader>
  );
}

CalendarViewer.propTypes = {
  driveId: PropTypes.string.isRequired,
  path: PropTypes.string.isRequired,
};

function CalendarList({ bytes }) {
  const [page, setPage] = useState(0);
  const size = 50;
  const events = useMemo(() => parseIcsEvents(TEXT_DECODER.decode(bytes)), [bytes]);
  if (events.length === 0) {
    return <p className="text-primary text-sm">No events found in this calendar file.</p>;
  }
  return (
    <div className="space-y-2">
      <PreviewPager page={page} size={size} count={events.length} label="Calendar pages" onChange={setPage} />
      <ul key={page} className="space-y-3 max-h-[65vh] overflow-auto">
        {events.slice(page * size, (page + 1) * size).map((ev, i) => (
          <li
            key={i}
            className="rounded-large-element surface-primary border-2 border-secondary/20 p-4"
          >
            <p className="font-mono text-base">{ev.summary || "Untitled event"}</p>
            {ev.dtstart && <p className="text-sm mt-1">Starts: {ev.dtstart}</p>}
            {ev.dtend && <p className="text-sm">Ends: {ev.dtend}</p>}
            {ev.location && <p className="text-sm mt-1">{ev.location}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

CalendarList.propTypes = {
  bytes: PropTypes.any.isRequired,
};

/** VCF contact card. */
export function ContactViewer({ driveId, path }) {
  return (
    <BytesLoader driveId={driveId} path={path} loadingLabel="Opening contact…">
      {({ bytes }) => <ContactCard bytes={bytes} />}
    </BytesLoader>
  );
}

ContactViewer.propTypes = {
  driveId: PropTypes.string.isRequired,
  path: PropTypes.string.isRequired,
};

function ContactCard({ bytes }) {
  const contact = useMemo(() => parseVcf(TEXT_DECODER.decode(bytes)), [bytes]);
  return (
    <div className="rounded-large-element surface-primary border-2 border-secondary/20 p-6 space-y-2">
      <p className="text-xl font-mono">{contact.fn || contact.n || "Contact"}</p>
      {contact.email && <p className="text-sm">{contact.email}</p>}
      {contact.tel && <p className="text-sm">{contact.tel}</p>}
      {contact.org && <p className="text-sm">{contact.org}</p>}
    </div>
  );
}

ContactCard.propTypes = {
  bytes: PropTypes.any.isRequired,
};

const CSV_ROW_CAP = 500;
const CSV_PAGE_ROWS = 50;
const CSV_PAGE_COLUMNS = 30;

/** csv/tsv read-only table preview. */
export function CsvViewer({ driveId, path }) {
  return (
    <BytesLoader driveId={driveId} path={path} loadingLabel="Opening table…">
      {({ bytes }) => <CsvTable bytes={bytes} path={path} />}
    </BytesLoader>
  );
}

CsvViewer.propTypes = {
  driveId: PropTypes.string.isRequired,
  path: PropTypes.string.isRequired,
};

function CsvTable({ bytes, path }) {
  const [page, setPage] = useState(0);
  const [columnPage, setColumnPage] = useState(0);
  const rows = useMemo(() => {
    const text = TEXT_DECODER.decode(bytes);
    const delimiter = fileExtension(path) === "tsv" ? "\t" : undefined;
    return parseDelimited(text, delimiter, CSV_ROW_CAP + 1);
  }, [bytes, path]);
  const colCount = useMemo(
    () => rows.slice(0, CSV_ROW_CAP).reduce((count, row) => Math.max(count, row.length), 0),
    [rows],
  );

  if (rows.length === 0 || (rows.length === 1 && rows[0].every((c) => c === ""))) {
    return <p className="text-primary text-sm">This file is empty.</p>;
  }

  const head = rows[0];
  const rowCount = Math.min(rows.length, CSV_ROW_CAP) - 1;
  const rowStart = page * CSV_PAGE_ROWS;
  const body = rows.slice(1 + rowStart, 1 + Math.min(rowCount, rowStart + CSV_PAGE_ROWS));
  const colStart = columnPage * CSV_PAGE_COLUMNS;
  const cols = Array.from({ length: Math.min(colCount - colStart, CSV_PAGE_COLUMNS) }, (_, i) => colStart + i);

  return (
    <div className="space-y-2">
      <PreviewPager page={page} size={CSV_PAGE_ROWS} count={rowCount} label="Table row pages" onChange={setPage} />
      <PreviewPager page={columnPage} size={CSV_PAGE_COLUMNS} count={colCount} label="Table column pages" onChange={setColumnPage} />
      <div key={`${page}:${columnPage}`} className="rounded-large-element surface-primary border-2 border-secondary/20 max-h-[65vh] overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              {cols.map((i) => (
                <th
                  key={i}
                  className="sticky top-0 surface-primary px-3 py-2 text-left font-mono font-normal border-b-2 border-secondary/20 whitespace-nowrap"
                >
                  {head[i] ?? ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, ri) => (
              <tr key={ri}>
                {cols.map((ci) => (
                  <td
                    key={ci}
                    className="px-3 py-1.5 border-b border-secondary/10 whitespace-pre-wrap break-words align-top"
                  >
                    {row[ci] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > CSV_ROW_CAP ? (
        <p className="text-primary text-sm">
          Showing the first {CSV_ROW_CAP} rows. Download the file to see the rest.
        </p>
      ) : null}
    </div>
  );
}

CsvTable.propTypes = {
  bytes: PropTypes.any.isRequired,
  path: PropTypes.string.isRequired,
};
