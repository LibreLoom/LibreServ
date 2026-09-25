import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { BytesLoader } from "./bytesLoader.jsx";
import EpubReader from "./EpubReader.jsx";

/**
 * EPUB reader (foliate-js: spine order, TOC, pagination, position memory).
 * `fill` lays the reader out to fill its flex parent — FileViewer's
 * fullscreen fallback.
 */
export default function EbookViewer({ driveId, path, fill = false }) {
  return (
    <BytesLoader
      driveId={driveId}
      path={path}
      loadingLabel="Opening book…"
      surface={fill ? "primary" : "secondary"}
    >
      {({ bytes }) => <EpubReader bytes={bytes} driveId={driveId} path={path} fill={fill} />}
    </BytesLoader>
  );
}

EbookViewer.propTypes = {
  driveId: PropTypes.string.isRequired,
  path: PropTypes.string.isRequired,
  fill: PropTypes.bool,
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
      {/* color-scan: ignore-next-line pangram sample text, not a color */}
      <p className="text-xl leading-relaxed" style={{ fontFamily: family }}>The quick brown fox jumps over the lazy dog.</p>
    </div>
  );
}

FontSample.propTypes = {
  bytes: PropTypes.any.isRequired,
  path: PropTypes.string.isRequired,
};
