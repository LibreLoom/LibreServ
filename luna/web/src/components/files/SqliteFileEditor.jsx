/**
 * Fullscreen editor for a SQLite database file on a drive.
 *
 * Ordinary files are fetched once, edited entirely in a Web Worker, and
 * written back only on an explicit Save. A save compares the file's size and
 * modified time from before the edit, so a database someone else replaced is
 * never overwritten silently.
 *
 * A form's answers sidecar is a SQLite file too. It loads and saves through
 * the form's revisioned endpoints instead, so an editor save cannot overwrite
 * answers that arrived while it was open.
 */

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import { ApiError, apiErrorMessage } from "../../lib/api.js";
import { useFileSource } from "../../lib/fileSource.jsx";
import { joinPath, parentPath, pathBasename } from "../../lib/paths.js";
import EditorLoadingScreen from "./EditorLoadingScreen.jsx";
import { SqliteEditorSession } from "./forms/sqlite/SqliteEditor.jsx";
import { asBytes } from "./forms/sqlite/sqliteModel.js";

const SIDECAR_SUFFIX = ".lunaform.responses.sqlite";

/**
 * The form whose answers live in this sidecar, or null for an ordinary
 * database. `./.rsvp.lunaform.responses.sqlite` → `./rsvp.lunaform`.
 *
 * @param {string} path
 * @returns {string | null}
 */
function formPathForSidecar(path) {
  const base = pathBasename(path);
  if (!base.endsWith(SIDECAR_SUFFIX)) return null;
  const stem = base.slice(0, -SIDECAR_SUFFIX.length);
  if (!stem.startsWith(".") || stem.length < 2) return null;
  return joinPath(parentPath(path) ?? "", `${stem.slice(1)}.lunaform`);
}

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
 *   onRegisterSave: (save: (() => Promise<unknown>) | null, recovery?: { download?: () => Promise<{ blob: Blob, filename?: string } | null> } | null) => void,
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
  const formPath = formPathForSidecar(path);
  const [state, setState] = useState(
    /** @type {{
     *   loading: boolean,
     *   error: string,
     *   bytes: Uint8Array | null,
     *   revision: number | string,
     *   mode: "form" | "file",
     *   formPath: string | null,
     * }} */ ({
      loading: true,
      error: "",
      bytes: null,
      revision: "",
      mode: "file",
      formPath: null,
    }),
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (formPath && typeof source.formSqlite === "function") {
        try {
          const snapshot = await source.formSqlite(driveId, formPath);
          if (cancelled) return;
          setState({
            loading: false,
            error: "",
            bytes: asBytes(snapshot.bytes),
            revision: snapshot.revision,
            mode: "form",
            formPath,
          });
          return;
        } catch (error) {
          // Only a missing form falls back to the raw file. Any other error
          // must surface: silently switching to a raw save would bypass the
          // form's revision check.
          if (!(error instanceof ApiError) || error.status !== 404) {
            throw error;
          }
        }
      }
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
          mode: "file",
          formPath: null,
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
            mode: "file",
            formPath: null,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [driveId, formPath, path, source]);

  /** The revision on the drive right now, or null when stat is unavailable. */
  async function diskRevision() {
    if (typeof source.stat !== "function") return null;
    const stat = await source.stat(driveId, path);
    return revisionOf(stat, null);
  }

  async function save(bytes, loadedRevision) {
    if (state.mode === "form") {
      if (!state.formPath || typeof source.saveFormSqlite !== "function") {
        throw new Error(
          "Open this database from its form to save changes.",
        );
      }
      const revision = Number(loadedRevision);
      if (!Number.isFinite(revision)) {
        throw new Error("Reload the database before saving it.");
      }
      const result = await source.saveFormSqlite(
        driveId,
        state.formPath,
        bytes,
        revision,
      );
      onSaved?.();
      return { revision: result.revision };
    }

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
    if (
      state.mode === "form" &&
      state.formPath &&
      typeof source.formSqlite === "function"
    ) {
      const snapshot = await source.formSqlite(driveId, state.formPath);
      return {
        bytes: asBytes(snapshot.bytes),
        revision: snapshot.revision,
      };
    }
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

  const formMode = state.mode === "form";
  return (
    <SqliteEditorSession
      key={`${driveId}:${path}`}
      canWrite={canWrite}
      initialBytes={state.bytes}
      revision={state.revision}
      onSave={save}
      onReload={reload}
      frame={{ onRegisterSave, onSaveStateChange }}
      conflictTitle={formMode ? "New answers arrived" : "This database changed"}
      conflictMessage={
        formMode
          ? "Someone answered this form after you opened the database. Saving now would replace the newer answers."
          : "Someone changed this file after you opened it. Saving now would replace their changes."
      }
      conflictNoReloadMessage={
        formMode
          ? "Close the editor and open the form again to load the new answers."
          : "Close the editor and open the file again to load the new version."
      }
      oversizedHint={
        formMode
          ? "Open the form's Responses view to read answers page by page."
          : "Download it and open it in a desktop database app."
      }
      formMode={formMode}
      fileName={name}
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
