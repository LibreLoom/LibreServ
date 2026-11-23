/**
 * Fullscreen editor for an ordinary SQLite database file on a drive.
 *
 * The bytes are fetched once, edited entirely in a Web Worker, and written
 * back only on an explicit Save. A save compares the file's size and
 * modified time from before the edit, so a database someone else replaced
 * is never overwritten silently.
 */

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import { ApiError, apiErrorMessage } from "../../lib/api.js";
import { useFileSource } from "../../lib/fileSource.jsx";
import EditorLoadingScreen from "./EditorLoadingScreen.jsx";
import { SqliteEditorSession } from "./forms/sqlite/SqliteEditor.jsx";
import { asBytes } from "./forms/sqlite/sqliteModel.js";

/** @param {any} stat @param {Uint8Array | null} bytes */
function revisionOf(stat, bytes = null) {
  const modified = Number(stat?.modified);
  const size = Number(stat?.size);
  return `${Number.isFinite(modified) ? modified : 0}:${
    Number.isFinite(size) && size >= 0 ? size : (bytes?.byteLength ?? 0)
  }`;
}

/**
 * @param {{
 *   driveId: string,
 *   path: string,
 *   name: string,
 *   canWrite?: boolean,
 *   onSaved?: () => void,
 *   onRegisterSave: (save: (() => Promise<unknown>) | null) => void,
 *   onSaveStateChange: (hasUnsaved: boolean) => void,
 * }} props
 */
export default function SqliteFileEditor({
  driveId,
  path,
  name,
  canWrite = true,
  onSaved,
  onRegisterSave,
  onSaveStateChange,
}) {
  const source = useFileSource();
  const [state, setState] = useState(
    /** @type {{ loading: boolean, error: string, bytes: Uint8Array | null, revision: string }} */ ({
      loading: true,
      error: "",
      bytes: null,
      revision: "",
    }),
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const statPromise =
          typeof source.stat === "function"
            ? source.stat(driveId, path).catch(() => null)
            : Promise.resolve(null);
        const [raw, stat] = await Promise.all([
          source.fetchBytes(driveId, path),
          statPromise,
        ]);
        if (cancelled) return;
        const bytes = asBytes(raw);
        setState({
          loading: false,
          error: "",
          bytes,
          revision: revisionOf(stat, bytes),
        });
      } catch (error) {
        if (!cancelled) {
          setState({
            loading: false,
            error: apiErrorMessage(
              error,
              "Luna couldn't open this database. Try downloading it.",
            ),
            bytes: null,
            revision: "",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [driveId, path, source]);

  /** The revision on the drive right now, or null when stat is unavailable. */
  async function diskRevision() {
    if (typeof source.stat !== "function") return null;
    const stat = await source.stat(driveId, path);
    return revisionOf(stat, null);
  }

  async function save(bytes, loadedRevision) {
    let current = null;
    try {
      current = await diskRevision();
    } catch {
      // A failed stat must not block the save; it only costs the conflict
      // check on this pass.
    }
    if (current != null && loadedRevision && current !== loadedRevision) {
      throw new ApiError(
        409,
        "This database changed on the drive while you were editing. Reload it before saving.",
        "revision_conflict",
      );
    }
    await source.saveFile(
      driveId,
      path,
      name,
      new Blob([bytes], { type: "application/vnd.sqlite3" }),
    );
    let after = null;
    try {
      after = await diskRevision();
    } catch {
      // Keep the revision empty: the next save skips the conflict check
      // rather than comparing against a value the drive has moved past.
    }
    onSaved?.();
    return { revision: after ?? "" };
  }

  async function reload() {
    const statPromise =
      typeof source.stat === "function"
        ? source.stat(driveId, path).catch(() => null)
        : Promise.resolve(null);
    const [raw, stat] = await Promise.all([
      source.fetchBytes(driveId, path),
      statPromise,
    ]);
    const bytes = asBytes(raw);
    return { bytes, revision: revisionOf(stat, bytes) };
  }

  if (state.loading) {
    return <EditorLoadingScreen label={`Opening ${name}`} />;
  }
  if (state.error || !state.bytes) {
    return (
      <div className="p-4 sm:p-6">
        <PageNotice variant="error">
          {state.error || "Luna couldn't open this database."}
        </PageNotice>
      </div>
    );
  }

  return (
    <SqliteEditorSession
      key={`${driveId}:${path}`}
      canWrite={canWrite}
      initialBytes={state.bytes}
      revision={state.revision}
      onSave={save}
      onReload={reload}
      frame={{ onRegisterSave, onSaveStateChange }}
      conflictTitle="This database changed"
      conflictMessage="Someone changed this file after you opened it. Saving now would replace their changes."
      conflictNoReloadMessage="Close the editor and open the file again to load the new version."
      oversizedHint="Download it and open it in a desktop database app."
    />
  );
}

SqliteFileEditor.propTypes = {
  driveId: PropTypes.string.isRequired,
  path: PropTypes.string.isRequired,
  name: PropTypes.string.isRequired,
  canWrite: PropTypes.bool,
  onSaved: PropTypes.func,
  onRegisterSave: PropTypes.func.isRequired,
  onSaveStateChange: PropTypes.func.isRequired,
};
