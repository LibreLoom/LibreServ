/**
 * In-browser SQLite editor.
 *
 * All database work happens in a Web Worker through sql.js; the file on Luna
 * is only touched by an explicit Save. Manual grid edits and free-form SQL
 * share one in-memory database, so there is one dirty flag. The same session
 * backs a form's answers database and an ordinary `.sqlite` file.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import {
  ChevronDown,
  ChevronUp,
  Download,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  RefreshCw,
  Table2,
  Trash2,
} from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import Card from "@libreloom/ui/components/cards/Card.jsx";
import CardButton from "@libreloom/ui/components/ui/CardButton.jsx";
import ConfirmModal from "@libreloom/ui/components/cards/ConfirmModal.jsx";
import Dropdown from "@libreloom/ui/components/common/Dropdown.jsx";
import EmptyState from "@libreloom/ui/components/common/EmptyState.jsx";
import InlineError from "@libreloom/ui/components/common/InlineError.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import ModalCard, {
  NESTED_OVERLAY_CLASS,
} from "@libreloom/ui/components/cards/ModalCard.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import Pill from "@libreloom/ui/components/common/Pill.jsx";
import SegmentedControl from "@libreloom/ui/components/common/SegmentedControl.jsx";
import Spinner from "@libreloom/ui/components/ui/Spinner.jsx";
import {
  InfoHint,
  TooltipTargets,
} from "@libreloom/ui/components/ui/Tooltip.jsx";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { downloadBlob } from "../../../../lib/downloadBlob.js";
import { cn } from "@libreloom/ui/lib/utils.js";
import { apiErrorMessage } from "../../../../lib/api.js";
import lazyWithPreload from "../../../../lib/lazyWithPreload.js";
import FullscreenEditorFrame from "../../FullscreenEditorFrame.jsx";
import EditorLoadingScreen, {
  EditorMountedSignal,
} from "../../EditorLoadingScreen.jsx";
import QueryResultTable from "./QueryResultTable.jsx";
import SqliteDataViewStack from "./SqliteDataViewStack.jsx";
import SqliteColumnDialog from "./SqliteColumnDialog.jsx";
import SqliteRenameTableDialog from "./SqliteRenameTableDialog.jsx";
import SqliteTableDialog from "./SqliteTableDialog.jsx";
import SqliteGrid from "./SqliteGrid.jsx";
import { createSqliteClient } from "./sqliteClient.js";
import {
  GRID_PAGE_SIZE,
  MAX_DATABASE_BYTES,
  analyzeScript,
  asBytes,
  coerceCellValue,
  formatBytes,
  formatCount,
  isConflictError,
  rowIdentity,
} from "./sqliteModel.js";
import {
  buildAddColumnSql,
  buildCountQuery,
  buildCreateTableSql,
  buildDeleteRowSql,
  buildDropColumnSql,
  buildDropTableSql,
  buildInsertRowSql,
  buildRenameColumnSql,
  buildRenameTableSql,
  buildRowsQuery,
  buildUpdateCellSql,
  cleanTableName,
  pageOrder,
} from "./sqliteSql.js";

/** @param {any[]} tables */
function completionsFor(tables) {
  /** @type {Record<string, string[]>} */
  const schema = {};
  for (const table of tables) {
    schema[table.name] = table.columns.map(
      (/** @type {any} */ column) => column.name,
    );
  }
  return schema;
}

/** @param {any} table @param {any[]} row */
function keyValuesFor(table, row) {
  return table.primaryKey.map((/** @type {string} */ name) => {
    const index = table.columns.findIndex(
      (/** @type {any} */ column) => column.name === name,
    );
    return index < 0 ? null : row[index];
  });
}

/**
 * Why this row cannot be changed safely from the grid, or "" when it can.
 * A NULL key matches nothing and a 64-bit key beyond 2^53 has already been
 * rounded by sql.js, so either one could update a different row.
 *
 * @param {any} table
 * @param {any[]} row
 */
function keyProblem(table, row) {
  const values = keyValuesFor(table, row);
  if (!values.length) {
    return "This table has no primary key, so its rows can't be changed.";
  }
  for (const value of values) {
    if (value == null) {
      return "This row's key is empty, so it can't be changed here. Use SQL.";
    }
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
      return "This row's key is too large to edit safely. Use SQL to change it.";
    }
  }
  return "";
}

// Autosave mirrors the text/form editors: fire once editing pauses, never
// let unsaved work age past the maximum during continuous changes, and back
// off after a failed save.
const AUTOSAVE_IDLE_MS = 2_000;
const AUTOSAVE_MAX_MS = 15_000;
const AUTOSAVE_RETRY_MS = 5_000;
const AUTOSAVE_TICK_MS = 250;

/** What the run shortcut is called on this machine. */
const RUN_SHORTCUT =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)
    ? "⌘Enter"
    : "Ctrl+Enter";

const SqlEditor = lazyWithPreload(() => import("./SqlEditor.jsx"));

const EMPTY_GRID = {
  rows: [],
  total: 0,
  page: 1,
  loading: false,
  error: "",
  ms: 0,
  truncated: false,
};

/**
 * @param {{
 *   name: string,
 *   sessionKey: string,
 *   canWrite?: boolean,
 *   initialBytes: Uint8Array,
 *   revision: number,
 *   onSave: (bytes: Uint8Array, revision: number) => Promise<{ revision: number }>,
 *   onClose: () => void,
 *   onReload?: () => Promise<{ bytes: Uint8Array, revision: number }>,
 *   formMode?: boolean,
 * }} props
 */
export default function SqliteEditor({
  name,
  sessionKey,
  canWrite = true,
  initialBytes,
  revision,
  onSave,
  onClose,
  onReload = null,
  formMode = false,
}) {
  const oversized = asBytes(initialBytes).byteLength > MAX_DATABASE_BYTES;
  return (
    <FullscreenEditorFrame
      name={name}
      sessionKey={sessionKey}
      canWrite={canWrite && !oversized}
      editorKind="sqlite"
      onClose={onClose}
    >
      {(frame) => (
        <SqliteEditorSession
          key={sessionKey}
          canWrite={canWrite}
          initialBytes={initialBytes}
          revision={revision}
          onSave={onSave}
          onReload={onReload}
          frame={frame}
          formMode={formMode}
          fileName={name}
        />
      )}
    </FullscreenEditorFrame>
  );
}

SqliteEditor.propTypes = {
  name: PropTypes.string.isRequired,
  sessionKey: PropTypes.string.isRequired,
  canWrite: PropTypes.bool,
  initialBytes: PropTypes.instanceOf(Uint8Array).isRequired,
  revision: PropTypes.number.isRequired,
  onSave: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
  onReload: PropTypes.func,
  formMode: PropTypes.bool,
};

/**
 * @param {{
 *   canWrite: boolean,
 *   initialBytes: Uint8Array,
 *   revision: number | string,
 *   onSave: (
 *     bytes: Uint8Array,
 *     revision: number | string,
 *   ) => Promise<{ revision: number | string }>,
 *   onReload:
 *     | (() => Promise<{ bytes: Uint8Array, revision: number | string }>)
 *     | null,
 *   frame: {
 *     onRegisterSave: (save: (() => Promise<unknown>) | null, recovery?: { download?: () => Promise<{ blob: Blob, filename?: string } | null> } | null) => void,
 *     onSaveStateChange: (hasUnsaved: boolean) => void,
 *   },
 *   conflictTitle?: string,
 *   conflictMessage?: string,
 *   conflictNoReloadMessage?: string,
 *   fileName?: string,
 *   oversizedHint?: string,
 *   formMode?: boolean,
 * }} props
 */
