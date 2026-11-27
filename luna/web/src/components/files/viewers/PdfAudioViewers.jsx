import PropTypes from "prop-types";
import { BytesLoader, useLoadedBytes, useObjectUrl } from "./bytesLoader.jsx";
import { apiErrorMessage } from "../../../lib/api.js";

/**
 * Sandboxed PDF preview via blob URL (never served inline at the Luna
 * origin). `fill` swaps the modal-sized frame for a flex-fill one and the
 * text tokens for a `surface-primary` surface — used by FileViewer's fullscreen
 * fallback when EuroOffice is missing.
 */
export default function PdfViewer({ driveId, path, fill = false }) {
  const result = useLoadedBytes(driveId, path);
  const url = useObjectUrl(result?.bytes, "application/pdf");

  const textTone = fill ? "text-secondary" : "text-primary";
  if (result?.error) {
    return <p className={`${textTone} text-sm`}>{apiErrorMessage(result.error, "Luna couldn't open this PDF. Try downloading it.")}</p>;
  }
  if (!url) return <p className={`${textTone} text-sm`}>Opening PDF…</p>;

  return (
    <iframe
      title="PDF preview"
      src={url}
      className={`w-full rounded-large-element surface-primary border-2 border-secondary/20 ${
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
  const url = useObjectUrl(bytes);
  if (!url) return null;
  return (
    <div className="rounded-large-element surface-primary p-4">
      <p className="text-sm mb-3 break-all">{path.split("/").pop()}</p>
      <audio controls preload="metadata" className="w-full" src={url}>
        Your browser cannot play this audio. Download it instead.
      </audio>
    </div>
  );
}

AudioPlayer.propTypes = {
  bytes: PropTypes.any.isRequired,
  path: PropTypes.string.isRequired,
};
