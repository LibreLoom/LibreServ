/**
 * The editable table grid.
 *
 * A native table rather than the shared `Table` component: this surface needs
 * a sticky header, one dense row per record, inline cell editors, and a
 * column menu on every header. Query results (read-only) use `Table`.
 */

import { useRef, useState } from "react";
import PropTypes from "prop-types";
import {
  ChevronLeft,
  ChevronRight,
  KeyRound,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import Dropdown from "@libreloom/ui/components/common/Dropdown.jsx";
import Spinner from "@libreloom/ui/components/ui/Spinner.jsx";
import { TooltipTargets } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { cn } from "@libreloom/ui/lib/utils.js";
import {
  GRID_PAGE_SIZE,
  formatCellValue,
  formatCount,
  formatEditableValue,
  isBlob,
} from "./sqliteModel.js";

const NUMERIC_TYPE = /(INT|REAL|FLOA|DOUB|NUMERIC|DECIMAL)/i;

/**
 * Inline cell editor. Enter commits, Escape cancels, leaving the field
 * commits. Guarded so the blur that follows Enter cannot commit twice.
 *
 * @param {{
 *   initial: string,
 *   numeric: boolean,
 *   label: string,
 *   onCommit: (raw: string) => void,
 *   onCancel: () => void,
 * }} props
 */
function CellEditor({ initial, numeric, label, onCommit, onCancel }) {
  const [value, setValue] = useState(initial);
  const doneRef = useRef(false);
  const finish = (commit) => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (commit) onCommit(value);
    else onCancel();
  };
  return (
    <input
      data-slot="sqlite-cell-editor"
      data-escape-own=""
      autoFocus
      value={value}
      aria-label={label}
      onChange={(event) => setValue(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        if (event.nativeEvent?.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          finish(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finish(false);
        }
      }}
      className={cn(
        "w-full min-w-[7rem] rounded-chip border-2 border-primary/30 surface-secondary px-2 py-1 text-sm text-primary outline-none no-focus-outline focus:border-accent",
        numeric && "tabular-nums",
      )}
    />
  );
}

CellEditor.propTypes = {
  initial: PropTypes.string.isRequired,
  numeric: PropTypes.bool,
  label: PropTypes.string.isRequired,
  onCommit: PropTypes.func.isRequired,
  onCancel: PropTypes.func.isRequired,
};

/**
 * @param {{ value: unknown, numeric?: boolean }} props
 */
function GridValue({ value, numeric }) {
  const formatted = formatCellValue(value);
  const isNullish = formatted.kind === "null" || formatted.kind === "empty";
  return (
    <span
      data-tooltip={formatted.title || undefined}
      className={cn(
        "block max-w-[20rem] truncate",
        numeric && "tabular-nums",
        isNullish && "italic",
      )}
    >
      {formatted.text}
    </span>
  );
}

GridValue.propTypes = {
  value: PropTypes.any,
  numeric: PropTypes.bool,
};

/**
 * @param {{
 *   table: any,
 *   rows: any[][],
 *   total: number,
 *   page: number,
 *   pageSize?: number,
 *   canWrite?: boolean,
 *   busy?: boolean,
 *   loading?: boolean,
 *   truncated?: boolean,
 *   onPageChange: (page: number) => void,
 *   onUpdateCell: (rowIndex: number, column: any, raw: string) => Promise<void>,
 *   onRenameColumn: (column: any) => void,
 *   onDropColumn: (column: any) => void,
 *   onDeleteRow: (row: any[], rowIndex: number) => void,
 *   onAddRow: () => void,
 *   onAddColumn: () => void,
 *   onEditingChange?: (editing: boolean) => void,
 * }} props
 */
export default function SqliteGrid({
  table,
  rows,
  total,
  page,
  pageSize = GRID_PAGE_SIZE,
  canWrite = false,
  busy = false,
  loading = false,
  truncated = false,
  onPageChange,
  onUpdateCell,
  onRenameColumn,
  onDropColumn,
  onDeleteRow,
  onAddRow,
  onAddColumn,
  onEditingChange,
}) {
  const [editing, setEditing] = useState(
    /** @type {{ rowIndex: number, colIndex: number } | null} */ (null),
  );
  const scope = `${table.name}:${page}`;
  const [editScope, setEditScope] = useState(scope);
  if (editScope !== scope) {
    setEditScope(scope);
    setEditing(null);
    onEditingChange?.(false);
  }

  const canEditRows = Boolean(canWrite && table.primaryKey.length > 0);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = total === 0 ? 0 : Math.min(total, page * pageSize);
  const columnCount = table.columns.length;
  // An empty table has no rows to show, so its one action moves into the
  // empty state instead of leaving a "No rows yet" line above an Add row.
  const emptyTable = !loading && total === 0 && rows.length === 0;
  /** @param {"ghost" | "outline"} variant */
  const addRowButton = (variant) => (
    <Button
      variant={variant}
      surface="primary"
      size="sm"
      smoothResize={false}
      haptic="light"
      type="button"
      disabled={busy}
      onClick={onAddRow}
    >
      <Plus size={ICON_SIZE.sm} aria-hidden="true" />
      Add row
    </Button>
  );

  /**
   * @param {number} rowIndex
   * @param {number} colIndex
   */
  function startEdit(rowIndex, colIndex) {
    const column = table.columns[colIndex];
    if (!canEditRows || busy || !column || column.generated || column.hidden) return;
    if (column.pk > 0) return;
    if (isBlob(rows[rowIndex]?.[colIndex])) return;
    if (/BLOB/i.test(column.type || "")) return;
    haptic("selection");
    setEditing({ rowIndex, colIndex });
    onEditingChange?.(true);
  }

  /** @param {string} raw */
  function commitEdit(raw) {
    const edit = editing;
    setEditing(null);
    onEditingChange?.(false);
    if (!edit) return;
    const initial = formatEditableValue(rows[edit.rowIndex]?.[edit.colIndex]);
    if (raw === initial) return;
    const column = table.columns[edit.colIndex];
    void onUpdateCell(edit.rowIndex, column, raw).catch(() => {
      // The parent shows the error above the grid; the cell stays as it was.
    });
  }

  return (
    <TooltipTargets className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-large-element border border-secondary/20 surface-primary">
      <div className="min-h-0 flex-1 overflow-auto">
        <table
          aria-label={`${table.name} rows`}
          className="w-max min-w-full border-separate border-spacing-0 text-sm"
        >
          <thead>
            <tr>
              {table.columns.map((column) => (
                <th
                  key={column.name}
                  scope="col"
                  className="sticky top-0 z-10 min-w-[10rem] max-w-[22rem] border-b border-primary/20 surface-secondary px-3 py-2 text-left align-bottom"
                >
                  <div className="flex items-center gap-1">
                    <span className="min-w-0 truncate font-mono text-xs text-primary">
                      {column.name}
                    </span>
                    {column.pk > 0 ? (
                      <span
                        role="img"
                        aria-label="Primary key"
                        data-tooltip="Primary key. Use SQL to change it."
                        className="shrink-0"
                      >
                        <KeyRound
                          size={ICON_SIZE.xs}
                          className="text-primary"
                          aria-hidden="true"
                        />
                      </span>
                    ) : null}
                    {canWrite ? (
                      <span className="ml-auto shrink-0">
                        <Dropdown
                          options={[
                            {
                              value: "rename",
                              label: "Rename column",
                              icon: Pencil,
                            },
                            {
                              value: "drop",
                              label: "Remove column",
                              icon: Trash2,
                            },
                          ]}
                          value=""
                          onChange={(action) => {
                            if (action === "rename") onRenameColumn(column);
                            else if (action === "drop") onDropColumn(column);
                          }}
                          menu
                          menuLabel={`${column.name} column actions`}
                          icon={MoreHorizontal}
                          bg="secondary"
                          ghost
                          align="end"
                          disabled={busy}
                          aria-label={`Actions for column ${column.name}`}
                        />
                      </span>
                    ) : null}
                  </div>
                  <span className="mt-1 block truncate text-[11px] text-primary">
                    {column.type || "No type"}
                  </span>
                </th>
              ))}
              {canWrite ? (
                <th
                  scope="col"
                  className="sticky top-0 right-0 z-20 w-12 border-b border-primary/20 surface-secondary px-2 py-2 text-right align-middle"
                >
                  <Button
                    variant="ghost"
                    surface="secondary"
                    size="iconSm"
                    smoothResize={false}
                    haptic="light"
                    type="button"
                    aria-label="Add column"
                    tooltip="Add column"
                    disabled={busy}
                    onClick={onAddColumn}
                  >
                    <Plus size={ICON_SIZE.sm} aria-hidden="true" />
                  </Button>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={columnCount + (canWrite ? 1 : 0)}
                  className="px-4 py-10 text-center text-sm text-secondary"
                >
                  {loading ? (
                    <span className="inline-flex items-center gap-2">
                      <Spinner size="sm" decorative />
                      Loading rows…
                    </span>
                  ) : truncated && total > 0 ? (
                    "This page is too large to display here."
                  ) : total > 0 ? (
                    "No rows on this page."
                  ) : canWrite ? (
                    <span className="inline-flex flex-col items-center gap-3">
                      <span className="font-mono text-xs">No rows yet.</span>
                      {addRowButton("outline")}
                    </span>
                  ) : (
                    "No rows."
                  )}
                </td>
              </tr>
            ) : (
              rows.map((row, rowIndex) => (
                <tr key={`${page}:${rowIndex}`}>
                  {table.columns.map((column, colIndex) => {
                    const editable =
                      canEditRows &&
                      !busy &&
                      !column.generated &&
                      !column.hidden &&
                      column.pk === 0 &&
                      !isBlob(row[colIndex]) &&
                      !/BLOB/i.test(column.type || "");
                    const numeric =
                      typeof row[colIndex] === "number" ||
                      NUMERIC_TYPE.test(column.type || "");
                    const absolute = (page - 1) * pageSize + rowIndex + 1;
                    const isEditing =
                      editing?.rowIndex === rowIndex &&
                      editing?.colIndex === colIndex;
                    return (
                      <td
                        key={column.name}
                        tabIndex={editable ? 0 : undefined}
                        aria-label={
                          editable
                            ? `Edit ${column.name}, row ${absolute}`
                            : undefined
                        }
                        onDoubleClick={() => startEdit(rowIndex, colIndex)}
                        onKeyDown={(event) => {
                          if (!editable || event.key !== "Enter") return;
                          event.preventDefault();
                          startEdit(rowIndex, colIndex);
                        }}
                        className={cn(
                          "h-10 max-w-[22rem] border-b border-secondary/10 px-3 py-1 align-middle text-secondary",
                          numeric && "tabular-nums",
                          editable &&
                            "cursor-text focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent",
                        )}
                      >
                        {isEditing ? (
                          <CellEditor
                            initial={formatEditableValue(row[colIndex])}
                            numeric={numeric}
                            label={`Edit ${column.name}, row ${absolute}`}
                            onCommit={commitEdit}
                            onCancel={() => {
                              setEditing(null);
                              onEditingChange?.(false);
                            }}
                          />
                        ) : (
                          <GridValue value={row[colIndex]} numeric={numeric} />
                        )}
                      </td>
                    );
                  })}
                  {canWrite ? (
                    <td className="sticky right-0 z-10 h-10 w-12 border-b border-secondary/10 surface-primary px-2 py-1 text-right align-middle">
                      {canEditRows ? (
                        <Button
                          variant="ghost"
                          surface="primary"
                          size="iconSm"
                          smoothResize={false}
                          haptic="light"
                          disabled={busy}
                          aria-label={`Delete row ${(page - 1) * pageSize + rowIndex + 1}`}
                          tooltip="Delete row"
                          onClick={() => onDeleteRow(row, rowIndex)}
                        >
                          <Trash2
                            size={ICON_SIZE.sm}
                            aria-hidden="true"
                          />
                        </Button>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))
            )}
            {canWrite && !emptyTable ? (
              <tr>
                <td
                  colSpan={columnCount + 1}
                  className="border-b border-secondary/10 px-2 py-1"
                >
                  {addRowButton("ghost")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-t border-secondary/20 px-3 text-xs text-secondary">
        <span className="min-w-0 truncate font-mono text-[11px] tabular-nums">
          {total === 0
            ? "No rows"
            : `${formatCount(first)}–${formatCount(last)} of ${formatCount(total)}`}
          <span className="text-secondary">
            {" · "}
            Page {page} of {pageCount}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            surface="primary"
            size="iconSm"
            smoothResize={false}
            haptic="light"
            disabled={busy || loading || page <= 1}
            aria-label="Previous page"
            onClick={() => onPageChange(page - 1)}
          >
            <ChevronLeft size={ICON_SIZE.md} aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            surface="primary"
            size="iconSm"
            smoothResize={false}
            haptic="light"
            disabled={busy || loading || page >= pageCount}
            aria-label="Next page"
            onClick={() => onPageChange(page + 1)}
          >
            <ChevronRight size={ICON_SIZE.md} aria-hidden="true" />
          </Button>
        </span>
      </div>
    </TooltipTargets>
  );
}

SqliteGrid.propTypes = {
  table: PropTypes.shape({
    name: PropTypes.string.isRequired,
    columns: PropTypes.array.isRequired,
    primaryKey: PropTypes.arrayOf(PropTypes.string).isRequired,
  }).isRequired,
  rows: PropTypes.array.isRequired,
  total: PropTypes.number.isRequired,
  page: PropTypes.number.isRequired,
  pageSize: PropTypes.number,
  canWrite: PropTypes.bool,
  busy: PropTypes.bool,
  loading: PropTypes.bool,
  truncated: PropTypes.bool,
  onPageChange: PropTypes.func.isRequired,
  onUpdateCell: PropTypes.func.isRequired,
  onRenameColumn: PropTypes.func.isRequired,
  onDropColumn: PropTypes.func.isRequired,
  onDeleteRow: PropTypes.func.isRequired,
  onAddRow: PropTypes.func.isRequired,
  onAddColumn: PropTypes.func.isRequired,
};