export function SqliteEditorSession({
  canWrite,
  initialBytes,
  revision,
  onSave,
  onReload,
  frame,
  conflictTitle = "New answers arrived",
  conflictMessage = "Someone answered this form after you opened the database. Saving now would replace the newer answers.",
  conflictNoReloadMessage = "Close the editor and open the form again to load the new answers.",
  fileName = "database.sqlite",
  oversizedHint = "Use the Responses view to read answers page by page.",
  formMode = false,
}) {
  const { onRegisterSave, onSaveStateChange } = frame;
  const { addToast } = useToast();
  const [sourceBytes] = useState(() => asBytes(initialBytes));
  const tooLarge = sourceBytes.byteLength > MAX_DATABASE_BYTES;

  const [loading, setLoading] = useState(!tooLarge);
  const [loadError, setLoadError] = useState("");
  const [ready, setReady] = useState(false);
  const [tables, setTables] = useState(/** @type {any[]} */ ([]));
  const [selectedTable, setSelectedTable] = useState("");
  const [panel, setPanel] = useState(
    /** @type {"table" | "query"} */ ("table"),
  );
  const [tablesOpen, setTablesOpen] = useState(true);
  const [sqlOpen, setSqlOpen] = useState(false);
  const [sqlUsed, setSqlUsed] = useState(false);
  const collapseTablesRef = useRef(
    /** @type {HTMLButtonElement | null} */ (null),
  );
  const expandTablesRef = useRef(
    /** @type {HTMLButtonElement | null} */ (null),
  );
  const setTablesVisible = useCallback((open) => {
    setTablesOpen(open);
    requestAnimationFrame(() => {
      if (open) collapseTablesRef.current?.focus();
      else expandTablesRef.current?.focus();
    });
  }, []);
  const [grid, setGrid] = useState({ ...EMPTY_GRID });
  const [query, setQuery] = useState(/** @type {any|null} */ (null));
  const [sqlError, setSqlError] = useState("");
  const [hasSql, setHasSql] = useState(false);
  const [gridError, setGridError] = useState("");
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [working, setWorking] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [conflictError, setConflictError] = useState("");
  const [reloading, setReloading] = useState(false);
  const [columnDialog, setColumnDialog] = useState(
    /** @type {{ mode: "add"|"rename", column: any|null } | null} */ (null),
  );
  const [tableDialogOpen, setTableDialogOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState(
    /** @type {any | null} */ (null),
  );
  const [deleteTableTarget, setDeleteTableTarget] = useState(
    /** @type {any | null} */ (null),
  );
  const [deleteTableBusy, setDeleteTableBusy] = useState(false);
  const [deleteTableError, setDeleteTableError] = useState("");
  const [dropTarget, setDropTarget] = useState(
    /** @type {{ table: any, column: any } | null} */ (null),
  );
  const [dropBusy, setDropBusy] = useState(false);
  const [dropError, setDropError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(
    /** @type {{ table: any, row: any[] } | null} */ (null),
  );
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const clientRef = useRef(/** @type {any} */ (null));
  const mountedRef = useRef(true);
  const revisionRef = useRef(revision);
  const dirtyRef = useRef(false);
  const mutationVersionRef = useRef(0);
  const savingRef = useRef(false);
  const lastEditRef = useRef(0);
  const dirtySinceRef = useRef(0);
  const lastSaveAttemptRef = useRef(0);
  const autoSavePausedRef = useRef(false);
  const workingRef = useRef(false);
  const runningRef = useRef(false);
  const reloadingRef = useRef(false);
  const sqlRef = useRef(/** @type {import("@codemirror/state").Text | null} */ (null));
  const countCache = useRef(/** @type {WeakMap<object, Map<string, { version: number, total: number }>>} */ (new WeakMap()));
  const updateSql = useCallback((/** @type {import("@codemirror/state").Text} */ doc) => {
    sqlRef.current = doc;
    const lines = doc.iterLines();
    let hasInput = false;
    for (let line = lines.next(); !line.done; line = lines.next()) {
      if (!/\S/.test(line.value)) continue;
      hasInput = true;
      break;
    }
    setHasSql(hasInput);
  }, []);
  const gridRef = useRef(grid);
  const tablesRef = useRef(tables);
  const selectedTableRef = useRef(selectedTable);
  const pageRef = useRef(grid.page);
  const gridTokenRef = useRef(0);
  const keepFocusRef = useRef(/** @type {HTMLButtonElement|null} */ (null));

  gridRef.current = grid;
  tablesRef.current = tables;
  selectedTableRef.current = selectedTable;
  pageRef.current = grid.page;
  workingRef.current = working;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const selected =
    tables.find((table) => table.name === selectedTable) || null;
  const hasEditableColumn = Boolean(
    selected?.columns?.some(
      (column) =>
        column.pk === 0 &&
        !column.generated &&
        !column.hidden &&
        !/BLOB/i.test(column.type || ""),
    ),
  );
  const schemaCompletions = useMemo(() => completionsFor(tables), [tables]);
  const pageCount = Math.max(1, Math.ceil(grid.total / GRID_PAGE_SIZE));
  const busy = saving || working || running;

  const markDirty = useCallback(() => {
    // Count every mutation, even while already dirty: a save that started
    // before this change must not report the newer state as saved.
    mutationVersionRef.current += 1;
    const now = Date.now();
    lastEditRef.current = now;
    if (!dirtySinceRef.current) dirtySinceRef.current = now;
    if (dirtyRef.current) return;
    dirtyRef.current = true;
    setDirty(true);
    onSaveStateChange(true);
  }, [onSaveStateChange]);

  /** Change the selected table synchronously for in-flight loads. */
  const selectTable = useCallback((name) => {
    selectedTableRef.current = name;
    setSelectedTable(name);
  }, []);

  const markSaved = useCallback(() => {
    dirtyRef.current = false;
    dirtySinceRef.current = 0;
    lastEditRef.current = 0;
    autoSavePausedRef.current = false;
    setDirty(false);
    onSaveStateChange(false);
  }, [onSaveStateChange]);

  const loadTable = useCallback(
    async (table, page, client = clientRef.current) => {
      if (!client || !table) return;
      const token = (gridTokenRef.current += 1);
      setGrid((current) => ({ ...current, loading: true, error: "" }));
      const started = performance.now();
      try {
        const rowsQuery = buildRowsQuery({
          table: table.name,
          orderBy: pageOrder(table),
          limit: GRID_PAGE_SIZE,
          offset: Math.max(0, (page - 1) * GRID_PAGE_SIZE),
        });
        const version = mutationVersionRef.current;
        let counts = countCache.current.get(client);
        if (!counts) {
          counts = new Map();
          countCache.current.set(client, counts);
        }
        const previous = counts.get(table.name);
        const count = previous?.version === version
          ? Promise.resolve(previous.total)
          : client.exec(buildCountQuery(table.name).sql).then((result) => Number(result.rows?.[0]?.[0] ?? 0));
        const [rowsResult, total] = await Promise.all([client.exec(rowsQuery.sql, rowsQuery.params), count]);
        if (token !== gridTokenRef.current) return;
        if (selectedTableRef.current !== table.name) return;
        if (version === mutationVersionRef.current) counts.set(table.name, { total, version });
        setGrid({
          rows: rowsResult.rows,
          total,
          page,
          loading: false,
          error: "",
          ms: Math.max(1, Math.round(performance.now() - started)),
          truncated: Boolean(rowsResult.truncated),
        });
      } catch (error) {
        if (token !== gridTokenRef.current) return;
        if (selectedTableRef.current !== table.name) return;
        const message = apiErrorMessage(error, "Luna couldn't load this table.");
        setGrid((current) => ({
          ...current,
          rows: [],
          total: 0,
          loading: false,
          error: message,
        }));
        setGridError(message);
      }
    },
    [],
  );

  const refreshSchema = useCallback(async (client = clientRef.current) => {
    if (!client) return [];
    const result = await client.schema();
    setTables(result.tables);
    return result.tables;
  }, []);

  /**
   * Refresh the schema and reload the selected table, clamping the page to
   * the rows that still exist. `targetPage` may be "last" after an insert.
   */
  const reloadTable = useCallback(
    async (tableName, targetPage, client = clientRef.current) => {
      if (!client) return null;
      const nextTables = await refreshSchema(client);
      const table =
        nextTables.find((entry) => entry.name === tableName) ||
        (tableName ? null : nextTables[0] || null);
      if (!table) {
        gridTokenRef.current += 1;
        selectTable("");
        setGrid({ ...EMPTY_GRID });
        return null;
      }
      const lastPage = Math.max(1, Math.ceil(table.rowCount / GRID_PAGE_SIZE));
      const page =
        targetPage === "last"
          ? lastPage
          : Math.min(Math.max(1, Number(targetPage) || 1), lastPage);
      selectTable(table.name);
      await loadTable(table, page, client);
      return table;
    },
    [loadTable, refreshSchema, selectTable],
  );

  const createTable = useCallback(
    async ({ name, columns }) => {
      const client = clientRef.current;
      if (!client) throw new Error("The database is still opening. Try again.");
      const built = buildCreateTableSql({ table: name, columns });
      await client.exec(built.sql);
      markDirty();
      setQuery(null);
      setPanel("table");
      setGridError("");
      addToast({ type: "success", message: "Table created" });
      try {
        await reloadTable(name, 1, client);
      } catch (error) {
        setGridError(
          apiErrorMessage(
            error,
            "The table was added, but the list couldn't refresh. Save, then reload.",
          ),
        );
      }
    },
    [addToast, markDirty, reloadTable],
  );

  const renameTable = useCallback(
    async (nextName) => {
      const client = clientRef.current;
      const target = renameTarget;
      if (!client || !target) throw new Error("Choose a table first.");
      const cleanName = cleanTableName(nextName);
      const built = buildRenameTableSql({
        table: target.name,
        newName: cleanName,
      });
      workingRef.current = true;
      setWorking(true);
      try {
        await client.exec(built.sql);
      } catch (error) {
        workingRef.current = false;
        setWorking(false);
        throw new Error(
          apiErrorMessage(error, "Luna couldn't rename that table."),
        );
      }
      markDirty();
      setQuery(null);
      addToast({ type: "success", message: "Table renamed" });
      try {
        await reloadTable(
          cleanName,
          target.name === selectedTableRef.current ? pageRef.current : 1,
          client,
        );
        setPanel("table");
      } catch (error) {
        setGridError(
          apiErrorMessage(
            error,
            "The table was renamed, but the list didn't refresh. Use Reload table.",
          ),
        );
      } finally {
        workingRef.current = false;
        setWorking(false);
      }
    },
    [addToast, markDirty, reloadTable, renameTarget],
  );

  const confirmDeleteTable = useCallback(async () => {
    const target = deleteTableTarget;
    const client = clientRef.current;
    if (!target || !client || deleteTableBusy) return;
    setDeleteTableBusy(true);
    setDeleteTableError("");
    const wasSelected = target.name === selectedTableRef.current;
    const built = buildDropTableSql({ table: target.name });
    try {
      await client.exec(built.sql);
    } catch (error) {
      setDeleteTableError(
        apiErrorMessage(error, "Luna couldn't delete that table."),
      );
      setDeleteTableBusy(false);
      return;
    }
    markDirty();
    setQuery(null);
    setDeleteTableTarget(null);
    addToast({ type: "success", message: "Table deleted" });
    try {
      await reloadTable(
        wasSelected ? "" : selectedTableRef.current,
        wasSelected ? 1 : pageRef.current,
        client,
      );
      setPanel("table");
    } catch (error) {
      setGridError(
        apiErrorMessage(
          error,
          "The table was deleted, but the list didn't refresh. Use Reload table.",
        ),
      );
    } finally {
      setDeleteTableBusy(false);
    }
  }, [
    addToast,
    deleteTableBusy,
    deleteTableTarget,
    markDirty,
    reloadTable,
  ]);

  const refreshAfterWrite = useCallback(
    async (keepQuery) => {
      try {
        const table = await reloadTable(
          selectedTableRef.current,
          pageRef.current,
        );
        if (!keepQuery) {
          setQuery(null);
          setPanel("table");
        } else if (table) {
          setPanel("query");
        }
      } catch (error) {
        setGridError(
          apiErrorMessage(error, "Luna couldn't refresh this table."),
        );
      }
    },
    [reloadTable],
  );

  // Open once per session. The bytes are copied into state first, so a
  // parent re-render with the same array never reopens the database.
  useEffect(() => {
    if (tooLarge) return undefined;
    let cancelled = false;
    let created = null;
    (async () => {
      try {
        created = createSqliteClient();
        const opened = await created.open(sourceBytes, { readOnly: !canWrite });
        if (cancelled) {
          created.dispose();
          return;
        }
        clientRef.current = created;
        setTables(opened.tables);
        setReady(true);
        setLoading(false);
        const first = opened.tables[0] || null;
        if (first) {
          selectTable(first.name);
          void loadTable(first, 1, created);
        }
      } catch (error) {
        console.error("SQLite editor failed to open the database", error);
        if (!cancelled) {
          const raw = apiErrorMessage(error, "");
          const browserProblem =
            /browser can't run|webassembly|wasm|worker|content security|compile/i.test(
              raw,
            );
          setLoadError(
            browserProblem
              ? "This browser couldn't start the database editor. Try a newer browser or turn off strict site blocking."
              : "Luna couldn't open this database. The file may be damaged.",
          );
          setLoading(false);
        }
        created?.dispose();
      }
    })();
    return () => {
      cancelled = true;
      const client = clientRef.current;
      clientRef.current = null;
      client?.dispose();
    };
  }, [tooLarge, sourceBytes, loadTable, canWrite, selectTable]);

  /** The database as it stands in this editor, ready to download. */
  const downloadMine = useCallback(async () => {
    const client = clientRef.current;
    if (!client) throw new Error("Nothing to download yet.");
    const bytes = await client.exportBytes();
    return {
      blob: new Blob([bytes], { type: "application/vnd.sqlite3" }),
      filename: fileName,
    };
  }, [fileName]);

  const save = useCallback(async () => {
    const client = clientRef.current;
    if (!client || savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    const version = mutationVersionRef.current;
    try {
      const bytes = await client.exportBytes();
      if (bytes.byteLength > MAX_DATABASE_BYTES) {
        throw new Error(
          `This database grew past ${formatBytes(MAX_DATABASE_BYTES)}. Remove data and run VACUUM before saving.`,
        );
      }
      const result = await onSave(bytes, revisionRef.current);
      if (mutationVersionRef.current !== version) {
        throw new Error("A change was made while saving. Save again.");
      }
      if (result && result.revision !== undefined) {
        revisionRef.current = result.revision;
      }
      markSaved();
      return true;
    } catch (error) {
      if (isConflictError(error)) {
        // Autosave must not keep retrying against newer answers.
        autoSavePausedRef.current = true;
        setConflictError("");
        setConflict(true);
        // This editor's own dialog offers the choices; the frame stays quiet.
        if (error && typeof error === "object") error.recoveryHandled = true;
      }
      const raw = String(error?.message || "");
      if (/SQLite is busy or locked|active write transaction/i.test(raw)) {
        throw new Error(
          "Finish the open transaction with COMMIT, or undo it with ROLLBACK, before saving.",
        );
      }
      throw error;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [markSaved, onSave]);

  useEffect(() => {
    if (!canWrite || !ready) return undefined;
    onRegisterSave(save, { download: downloadMine });
    return () => onRegisterSave(null);
  }, [canWrite, ready, save, downloadMine, onRegisterSave]);

  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    if (!canWrite || !ready || tooLarge) return undefined;
    const id = setInterval(() => {
      if (!dirtyRef.current) {
        dirtySinceRef.current = 0;
        return;
      }
      const now = Date.now();
      if (!dirtySinceRef.current) dirtySinceRef.current = now;
      if (
        savingRef.current ||
        workingRef.current ||
        runningRef.current ||
        reloadingRef.current ||
        autoSavePausedRef.current
      ) {
        return;
      }
      if (now - lastSaveAttemptRef.current < AUTOSAVE_RETRY_MS) return;
      const idle = now - lastEditRef.current;
      const stale = now - dirtySinceRef.current;
      if (idle >= AUTOSAVE_IDLE_MS || stale >= AUTOSAVE_MAX_MS) {
        lastSaveAttemptRef.current = now;
        void saveRef.current?.().catch(() => {
          // The frame and conflict modal own the visible error.
        });
      }
    }, AUTOSAVE_TICK_MS);
    return () => clearInterval(id);
  }, [canWrite, ready, tooLarge]);

  // An open cell editor is unsaved work even before its value reaches the
  // worker. Closing the frame must ask instead of discarding what was typed.
  const handleCellEditing = useCallback(
    (active) => {
      onSaveStateChange(active ? true : dirtyRef.current);
    },
    [onSaveStateChange],
  );

  const runSql = useCallback(async () => {
    const client = clientRef.current;
    const sql = sqlRef.current?.toString().trim();
    if (
      !client ||
      !sql ||
      runningRef.current ||
      savingRef.current ||
      workingRef.current
    ) {
      return;
    }
    const analysis = analyzeScript(sql);
    if (!analysis.statements.length) {
      setSqlError("Write a query first.");
      return;
    }
    if (!canWrite && analysis.mutates) {
      setSqlError("This database is open read-only, so it can't run changes.");
      return;
    }

    runningRef.current = true;
    setRunning(true);
    setSqlError("");
    const started = performance.now();
    try {
      const result = await client.exec(sql);
      const ms = Math.max(1, Math.round(performance.now() - started));
      if (result.columns.length > 0) {
        setQuery({ ...result, ms });
        setPanel("query");
      } else {
        setQuery(null);
        setPanel("table");
      }
      if (analysis.mutates || result.changes > 0) {
        markDirty();
        addToast({
          type: "success",
          message: analysis.schema
            ? "Database structure changed"
            : "Query ran",
          description:
            result.changes > 0
              ? `${formatCount(result.changes)} ${
                  result.changes === 1 ? "row" : "rows"
                } changed.`
              : undefined,
        });
        await refreshAfterWrite(result.columns.length > 0);
      }
    } catch (error) {
      setSqlError(apiErrorMessage(error, "The query didn't run."));
      // A multi-statement script can fail part-way. Keep the editor honest:
      // the earlier statements may already have changed this copy.
      if (analysis.mutates) {
        markDirty();
        await refreshAfterWrite(false);
      }
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }, [addToast, canWrite, markDirty, refreshAfterWrite]);

  const changePage = useCallback(
    (nextPage) => {
      const table =
        tablesRef.current.find(
          (entry) => entry.name === selectedTableRef.current,
        ) || null;
      if (!table || nextPage < 1 || busy) return;
      const totalPages = Math.max(
        1,
        Math.ceil(gridRef.current.total / GRID_PAGE_SIZE),
      );
      if (nextPage > totalPages) return;
      void loadTable(table, nextPage);
    },
    [busy, loadTable],
  );

  const updateCell = useCallback(
    async (rowIndex, column, raw) => {
      workingRef.current = true;
      setWorking(true);
      setGridError("");
      try {
        const client = clientRef.current;
        const table =
          tablesRef.current.find(
            (entry) => entry.name === selectedTableRef.current,
          ) || null;
        const row = gridRef.current.rows[rowIndex];
        if (!client || !table || !row) {
          throw new Error(
            "That row is no longer on this page. Reload the table.",
          );
        }
        const keyIssue = keyProblem(table, row);
        if (keyIssue) throw new Error(keyIssue);
        const columnIndex = table.columns.findIndex(
          (entry) => entry.name === column.name,
        );
        if (columnIndex < 0) {
          throw new Error("That column no longer exists.");
        }
        const built = buildUpdateCellSql({
          table: table.name,
          column: column.name,
          primaryKey: table.primaryKey,
          keyValues: keyValuesFor(table, row),
          value: coerceCellValue(raw, column.type),
        });
        const result = await client.exec(built.sql, built.params);
        if (!result.changes) {
          throw new Error(
            "This row changed after it was loaded. Reload the table and try again.",
          );
        }
        markDirty();
        setQuery(null);
        // Reload rather than patching the one cell: defaults, triggers, and
        // generated columns may have changed other cells in the same row.
        // If the person moved to another table while this write ran, that
        // table's own load is authoritative — starting this one would
        // supersede it and leave the grid on "Loading rows…".
        if (selectedTableRef.current === table.name) {
          await loadTable(table, pageRef.current, client);
        }
      } catch (error) {
        setGridError(
          apiErrorMessage(error, "Luna couldn't change that cell."),
        );
        throw error;
      } finally {
        workingRef.current = false;
        setWorking(false);
      }
    },
    [loadTable, markDirty],
  );

  const addRow = useCallback(async () => {
    const client = clientRef.current;
    const table =
      tablesRef.current.find(
        (entry) => entry.name === selectedTableRef.current,
      ) || null;
    if (!client || !table || busy) return;
    workingRef.current = true;
    setWorking(true);
    setGridError("");
    const built = buildInsertRowSql(table.name);
    try {
      await client.exec(built.sql);
    } catch (error) {
      setGridError(apiErrorMessage(error, "Luna couldn't add a row."));
      workingRef.current = false;
      setWorking(false);
      return;
    }
    markDirty();
    setQuery(null);
    addToast({ type: "success", message: "Row added" });
    try {
      await reloadTable(table.name, "last", client);
      setPanel("table");
    } catch (error) {
      setGridError(
        apiErrorMessage(error, "The row was added, but the table didn't reload. Use Reload table."),
      );
    } finally {
      workingRef.current = false;
        setWorking(false);
    }
  }, [addToast, busy, markDirty, reloadTable]);

  const confirmDeleteRow = useCallback(async () => {
    const target = deleteTarget;
    const client = clientRef.current;
    if (!target || !client || deleteBusy) return;
    const { table, row } = target;
    setDeleteBusy(true);
    setDeleteError("");
    try {
      const keyIssue = keyProblem(table, row);
      if (keyIssue) throw new Error(keyIssue);
      const built = buildDeleteRowSql({
        table: table.name,
        primaryKey: table.primaryKey,
        keyValues: keyValuesFor(table, row),
      });
      const result = await client.exec(built.sql, built.params);
      if (!result.changes) {
        throw new Error(
          "That row is already gone. Reload the table to see the current rows.",
        );
      }
    } catch (error) {
      setDeleteError(
        apiErrorMessage(error, "Luna couldn't delete that row."),
      );
      setDeleteBusy(false);
      return;
    }
    markDirty();
    setQuery(null);
    setDeleteTarget(null);
    addToast({ type: "success", message: "Row deleted" });
    try {
      await reloadTable(table.name, pageRef.current, client);
      setPanel("table");
    } catch (error) {
      setGridError(
        apiErrorMessage(error, "The row was deleted, but the table didn't reload. Use Reload table."),
      );
    } finally {
      setDeleteBusy(false);
    }
  }, [addToast, deleteBusy, deleteTarget, markDirty, reloadTable]);

  const submitColumn = useCallback(
    async ({ name: columnName, type }) => {
      const client = clientRef.current;
      const dialog = columnDialog;
      const table =
        tablesRef.current.find(
          (entry) => entry.name === selectedTableRef.current,
        ) || null;
      if (!client || !dialog || !table) {
        throw new Error("Choose a table first.");
      }
      const built =
        dialog.mode === "add"
          ? buildAddColumnSql({
              table: table.name,
              column: columnName,
              type,
            })
          : buildRenameColumnSql({
              table: table.name,
              column: dialog.column.name,
              newName: columnName,
            });

      workingRef.current = true;
      setWorking(true);
      try {
        await client.exec(built.sql);
      } catch (error) {
        workingRef.current = false;
        setWorking(false);
        throw new Error(
          apiErrorMessage(error, "Luna couldn't change that column."),
        );
      }
      markDirty();
      setQuery(null);
      addToast({
        type: "success",
        message: dialog.mode === "add" ? "Column added" : "Column renamed",
      });
      try {
        await reloadTable(table.name, pageRef.current, client);
        setPanel("table");
      } catch (error) {
        setGridError(
          apiErrorMessage(
            error,
            "The column changed, but the table didn't reload. Use Reload table.",
          ),
        );
      } finally {
        workingRef.current = false;
        setWorking(false);
      }
    },
    [addToast, columnDialog, markDirty, reloadTable],
  );

  const confirmDropColumn = useCallback(async () => {
    const target = dropTarget;
    const client = clientRef.current;
    if (!target || !client || dropBusy) return;
    setDropBusy(true);
    setDropError("");
    const built = buildDropColumnSql({
      table: target.table.name,
      column: target.column.name,
    });
    try {
      await client.exec(built.sql);
    } catch (error) {
      setDropError(
        apiErrorMessage(error, "Luna couldn't remove that column."),
      );
      setDropBusy(false);
      return;
    }
    markDirty();
    setQuery(null);
    setDropTarget(null);
    addToast({ type: "success", message: "Column removed" });
    try {
      await reloadTable(target.table.name, pageRef.current, client);
      setPanel("table");
    } catch (error) {
      setGridError(
        apiErrorMessage(error, "The column was removed, but the table didn't reload. Use Reload table."),
      );
    } finally {
      setDropBusy(false);
    }
  }, [addToast, dropBusy, dropTarget, markDirty, reloadTable]);

  const keepEditing = useCallback(() => {
    if (reloading) return;
    setConflict(false);
    setConflictError("");
  }, [reloading]);

  const [conflictBusy, setConflictBusy] = useState(false);

  const downloadFromConflict = useCallback(async () => {
    if (conflictBusy) return;
    setConflictBusy(true);
    setConflictError("");
    try {
      const mine = await downloadMine();
      downloadBlob(mine.blob, mine.filename);
      addToast({ type: "success", message: "Downloaded your version." });
    } catch (error) {
      setConflictError(
        apiErrorMessage(error, "Couldn't prepare your version. Keep editing and try again."),
      );
    } finally {
      setConflictBusy(false);
    }
  }, [addToast, conflictBusy, downloadMine]);

  /** Save anyway: adopt the revision on the drive, then write this copy over it. */
  const overwriteTheirs = useCallback(async () => {
    if (!onReload || conflictBusy || reloadingRef.current) return;
    setConflictBusy(true);
    setConflictError("");
    try {
      const latest = await onReload();
      if (latest?.revision !== undefined) revisionRef.current = latest.revision;
      autoSavePausedRef.current = false;
      await saveRef.current?.();
      setConflict(false);
      addToast({ type: "success", message: "Saved over the newer version." });
    } catch (error) {
      autoSavePausedRef.current = true;
      setConflictError(
        apiErrorMessage(error, "Couldn't save over the newer version. Try again."),
      );
    } finally {
      setConflictBusy(false);
    }
  }, [addToast, conflictBusy, onReload]);

  const reloadFromLuna = useCallback(async () => {
    if (!onReload || reloadingRef.current) return;
    reloadingRef.current = true;
    setReloading(true);
    setConflictError("");
    let created = null;
    try {
      const next = await onReload();
      if (!next || !next.bytes) {
        throw new Error(
          "Luna didn't return the newer file. Close the editor and open it again.",
        );
      }
      const nextBytes = asBytes(next.bytes);
      if (nextBytes.byteLength > MAX_DATABASE_BYTES) {
        throw new Error(
          "The newer file is too large to edit here. Use the Responses view.",
        );
      }
      created = createSqliteClient();
      const opened = await created.open(nextBytes, { readOnly: !canWrite });
      if (!mountedRef.current) {
        created.dispose();
        return;
      }
      const previous = clientRef.current;
      clientRef.current = created;
      revisionRef.current =
        next.revision !== undefined ? next.revision : revisionRef.current;
      setTables(opened.tables);
      setReady(true);
      setQuery(null);
      setPanel("table");
      setSqlError("");
      setGridError("");
      setGrid({ ...EMPTY_GRID });
      markSaved();
      const first =
        opened.tables.find(
          (table) => table.name === selectedTableRef.current,
        ) ||
        opened.tables[0] ||
        null;
      setConflict(false);
      setConflictError("");
      if (first) {
        selectTable(first.name);
        void loadTable(first, 1, created);
      } else {
        selectTable("");
      }
      previous?.dispose();
      addToast({ type: "success", message: "Reloaded from Luna" });
    } catch (error) {
      created?.dispose();
      setConflictError(
        apiErrorMessage(error, "Luna couldn't reload this database. Try again."),
      );
    } finally {
      reloadingRef.current = false;
      setReloading(false);
    }
  }, [addToast, canWrite, loadTable, markSaved, onReload, selectTable]);

  const statusText = running
    ? "Running query…"
    : panel === "query" && query
      ? query.truncated
        ? query.rows.length
          ? `${formatCount(query.rows.length)} rows shown · more not shown · ${query.ms} ms`
          : `Result too large to show · ${query.ms} ms`
        : `${formatCount(query.rowCount)} ${
            query.rowCount === 1 ? "row" : "rows"
          } · ${query.ms} ms`
      : selected
        ? `${formatCount(grid.total)} ${
            grid.total === 1 ? "row" : "rows"
          } · page ${grid.page} of ${pageCount}${
            grid.truncated
              ? grid.rows.length
                ? ` · first ${formatCount(grid.rows.length)} shown`
                : " · too large to show"
              : ""
          }${grid.ms ? ` · ${grid.ms} ms` : ""}`
        : `${formatCount(tables.length)} ${
            tables.length === 1 ? "table" : "tables"
          }`;

  if (tooLarge) {
    return (
      <>
        <EditorMountedSignal />
        <div className="flex h-full items-center justify-center p-4 sm:p-6">
          <PageNotice variant="warning" className="max-w-xl">
            <p className="font-mono text-sm">Too large to edit here</p>
            <p className="mt-2 text-sm">
              This database is larger than the editor's{" "}
              {formatBytes(MAX_DATABASE_BYTES)} limit. {oversizedHint}
            </p>
          </PageNotice>
        </div>
      </>
    );
  }

  if (loading) {
    return (
      <>
        <EditorMountedSignal />
        <EditorLoadingScreen label="Opening database" />
      </>
    );
  }

  if (loadError) {
    return (
      <>
        <EditorMountedSignal />
        <div className="p-4 sm:p-6">
          <PageNotice variant="error">{loadError}</PageNotice>
        </div>
      </>
    );
  }

  return (
    <>
      <EditorMountedSignal />
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <aside
            className={cn(
              "relative flex shrink-0 flex-col border-b border-secondary/15 p-2 md:border-b-0 md:border-r md:overflow-hidden md:p-0",
              "motion-safe:transition-[width] motion-safe:duration-[var(--motion-duration-short4)] motion-safe:ease-[var(--motion-easing-emphasized-decelerate)]",
              tablesOpen ? "md:w-60" : "md:w-16",
            )}
          >
            <div
              id="sqlite-tables"
              aria-hidden={tablesOpen ? undefined : true}
              inert={tablesOpen ? undefined : true}
              className={cn(
                "flex min-h-0 flex-1 flex-col motion-safe:transition-opacity motion-safe:duration-[var(--motion-duration-short3)]",
                tablesOpen
                  ? "opacity-100"
                  : "pointer-events-none opacity-0 max-md:hidden",
              )}
            >
              <Card
                as="nav"
                noHeightAnim
                noPopIn
                padding={false}
                aria-label="Tables"
                className="flex min-h-0 flex-col gap-2 p-2 md:m-2 md:min-w-[14rem] md:flex-1"
              >
                <div className="flex items-center justify-between px-2 pt-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <Table2
                      size={ICON_SIZE.sm}
                      className="shrink-0"
                      aria-hidden="true"
                    />
                    <h2 className="font-mono text-xs text-primary">Tables</h2>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Pill className="px-2 py-0.5 text-[11px] tabular-nums text-primary">
                      {formatCount(tables.length)}
                    </Pill>
                    {canWrite ? (
                      <Button
                        variant="ghost"
                        surface="secondary"
                        size="iconSm"
                        smoothResize={false}
                        haptic="light"
                        type="button"
                        aria-label="New table"
                        tooltip="New table"
                        onClick={() => setTableDialogOpen(true)}
                      >
                        <Plus size={ICON_SIZE.sm} aria-hidden="true" />
                      </Button>
                    ) : null}
                    <Button
                      ref={collapseTablesRef}
                      variant="ghost"
                      surface="secondary"
                      size="iconSm"
                      smoothResize={false}
                      haptic="light"
                      type="button"
                      aria-label="Hide tables"
                      aria-controls="sqlite-tables"
                      aria-expanded
                      tooltip="Hide tables"
                      onClick={() => setTablesVisible(false)}
                    >
                      <PanelLeftClose
                        size={ICON_SIZE.sm}
                        className="hidden md:block"
                        aria-hidden="true"
                      />
                      <ChevronUp
                        size={ICON_SIZE.sm}
                        className="md:hidden"
                        aria-hidden="true"
                      />
                    </Button>
                  </div>
                </div>
                {tables.length > 0 ? (
                  <ul className="flex scroll-p-1 flex-col gap-1 p-2 md:min-h-0 md:flex-1 md:overflow-y-auto">
                    {tables.map((table) => {
                      const active = table.name === selectedTable;
                      return (
                        <li
                          key={table.name}
                          className="flex min-w-0 items-center gap-1"
                        >
                          <CardButton
                            variant="nav"
                            active={active}
                            align="between"
                            actionLabel={`${table.name}, ${table.columns.length} ${
                              table.columns.length === 1 ? "column" : "columns"
                            }`}
                            ariaCurrent={active ? "page" : undefined}
                            className="min-w-0 flex-1 gap-2 px-3 py-2"
                            trailing={
                              <span className="shrink-0 text-xs tabular-nums">
                                {table.columns.length}
                              </span>
                            }
                            onClick={() => {
                              if (active) {
                                setPanel("table");
                                return;
                              }
                              selectTable(table.name);
                              setPanel("table");
                              setGridError("");
                              setGrid({ ...EMPTY_GRID, loading: true });
                              void loadTable(table, 1);
                            }}
                          >
                            <span className="min-w-0 truncate font-mono text-xs font-normal">
                              {table.name}
                            </span>
                          </CardButton>
                          {canWrite ? (
                            <Dropdown
                              options={[
                                {
                                  value: "rename",
                                  label: "Rename table",
                                  icon: Pencil,
                                },
                                {
                                  value: "delete",
                                  label: "Delete table",
                                  icon: Trash2,
                                },
                              ]}
                              value=""
                              onChange={(action) => {
                                if (action === "rename") {
                                  setRenameTarget(table);
                                } else if (action === "delete") {
                                  setDeleteTableTarget(table);
                                }
                              }}
                              menu
                              menuLabel={`${table.name} table actions`}
                              icon={MoreHorizontal}
                              bg="secondary"
                              ghost
                              align="end"
                              aria-label={`Actions for table ${table.name}`}
                            />
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </Card>
            </div>
            {!tablesOpen ? (
              <div className="flex items-center md:absolute md:inset-x-0 md:top-0 md:flex-col md:gap-2 md:justify-center md:p-3">
                <Button
                  ref={expandTablesRef}
                  variant="ghost"
                  surface="primary"
                  size="sm"
                  smoothResize={false}
                  haptic="light"
                  type="button"
                  className="justify-start gap-2 md:h-10 md:w-10 md:justify-center md:p-2"
                  aria-label="Show tables"
                  aria-controls="sqlite-tables"
                  aria-expanded={false}
                  tooltip="Show tables"
                  onClick={() => setTablesVisible(true)}
                >
                  <Table2
                    size={ICON_SIZE.sm}
                    className="md:hidden"
                    aria-hidden="true"
                  />
                  <span className="md:hidden">Tables</span>
                  <ChevronDown
                    size={ICON_SIZE.sm}
                    className="md:hidden"
                    aria-hidden="true"
                  />
                  <PanelLeftOpen
                    size={ICON_SIZE.sm}
                    className="hidden md:block"
                    aria-hidden="true"
                  />
                </Button>
                <span className="hidden font-mono text-sm text-secondary md:block [writing-mode:vertical-rl]">
                  Tables
                </span>
              </div>
            ) : null}
          </aside>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <section
              aria-label="SQL editor"
              className={cn(
                "flex shrink-0 flex-col overflow-hidden border-b border-secondary/15",
                "motion-safe:transition-[height] motion-safe:duration-[var(--motion-duration-short4)] motion-safe:ease-[var(--motion-easing-emphasized-decelerate)]",
                sqlOpen ? "h-56 md:h-60" : "h-11",
              )}
            >
              <div className="flex h-11 shrink-0 items-center gap-2 px-4">
                <h2 className="font-mono text-xs text-secondary">SQL</h2>
                {!canWrite ? <Pill variant="muted">Read-only</Pill> : null}
                <InfoHint
                  surface="primary"
                  content={
                    canWrite
                      ? "SQL is the language for reading and changing a database. Type it below, then press Run."
                      : "SQL is the language for reading and changing a database. This file is read-only, so changes can't be saved."
                  }
                  label="About SQL"
                />
                <span className="min-w-0 flex-1" />
                {sqlOpen ? (
                  <>
                    <span className="hidden text-xs text-secondary sm:inline">
                      {RUN_SHORTCUT}
                    </span>
                    <Button
                      variant="secondary"
                      surface="primary"
                      size="sm"
                      smoothResize={false}
                      loading={running}
                      disabled={running || saving || working || !hasSql}
                      onClick={() => void runSql()}
                    >
                      Run
                    </Button>
                  </>
                ) : null}
                <Button
                  variant="ghost"
                  surface="primary"
                  size="iconSm"
                  smoothResize={false}
                  haptic="light"
                  type="button"
                  aria-label={sqlOpen ? "Hide SQL editor" : "Show SQL editor"}
                  aria-controls="sqlite-sql-editor-body"
                  aria-expanded={sqlOpen}
                  tooltip={sqlOpen ? "Hide SQL editor" : "Show SQL editor"}
                  onClick={() => {
                    setSqlUsed(true);
                    setSqlOpen((open) => !open);
                  }}
                >
                  {sqlOpen ? (
                    <ChevronUp size={ICON_SIZE.sm} aria-hidden="true" />
                  ) : (
                    <ChevronDown size={ICON_SIZE.sm} aria-hidden="true" />
                  )}
                </Button>
              </div>
              <div
                id="sqlite-sql-editor-body"
                aria-hidden={sqlOpen ? undefined : true}
                inert={sqlOpen ? undefined : true}
                className="flex min-h-0 flex-1 flex-col"
              >
                <div className="min-h-0 flex-1 overflow-hidden border-t border-secondary/15">
                  {sqlUsed && (
                    <Suspense fallback={<div className="grid h-full place-items-center"><Spinner /></div>}>
                      <SqlEditor
                        schema={schemaCompletions}
                        onChange={updateSql}
                        onRun={() => void runSql()}
                      />
                    </Suspense>
                  )}
                </div>
                {sqlError ? (
                  <div className="border-t border-secondary/15 px-4 py-2">
                    <InlineError surface="primary">{sqlError}</InlineError>
                  </div>
                ) : null}
              </div>
            </section>

            <section
              aria-label="Table data"
              className="flex min-h-0 flex-1 flex-col"
            >
              <TooltipTargets className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 px-4 py-2">
                {panel === "query" && query ? (
                  <h2
                    key="query-title"
                    className="min-w-0 animate-[fade-in_var(--motion-duration-medium1)_var(--motion-easing-standard)_both] truncate font-mono text-sm text-secondary motion-reduce:animate-none"
                  >
                    Query result
                  </h2>
                ) : selected ? (
                  <h2
                    key="table-title"
                    data-tooltip={selected.name}
                    className="min-w-0 animate-[fade-in_var(--motion-duration-medium1)_var(--motion-easing-standard)_both] truncate font-mono text-sm text-secondary motion-reduce:animate-none"
                  >
                    {selected.name}
                  </h2>
                ) : (
                  <h2 className="font-mono text-sm text-secondary">Data</h2>
                )}

                {panel === "table" &&
                selected &&
                canWrite &&
                selected.primaryKey.length > 0 &&
                hasEditableColumn ? (
                  <InfoHint
                    surface="primary"
                    content="Double-click a cell to edit it. Cells in the primary key can't be changed here."
                    label="About editing cells"
                  />
                ) : null}

                <span className="min-w-0 flex-1" />
                {panel === "table" && selected ? (
                  <>
                    <Button
                      variant="ghost"
                      surface="primary"
                      size="iconSm"
                      smoothResize={false}
                      haptic="light"
                      disabled={busy || grid.loading}
                      aria-label="Reload table"
                      tooltip="Reload table"
                      onClick={() => void loadTable(selected, grid.page)}
                    >
                      <RefreshCw size={ICON_SIZE.sm} aria-hidden="true" />
                    </Button>
                  </>
                ) : null}
                {query && selected ? (
                  <SegmentedControl
                    className="ml-1"
                    options={[
                      { value: "table", label: "Table" },
                      { value: "query", label: "Result" },
                    ]}
                    value={panel}
                    onChange={(value) =>
                      setPanel(value === "query" ? "query" : "table")
                    }
                    surface="primary"
                    aria-label="Data view"
                  />
                ) : null}
              </TooltipTargets>

              <SqliteDataViewStack
                view={panel}
                hasResult={Boolean(query)}
                result={query ? <QueryResultTable result={query} /> : null}
                table={
                  !selected ? (
                    <div className="flex min-h-0 flex-1 items-center justify-center">
                      <EmptyState
                        icon={Table2}
                        title={
                          tables.length === 0 ? "No tables yet" : "Choose a table"
                        }
                        description={
                          tables.length === 0
                            ? "Use the plus button beside Tables to add one."
                            : "Pick a table to see its rows."
                        }
                      />
                    </div>
                  ) : (
                    <div className="flex min-h-0 flex-1 flex-col gap-2">
                      {selected.primaryKey.length === 0 ? (
                        <PageNotice variant="info" className="shrink-0">
                          This table has no primary key, so existing rows
                          can't be changed here.
                        </PageNotice>
                      ) : null}
                      {gridError ? (
                        <PageNotice variant="error" className="shrink-0">
                          {gridError}
                        </PageNotice>
                      ) : null}
                      {grid.truncated ? (
                        <PageNotice variant="info" className="shrink-0">
                          {grid.rows.length > 0
                            ? "Some rows are too large to show here. Use SQL to select fewer columns."
                            : "This page is too large to show here. Use SQL to select fewer columns."}
                        </PageNotice>
                      ) : null}
                      {grid.loading && grid.rows.length === 0 ? (
                        <div
                          className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-secondary"
                          role="status"
                        >
                          <Spinner size="md" decorative />
                          Loading rows…
                        </div>
                      ) : (
                        <SqliteGrid
                          truncated={grid.truncated}
                          table={selected}
                          rows={grid.rows}
                          total={grid.total}
                          page={grid.page}
                          canWrite={canWrite}
                          busy={busy || grid.loading}
                          loading={grid.loading}
                          onPageChange={changePage}
                          onUpdateCell={updateCell}
                          onRenameColumn={(column) =>
                            setColumnDialog({ mode: "rename", column })
                          }
                          onDropColumn={(column) =>
                            setDropTarget({ table: selected, column })
                          }
                          onDeleteRow={(row) =>
                            setDeleteTarget({ table: selected, row })
                          }
                          onAddRow={() => void addRow()}
                          onAddColumn={() =>
                            setColumnDialog({ mode: "add", column: null })
                          }
                          onEditingChange={handleCellEditing}
                        />
                      )}
                    </div>
                  )
                }
              />
            </section>
          </div>
        </div>

        <footer className="flex h-9 shrink-0 items-center justify-between gap-3 border-t border-secondary/15 px-4 text-xs text-secondary">
          <span
            aria-live="polite"
            className="min-w-0 truncate font-mono text-[11px] tabular-nums"
          >
            {statusText}
          </span>
          <span className="flex shrink-0 items-center gap-2 tabular-nums">
            {running || working || saving || grid.loading ? (
              <Spinner size="sm" decorative />
            ) : null}
            {canWrite ? (
              <span>{dirty ? "Unsaved changes" : "No changes"}</span>
            ) : (
              <span>Read-only</span>
            )}
          </span>
        </footer>
      </div>

      <SqliteTableDialog
        open={tableDialogOpen}
        onClose={() => setTableDialogOpen(false)}
        onSubmit={createTable}
      />

      <SqliteRenameTableDialog
        open={Boolean(renameTarget)}
        tableName={renameTarget?.name || ""}
        existingNames={tables.map((table) => table.name)}
        formMode={formMode}
        onSubmit={renameTable}
        onClose={() => setRenameTarget(null)}
      />

      <SqliteColumnDialog
        open={Boolean(columnDialog)}
        mode={columnDialog?.mode || "add"}
        tableName={selected?.name || ""}
        column={columnDialog?.column || null}
        existingNames={selected?.columns.map((column) => column.name) || []}
        formMode={formMode}
        onSubmit={submitColumn}
        onClose={() => setColumnDialog(null)}
      />

      <ConfirmModal
        open={Boolean(deleteTableTarget)}
        onClose={() => {
          if (deleteTableBusy) return;
          setDeleteTableTarget(null);
          setDeleteTableError("");
        }}
        title="Delete table"
        variant="danger"
        confirmLabel="Delete table"
        loading={deleteTableBusy}
        error={deleteTableError || null}
        overlayClassName={NESTED_OVERLAY_CLASS}
        onConfirm={() => void confirmDeleteTable()}
      >
        <p className="text-sm text-primary">
          Delete <InlinePill>{deleteTableTarget?.name}</InlinePill>? Every row
          in it is removed.
        </p>
      </ConfirmModal>

      <ConfirmModal
        open={Boolean(dropTarget)}
        onClose={() => {
          if (dropBusy) return;
          setDropTarget(null);
          setDropError("");
        }}
        title="Remove column"
        variant="danger"
        confirmLabel="Remove column"
        loading={dropBusy}
        error={dropError || null}
        overlayClassName={NESTED_OVERLAY_CLASS}
        onConfirm={() => void confirmDropColumn()}
      >
        <p className="text-sm text-primary">
          Remove <InlinePill>{dropTarget?.column?.name}</InlinePill> from{" "}
          <InlinePill>{dropTarget?.table?.name}</InlinePill>? Values in this
          column are lost.
        </p>
      </ConfirmModal>

      <ConfirmModal
        open={Boolean(deleteTarget)}
        onClose={() => {
          if (deleteBusy) return;
          setDeleteTarget(null);
          setDeleteError("");
        }}
        title="Delete row"
        variant="danger"
        confirmLabel="Delete row"
        loading={deleteBusy}
        error={deleteError || null}
        overlayClassName={NESTED_OVERLAY_CLASS}
        onConfirm={() => void confirmDeleteRow()}
      >
        <p className="text-sm text-primary">
          Delete the row where{" "}
          <InlinePill>
            {deleteTarget
              ? rowIdentity(deleteTarget.table, deleteTarget.row)
              : ""}
          </InlinePill>{" "}
          from <InlinePill>{deleteTarget?.table?.name}</InlinePill>?
        </p>
      </ConfirmModal>

      <ModalCard
        open={conflict}
        onClose={keepEditing}
        title={conflictTitle}
        showCloseButton={false}
        overlayClassName={NESTED_OVERLAY_CLASS}
        initialFocusRef={keepFocusRef}
        openHaptic={false}
      >
        <div className="space-y-4">
          <p className="text-sm text-primary">{conflictMessage}</p>
          {onReload ? (
            <p className="text-sm text-primary">
              Reloading discards the changes you made here.
            </p>
          ) : (
            <p className="text-sm text-primary">{conflictNoReloadMessage}</p>
          )}
          {conflictError ? <InlineError>{conflictError}</InlineError> : null}
          <div className="flex flex-col gap-3">
            <Button
              ref={keepFocusRef}
              variant="outline"
              surface="secondary"
              fullWidth
              haptic={false}
              onClick={keepEditing}
              disabled={reloading || conflictBusy}
            >
              Keep editing
            </Button>
            <Button
              variant="outline"
              surface="secondary"
              fullWidth
              loading={conflictBusy}
              disabled={reloading}
              onClick={() => void downloadFromConflict()}
            >
              <Download size={ICON_SIZE.sm} aria-hidden="true" />
              Download my version
            </Button>
            {onReload && !formMode ? (
              <Button
                variant="outline"
                surface="secondary"
                fullWidth
                disabled={reloading || conflictBusy}
                onClick={() => void overwriteTheirs()}
              >
                Save over their changes
              </Button>
            ) : null}
            {onReload ? (
              <Button
                variant="accent"
                surface="secondary"
                fullWidth
                loading={reloading}
                disabled={conflictBusy}
                onClick={() => void reloadFromLuna()}
              >
                Reload from Luna
              </Button>
            ) : null}
          </div>
        </div>
      </ModalCard>
    </>
  );
}

SqliteEditorSession.propTypes = {
  canWrite: PropTypes.bool.isRequired,
  initialBytes: PropTypes.instanceOf(Uint8Array).isRequired,
  revision: PropTypes.number.isRequired,
  onSave: PropTypes.func.isRequired,
  onReload: PropTypes.func,
  frame: PropTypes.shape({
    onRegisterSave: PropTypes.func.isRequired,
    onSaveStateChange: PropTypes.func.isRequired,
    requestClose: PropTypes.func,
  }).isRequired,
  formMode: PropTypes.bool,
};
