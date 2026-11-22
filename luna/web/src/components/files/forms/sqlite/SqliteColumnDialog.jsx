/**
 * Add or rename one column. Removing a column is a ConfirmModal in the
 * parent because it destroys data; this dialog only writes a DDL statement
 * the parent owns.
 */

import { useRef, useState } from "react";
import PropTypes from "prop-types";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import InlineError from "@libreloom/ui/components/common/InlineError.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import ModalCard, {
  NESTED_OVERLAY_CLASS,
} from "@libreloom/ui/components/cards/ModalCard.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import { COLUMN_TYPES, cleanColumnName } from "./sqliteSql.js";

/** Plain-language names for the SQL types people actually pick. */
const TYPE_LABELS = {
  TEXT: "Text",
  INTEGER: "Whole number",
  REAL: "Decimal number",
  BLOB: "File data (blob)",
  NUMERIC: "Number",
};

/**
 * @param {{
 *   open: boolean,
 *   mode: "add" | "rename",
 *   tableName: string,
 *   column?: { name: string } | null,
 *   existingNames: string[],
 *   onSubmit: (values: { name: string, type: string }) => Promise<unknown>,
 *   onClose: () => void,
 * }} props
 */
export default function SqliteColumnDialog({
  open,
  mode,
  tableName,
  column = null,
  existingNames,
  onSubmit,
  onClose,
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState("TEXT");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Start closed so the first open seeds the fields: a dialog mounted with
  // `open` already true must still get the current column name.
  const [wasOpen, setWasOpen] = useState(false);
  const nameRef = useRef(/** @type {HTMLInputElement|null} */ (null));

  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setName(mode === "rename" ? column?.name ?? "" : "");
      setType("TEXT");
      setError("");
      setBusy(false);
    }
  }

  function close() {
    if (!busy) onClose();
  }

  async function submit() {
    if (busy) return;
    try {
      const clean = cleanColumnName(name);
      const duplicate = existingNames.some(
        (existing) =>
          existing.toLowerCase() === clean.toLowerCase() &&
          !(mode === "rename" && existing === column?.name),
      );
      if (duplicate) {
        setError("A column with that name already exists.");
        return;
      }
      if (mode === "rename" && clean === column?.name) {
        onClose();
        return;
      }
      setBusy(true);
      setError("");
      await onSubmit({ name: clean, type });
      onClose();
    } catch (err) {
      setError(String(err?.message || err || "Luna couldn't change the column."));
    } finally {
      setBusy(false);
    }
  }

  const title = mode === "rename" ? "Rename column" : "Add column";

  return (
    <ModalCard
      open={open}
      onClose={close}
      title={title}
      size="sm"
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
        <label className="block text-sm text-primary">
          <span className="block px-4">Column name</span>
          <input
            ref={nameRef}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              if (error) setError("");
            }}
            className="mt-1 w-full rounded-pill border-2 border-secondary/30 surface-primary px-4 py-2 text-sm text-secondary outline-none no-focus-outline focus:border-accent"
            placeholder={mode === "rename" ? "New name" : "For example, email"}
            autoComplete="off"
            spellCheck={false}
          />
        </label>

        {mode === "add" ? (
          <label className="mt-3 block text-sm text-primary">
            <span className="block px-4">Type</span>
            <select
              value={type}
              onChange={(event) => setType(event.target.value)}
              className="mt-1 w-full rounded-pill border-2 border-secondary/30 surface-primary px-4 py-2 text-sm text-secondary outline-none no-focus-outline focus:border-accent"
            >
              {COLUMN_TYPES.map((value) => (
                <option key={value} value={value}>
                  {TYPE_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <PageNotice variant="warning" surface="secondary" className="mt-4">
          Changing columns on <InlinePill>{tableName}</InlinePill> can break this
          form. Test it after you save.
        </PageNotice>

        {error ? <InlineError className="mt-3">{error}</InlineError> : null}

        <div className="mt-4 flex flex-wrap gap-3">
          <Button variant="primary" type="submit" loading={busy}>
            {mode === "rename" ? "Rename column" : "Add column"}
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

SqliteColumnDialog.propTypes = {
  open: PropTypes.bool.isRequired,
  mode: PropTypes.oneOf(["add", "rename"]).isRequired,
  tableName: PropTypes.string.isRequired,
  column: PropTypes.shape({ name: PropTypes.string }),
  existingNames: PropTypes.arrayOf(PropTypes.string).isRequired,
  onSubmit: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};
