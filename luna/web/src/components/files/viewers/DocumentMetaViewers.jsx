import { useMemo } from "react";
import PropTypes from "prop-types";
import { BytesLoader } from "./bytesLoader.jsx";
import { fileExtension } from "../../../lib/fileKinds.js";
import { parseDelimited } from "../../../lib/delimited.js";
import { parseIcsEvents, parseVcf } from "../../../lib/officeConvert.js";

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
  const cells = useMemo(() => {
    try {
      const json = JSON.parse(new TextDecoder("utf-8").decode(bytes));
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
    <div className="space-y-3 max-h-[65vh] overflow-auto">
      {cells.map((cell, i) => {
        const source = Array.isArray(cell.source) ? cell.source.join("") : String(cell.source || "");
        const kind = cell.cell_type || "code";
        return (
          <div
            key={i}
            className="rounded-large-element bg-primary text-secondary border-2 border-secondary/20 p-4"
          >
            <p className="text-xs uppercase tracking-wide mb-2 opacity-80">{kind}</p>
            <pre className="whitespace-pre-wrap font-mono text-sm break-words">{source}</pre>
          </div>
        );
      })}
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
      {({ bytes }) => {
        const text = new TextDecoder("utf-8").decode(bytes);
        let pretty = text;
        try {
          pretty = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          // keep raw XML/text
        }
        return (
          <pre className="rounded-large-element bg-primary text-secondary border-2 border-secondary/20 p-4 max-h-[65vh] overflow-auto font-mono text-sm whitespace-pre-wrap break-words">
            {pretty.slice(0, 200_000)}
            {pretty.length > 200_000 ? "\n… (truncated)" : ""}
          </pre>
        );
      }}
    </BytesLoader>
  );
}

GeoViewer.propTypes = {
  driveId: PropTypes.string.isRequired,
  path: PropTypes.string.isRequired,
};

/** ICS event list. */
export function CalendarViewer({ driveId, path }) {
  return (
    <BytesLoader driveId={driveId} path={path} loadingLabel="Opening calendar…">
      {({ bytes }) => <CalendarList text={new TextDecoder("utf-8").decode(bytes)} />}
    </BytesLoader>
  );
}

CalendarViewer.propTypes = {
  driveId: PropTypes.string.isRequired,
  path: PropTypes.string.isRequired,
};

function CalendarList({ text }) {
  const events = useMemo(() => parseIcsEvents(text), [text]);
  if (events.length === 0) {
    return <p className="text-primary text-sm">No events found in this calendar file.</p>;
  }
  return (
    <ul className="space-y-3 max-h-[65vh] overflow-auto">
      {events.map((ev, i) => (
        <li
          key={`${ev.uid || i}`}
          className="rounded-large-element bg-primary text-secondary border-2 border-secondary/20 p-4"
        >
          <p className="font-mono text-base">{ev.summary || "Untitled event"}</p>
          {ev.dtstart && <p className="text-sm mt-1">Starts: {ev.dtstart}</p>}
          {ev.dtend && <p className="text-sm">Ends: {ev.dtend}</p>}
          {ev.location && <p className="text-sm mt-1">{ev.location}</p>}
        </li>
      ))}
    </ul>
  );
}

CalendarList.propTypes = {
  text: PropTypes.string.isRequired,
};

/** VCF contact card. */
export function ContactViewer({ driveId, path }) {
  return (
    <BytesLoader driveId={driveId} path={path} loadingLabel="Opening contact…">
      {({ bytes }) => <ContactCard text={new TextDecoder("utf-8").decode(bytes)} />}
    </BytesLoader>
  );
}

ContactViewer.propTypes = {
  driveId: PropTypes.string.isRequired,
  path: PropTypes.string.isRequired,
};

function ContactCard({ text }) {
  const contact = useMemo(() => parseVcf(text), [text]);
  return (
    <div className="rounded-large-element bg-primary text-secondary border-2 border-secondary/20 p-6 space-y-2">
      <p className="text-xl font-mono">{contact.fn || contact.n || "Contact"}</p>
      {contact.email && <p className="text-sm">{contact.email}</p>}
      {contact.tel && <p className="text-sm">{contact.tel}</p>}
      {contact.org && <p className="text-sm">{contact.org}</p>}
    </div>
  );
}

ContactCard.propTypes = {
  text: PropTypes.string.isRequired,
};

const CSV_ROW_CAP = 500;

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
  const rows = useMemo(() => {
    const text = new TextDecoder("utf-8").decode(bytes);
    const delimiter = fileExtension(path) === "tsv" ? "\t" : undefined;
    return parseDelimited(text, delimiter);
  }, [bytes, path]);

  if (rows.length === 0 || (rows.length === 1 && rows[0].every((c) => c === ""))) {
    return <p className="text-primary text-sm">This file is empty.</p>;
  }

  const shown = rows.slice(0, CSV_ROW_CAP);
  const [head, ...body] = shown;
  const colCount = Math.max(...shown.map((r) => r.length));

  return (
    <div className="space-y-2">
      <div className="rounded-large-element bg-primary text-secondary border-2 border-secondary/20 max-h-[65vh] overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              {Array.from({ length: colCount }, (_, i) => (
                <th
                  key={i}
                  className="sticky top-0 bg-primary px-3 py-2 text-left font-mono font-normal border-b-2 border-secondary/20 whitespace-nowrap"
                >
                  {head[i] ?? ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, ri) => (
              <tr key={ri}>
                {Array.from({ length: colCount }, (_, ci) => (
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
          Showing the first {CSV_ROW_CAP} of {rows.length} rows. Download the file to see the rest.
        </p>
      ) : null}
    </div>
  );
}

CsvTable.propTypes = {
  bytes: PropTypes.any.isRequired,
  path: PropTypes.string.isRequired,
};
