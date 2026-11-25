/**
 * Create a table from a small form instead of typing CREATE TABLE.
 *
 * The parent owns the SQL and the worker; this dialog only collects a table
 * name and its columns.
 */

import { useRef, useState } from "react";
import PropTypes from "prop-types";
import { Plus, Trash2 } from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import AnimatedCheckbox from "@libreloom/ui/components/ui/AnimatedCheckbox.jsx";
import Dropdown from "@libreloom/ui/components/common/Dropdown.jsx";
import InlineError from "@libreloom/ui/components/common/InlineError.jsx";
import ModalCard, {
  NESTED_OVERLAY_CLASS,
} from "@libreloom/ui/components/cards/ModalCard.jsx";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { COLUMN_TYPES } from "./sqliteSql.js";

const TYPE_LABELS = {
  TEXT: "Text",
  INTEGER: "Whole number",
  REAL: "Decimal number",
  BLOB: "File data (blob)",
  NUMERIC: "Number",
};

const TYPE_OPTIONS = COLUMN_TYPES.map((value) => ({
  value,
  label: TYPE_LABELS[value],
}));

/** A fresh table starts with the id column most people want. */
function initialColumns() {
  return [{ key: 1, name: "id", type: "INTEGER", primaryKey: true, notNull: true }];
}

function friendlyError(error) {
  const text = String(error?.message || error || "");
  if (/already exists/i.test(text)) {
    return "A table or column with that name already exists.";
  }
  if (/syntax error/i.test(text)) {
    return "Check the table and column names and try again.";
  }
  return text || "Luna couldn't create the table.";
}

/**
 * @param {{
 *   open: boolean,
 *   onSubmit: (values: {
 *     name: string,
 *     columns: { name: string, type: string, primaryKey: boolean, notNull: boolean }[],
 *   }) => Promise<unknown>,
 *   onClose: () => void,
 * }} props
 */
export default function SqliteTableDialog({ open, onSubmit, onClose }) {
  const [name, setName] = useState("");
  const [columns, setColumns] = useState(initialColumns);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [wasOpen, setWasOpen] = useState(false);
  const nameRef = useRef(/** @type {HTMLInputElement|null} */ (null));
  const nextKeyRef = useRef(2);

  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setName("");
      setColumns(initialColumns());
      nextKeyRef.current = 2;
      setError("");
      setBusy(false);
    }
  }

  function close() {
    if (!busy) onClose();
  }

  function addColumn() {
    setColumns((current) => [
      ...current,
      {
        key: nextKeyRef.current,
        name: "",
        type: "TEXT",
        primaryKey: false,
        notNull: false,
      },
    ]);
    nextKeyRef.current += 1;
  }

  function updateColumn(key, patch) {
    setColumns((current) =>
      current.map((column) =>
        column.key === key ? { ...column, ...patch } : column,
      ),
    );
    if (error) setError("");
  }

  function removeColumn(key) {
    setColumns((current) =>
      current.length > 1 ? current.filter((column) => column.key !== key) : current,
    );
  }

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onSubmit({
        name,
        columns: columns.map(({ key: _key, ...column }) => column),
      });
      onClose();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalCard
      open={open}
      onClose={close}
      title="New table"
      size="md"
      overlayClassName={NESTED_OVERLAY_CLASS}
      initialFocusRef={nameRef}
      showCloseButton={!busy}
      openHaptic={false}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="block text-sm text-primary" htmlFor="sqlite-new-table-name">
          <span className="block px-4">Table name</span>
          <input
            id="sqlite-new-table-name"
            ref={nameRef}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              if (error) setError("");
            }}
            className="mt-1 w-full rounded-pill border-2 border-secondary/30 surface-primary px-4 py-2 text-sm text-secondary outline-none no-focus-outline focus:border-accent"
            placeholder="For example, members"
            autoComplete="off"
            spellCheck={false}
          />
        </label>

        <div className="mt-5 flex items-center justify-between gap-2">
          <h3 className="text-sm text-primary">Columns</h3>
          <Button
            variant="ghost"
            surface="secondary"
            size="sm"
            type="button"
            haptic="light"
            disabled={busy}
            onClick={addColumn}
          >
            <Plus size={ICON_SIZE.sm} aria-hidden="true" />
            Add column
          </Button>
        </div>

        <div className="mt-2 flex flex-col gap-2">
          {columns.map((column, index) => (
            <div
              key={column.key}
              className="rounded-large-element border border-primary/15 p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <input
                  aria-label={`Column ${index + 1} name`}
                  value={column.name}
                  onChange={(event) =>
                    updateColumn(column.key, { name: event.target.value })
                  }
                  className="min-w-[8rem] flex-1 rounded-pill border-2 border-secondary/30 surface-primary px-3 py-1.5 text-sm text-secondary outline-none no-focus-outline focus:border-accent"
                  placeholder="Column name"
                  autoComplete="off"
                  spellCheck={false}
                />
                <div className="w-44 shrink-0">
                  <Dropdown
                    aria-label={`Column ${index + 1} type`}
                    options={TYPE_OPTIONS}
                    value={column.type}
                    onChange={(type) => updateColumn(column.key, { type })}
                    bg="primary"
                    size="form"
                    fullWidth
                    triggerClassName="min-h-0 px-3 py-1.5"
                  />
                </div>
                <Button
                  variant="ghost"
                  surface="secondary"
                  size="iconSm"
                  type="button"
                  haptic="light"
                  disabled={busy || columns.length === 1}
                  aria-label={`Remove column ${index + 1}`}
                  tooltip="Remove column"
                  onClick={() => removeColumn(column.key)}
                >
                  <Trash2 size={ICON_SIZE.sm} aria-hidden="true" />
                </Button>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                <AnimatedCheckbox
                  checked={column.primaryKey}
                  onChange={(checked) =>
                    updateColumn(column.key, { primaryKey: checked })
                  }
                  surface="secondary"
                  disabled={busy}
                >
                  Primary key
                </AnimatedCheckbox>
                <AnimatedCheckbox
                  checked={column.notNull}
                  onChange={(checked) =>
                    updateColumn(column.key, { notNull: checked })
                  }
                  surface="secondary"
                  disabled={busy}
                >
                  Required
                </AnimatedCheckbox>
              </div>
            </div>
          ))}
        </div>

        {error ? <InlineError className="mt-3">{error}</InlineError> : null}

        <div className="mt-4 flex flex-wrap gap-3">
          <Button variant="primary" type="submit" loading={busy}>
            Create table
          </Button>
          <Button
            variant="outline"
            type="button"
            onClick={close}
            disabled={busy}
          >
            Cancel
          </Button>
        </div>
      </form>
    </ModalCard>
  );
}

SqliteTableDialog.propTypes = {
  open: PropTypes.bool.isRequired,
  onSubmit: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};
