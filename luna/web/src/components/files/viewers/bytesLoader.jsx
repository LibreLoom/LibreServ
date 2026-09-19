import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { apiErrorMessage, apiFetch } from "../../../lib/api.js";
import { contentHref } from "../../../lib/paths.js";

/**
 * @param {string} driveId
 * @param {string} path
 */
export async function fetchDriveBytes(driveId, path) {
  const res = await apiFetch(contentHref(driveId, path));
  if (!res.ok) throw new Error("Luna couldn't open this file.");
  return res.arrayBuffer();
}

/**
 * @param {string} driveId
 * @param {string} path
 * @param {string} [mime]
 */
export async function fetchDriveBlobUrl(driveId, path, mime) {
  const buf = await fetchDriveBytes(driveId, path);
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
  const [bytes, setBytes] = useState(/** @type {ArrayBuffer|null} */ (null));
  const [error, setError] = useState(/** @type {string|null} */ (null));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setBytes(null);
      setError(null);
      try {
        const buf = await fetchDriveBytes(driveId, path);
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
  }, [driveId, path]);

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
