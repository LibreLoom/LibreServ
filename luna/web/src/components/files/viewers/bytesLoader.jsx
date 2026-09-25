/* eslint-disable react-refresh/only-export-components */
import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { apiErrorMessage } from "../../../lib/api.js";
import { useFileSource } from "../../../lib/fileSource.jsx";

/**
 * Bytes through the active file source (drive API, or a share link for
 * guests). Standalone helper for callers outside a component.
 * @param {object} source
 * @param {string} driveId
 * @param {string} path
 */
export async function fetchDriveBytes(source, driveId, path) {
  return source.fetchBytes(driveId, path);
}

/**
 * @param {object} source
 * @param {string} driveId
 * @param {string} path
 * @param {string} [mime]
 */
export async function fetchDriveBlobUrl(source, driveId, path, mime) {
  const buf = await source.fetchBytes(driveId, path);
  const blob = new Blob([buf], mime ? { type: mime } : undefined);
  return URL.createObjectURL(blob);
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
  const source = useFileSource();
  const [bytes, setBytes] = useState(/** @type {ArrayBuffer|null} */ (null));
  const [error, setError] = useState(/** @type {string|null} */ (null));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setBytes(null);
      setError(null);
      try {
        const buf = await source.fetchBytes(driveId, path);
        if (!cancelled) setBytes(buf);
      } catch (err) {
        if (!cancelled) {
          setError(apiErrorMessage(err, "Luna couldn't open this file. Try downloading it."));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, driveId, path]);

  const textTone = surface === "primary" ? "text-secondary" : "text-primary";
  if (error) return <p className={`${textTone} text-sm`}>{error}</p>;
  if (!bytes) return <p className={`${textTone} text-sm`}>{loadingLabel}</p>;
  return children({ bytes });
}

BytesLoader.propTypes = {
  driveId: PropTypes.string.isRequired,
  path: PropTypes.string.isRequired,
  children: PropTypes.func.isRequired,
  loadingLabel: PropTypes.string,
  surface: PropTypes.oneOf(["secondary", "primary"]),
};
