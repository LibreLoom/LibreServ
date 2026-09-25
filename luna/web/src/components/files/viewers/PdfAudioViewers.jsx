import { useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import { BytesLoader, fetchDriveBlobUrl } from "./bytesLoader.jsx";
import { useFileSource } from "../../../lib/fileSource.jsx";

/**
 * Sandboxed PDF preview via blob URL (never served inline at the Luna
 * origin). `fill` swaps the modal-sized frame for a flex-fill one and the
 * text tokens for a `bg-primary` surface — used by FileViewer's fullscreen
 * fallback when EuroOffice is missing.
 */
export default function PdfViewer({ driveId, path, fill = false }) {
  const source = useFileSource();
  const [url, setUrl] = useState(/** @type {string|null} */ (null));
  const [error, setError] = useState(/** @type {string|null} */ (null));

  useEffect(() => {
    let revoked = false;
    let objectUrl = /** @type {string|null} */ (null);
    (async () => {
      try {
        objectUrl = await fetchDriveBlobUrl(source, driveId, path, "application/pdf");
        if (!revoked) setUrl(objectUrl);
      } catch {
        if (!revoked) setError("Luna couldn't open this PDF. Try downloading it.");
      }
    })();
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [source, driveId, path]);

  const textTone = fill ? "text-secondary" : "text-primary";
  if (error) return <p className={`${textTone} text-sm`}>{error}</p>;
  if (!url) return <p className={`${textTone} text-sm`}>Opening PDF…</p>;

  return (
    <iframe
      title="PDF preview"
      src={url}
      className={`w-full rounded-large-element bg-primary border-2 border-secondary/20 ${
        fill ? "min-h-0 flex-1" : "h-[65vh]"
      }`}
      sandbox="allow-scripts allow-same-origin"
    />
  );
}

PdfViewer.propTypes = {
  driveId: PropTypes.string.isRequired,
  path: PropTypes.string.isRequired,
  fill: PropTypes.bool,
};

/** @param {{ driveId: string, path: string }} props */
export function AudioViewer({ driveId, path }) {
  return (
    <BytesLoader driveId={driveId} path={path} loadingLabel="Opening audio…">
      {({ bytes }) => <AudioPlayer bytes={bytes} path={path} />}
    </BytesLoader>
  );
}

AudioViewer.propTypes = {
  driveId: PropTypes.string.isRequired,
  path: PropTypes.string.isRequired,
};

function AudioPlayer({ bytes, path }) {
  const url = useMemo(() => URL.createObjectURL(new Blob([bytes])), [bytes]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  if (!url) return null;
  return (
    <div className="rounded-large-element bg-primary text-secondary p-4">
      <p className="text-sm mb-3 break-all">{path.split("/").pop()}</p>
      <audio controls className="w-full" src={url}>
        Your browser cannot play this audio. Download it instead.
      </audio>
    </div>
  );
}

AudioPlayer.propTypes = {
  bytes: PropTypes.any.isRequired,
  path: PropTypes.string.isRequired,
};
