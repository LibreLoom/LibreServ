import { useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import { listZipEntries, readZipEntry } from "../../../lib/archiveReader.js";
import { BytesLoader } from "./bytesLoader.jsx";

/** Read-only EPUB pager (XHTML from the zip). */
export default function EbookViewer({ driveId, path }) {
  return (
    <BytesLoader driveId={driveId} path={path} loadingLabel="Opening book…">
      {({ bytes }) => <EpubPager bytes={bytes} />}
    </BytesLoader>
  );
}

EbookViewer.propTypes = {
  driveId: PropTypes.string.isRequired,
  path: PropTypes.string.isRequired,
};

function EpubPager({ bytes }) {
  const chapters = useMemo(() => {
    try {
      return listZipEntries(bytes)
        .filter((e) => /\.(xhtml|html|htm)$/i.test(e.name) && !e.name.endsWith("/"))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    } catch {
      return [];
    }
  }, [bytes]);
  const [index, setIndex] = useState(0);
  const [html, setHtml] = useState("");
  const [error, setError] = useState(/** @type {string|null} */ (null));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!chapters[index]) {
        setHtml("");
        return;
      }
      try {
        const data = await readZipEntry(bytes, chapters[index]);
        if (cancelled) return;
        setHtml(new TextDecoder("utf-8").decode(data));
        setError(null);
      } catch {
        if (!cancelled) setError("Could not read this chapter.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bytes, chapters, index]);

  if (chapters.length === 0) {
    return (
      <p className="text-primary text-sm">
        Luna could not find readable chapters in this book. Try downloading it.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          className="rounded-pill border-2 border-secondary/30 px-4 py-2 text-sm disabled:opacity-40"
          disabled={index <= 0}
          onClick={() => setIndex((i) => Math.max(0, i - 1))}
        >
          Previous
        </button>
        <p className="text-sm text-primary">
          Section {index + 1} of {chapters.length}
        </p>
        <button
          type="button"
          className="rounded-pill border-2 border-secondary/30 px-4 py-2 text-sm disabled:opacity-40"
          disabled={index >= chapters.length - 1}
          onClick={() => setIndex((i) => Math.min(chapters.length - 1, i + 1))}
        >
          Next
        </button>
      </div>
      {error ? (
        <p className="text-primary text-sm">{error}</p>
      ) : (
        <iframe
          title="Book section"
          className="w-full h-[55vh] rounded-large-element bg-primary border-2 border-secondary/20"
          sandbox=""
          srcDoc={html}
        />
      )}
    </div>
  );
}

EpubPager.propTypes = {
  bytes: PropTypes.any.isRequired,
};

/** Font sample card via FontFace. */
export function FontViewer({ driveId, path }) {
  return (
    <BytesLoader driveId={driveId} path={path} loadingLabel="Opening font…">
      {({ bytes }) => <FontSample bytes={bytes} path={path} />}
    </BytesLoader>
  );
}

FontViewer.propTypes = {
  driveId: PropTypes.string.isRequired,
  path: PropTypes.string.isRequired,
};

function FontSample({ bytes, path }) {
  const [family, setFamily] = useState(/** @type {string|null} */ (null));
  const [error, setError] = useState(/** @type {string|null} */ (null));
  const name = path.split("/").pop() || "font";

  useEffect(() => {
    let cancelled = false;
    const id = `luna-font-${Math.random().toString(36).slice(2)}`;
    (async () => {
      try {
        const face = new FontFace(id, bytes);
        await face.load();
        if (cancelled) return;
        document.fonts.add(face);
        setFamily(id);
      } catch {
        if (!cancelled) setError("Luna couldn't load this font in the browser.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bytes]);

  if (error) return <p className="text-primary text-sm">{error}</p>;
  if (!family) return <p className="text-primary text-sm">Loading font…</p>;

  return (
    <div className="rounded-large-element bg-primary text-secondary p-6 space-y-4">
      <p className="text-sm break-all">{name}</p>
      <p className="text-4xl leading-relaxed" style={{ fontFamily: family }}>
        ABCDEFGHIJKLMNOPQRSTUVWXYZ
      </p>
      <p className="text-2xl leading-relaxed" style={{ fontFamily: family }}>
        abcdefghijklmnopqrstuvwxyz 0123456789
      </p>
      <p className="text-xl leading-relaxed" style={{ fontFamily: family }}>
        The quick brown fox jumps over the lazy dog.
      </p>
    </div>
  );
}

FontSample.propTypes = {
  bytes: PropTypes.any.isRequired,
  path: PropTypes.string.isRequired,
};
