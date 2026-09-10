import { useMemo } from "react";
import PropTypes from "prop-types";
import { BytesLoader } from "./bytesLoader.jsx";

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

/** @param {string} text */
function parseIcsEvents(text) {
  const events = [];
  const blocks = text.split("BEGIN:VEVENT").slice(1);
  for (const block of blocks) {
    const body = block.split("END:VEVENT")[0] || "";
    events.push({
      summary: icsField(body, "SUMMARY"),
      dtstart: icsField(body, "DTSTART"),
      dtend: icsField(body, "DTEND"),
      location: icsField(body, "LOCATION"),
      uid: icsField(body, "UID"),
    });
  }
  return events;
}

/** @param {string} body @param {string} key */
function icsField(body, key) {
  const re = new RegExp(`^${key}[^:]*:(.*)$`, "im");
  const m = body.match(re);
  return m ? m[1].trim() : "";
}

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

/** @param {string} text */
function parseVcf(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).split(";")[0].toUpperCase();
    const value = line.slice(idx + 1).trim();
    if (key === "FN") out.fn = value;
    if (key === "N") out.n = value.replace(/;/g, " ").trim();
    if (key === "EMAIL") out.email = value;
    if (key === "TEL") out.tel = value;
    if (key === "ORG") out.org = value;
  }
  return out;
}

/** CAD / 3D — download only (no Luna 3D). */
export function CadDownloadMessage() {
  return (
    <p className="text-primary text-sm">
      Luna does not open 3D or CAD files in the browser. Download the file and open it with the app
      you use for that format.
    </p>
  );
}
