/* eslint-disable react-refresh/only-export-components */
import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { apiErrorMessage } from "../../../lib/api.js";
import { useFileSource } from "../../../lib/fileSource.jsx";

/** @param {string} driveId @param {string} path */
export function useLoadedBytes(driveId, path) {
  const source = useFileSource();
  const [result, setResult] = useState(/** @type {{
    source: typeof source, driveId: string, path: string, bytes?: ArrayBuffer, error?: unknown
  }|null} */ (null));
  const [scope, setScope] = useState({ source, driveId, path });
  if (scope.source !== source || scope.driveId !== driveId || scope.path !== path) {
    setScope({ source, driveId, path });
    setResult(null);
  }
  useEffect(() => {
    const request = new AbortController();
    source.fetchBytes(driveId, path, request.signal).then(
      (bytes) => {
        if (!request.signal.aborted) setResult({ source, driveId, path, bytes });
      },
      (error) => {
        if (!request.signal.aborted) setResult({ source, driveId, path, error });
      },
    );
    return () => request.abort();
  }, [source, driveId, path]);

  return result?.source === source && result.driveId === driveId && result.path === path ? result : null;
}

/** @param {BlobPart|null|undefined} bytes @param {string} [mime] */
export function useObjectUrl(bytes, mime) {
  const [resource, setResource] = useState(/** @type {{ bytes: BlobPart, mime?: string, url: string }|null} */ (null));
  useEffect(() => {
    if (!bytes) return undefined;
    const url = URL.createObjectURL(new Blob([bytes], mime ? { type: mime } : undefined));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- publish a resource owned by this effect
    setResource({ bytes, mime, url });
    return () => URL.revokeObjectURL(url);
  }, [bytes, mime]);
  return bytes && resource?.bytes === bytes && resource.mime === mime ? resource.url : null;
}

/**
 * Load drive file bytes once, then render children.
 * `surface` names the background the loader sits on — "secondary" inside a
 * modal card (default), "primary" inside FileViewer's fullscreen frame.
 * @param {{
 *   driveId: string,
 *   path: string,
 *   children: (ctx: { bytes: ArrayBuffer }) => import("react").ReactNode,
 *   loadingLabel?: string,
 *   surface?: "secondary" | "primary",
 * }} props
 */
export function BytesLoader({ driveId, path, children, loadingLabel = "Opening…", surface = "secondary" }) {
  const result = useLoadedBytes(driveId, path);

  const textTone = surface === "primary" ? "text-secondary" : "text-primary";
  if (result?.error) {
    return <p className={`${textTone} text-sm`}>{apiErrorMessage(result.error, "Luna couldn't open this file. Try downloading it.")}</p>;
  }
  if (!result?.bytes) return <p className={`${textTone} text-sm`}>{loadingLabel}</p>;
  return children({ bytes: result.bytes });
}

BytesLoader.propTypes = {
  driveId: PropTypes.string.isRequired,
  path: PropTypes.string.isRequired,
  children: PropTypes.func.isRequired,
  loadingLabel: PropTypes.string,
  surface: PropTypes.oneOf(["secondary", "primary"]),
};
