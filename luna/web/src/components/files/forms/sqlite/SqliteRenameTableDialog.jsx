/**
 * Rename one table. The dialog only collects and checks the name; the parent
 * owns the write, dirty state and list refresh, like the column dialog.
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
import { cleanTableName } from "./sqliteSql.js";

/**
 * @param {{
 *   open: boolean,
 *   tableName: string,
 *   existingNames: string[],
 *   onSubmit: (name: string) => Promise<unknown>,
 *   onClose: () => void,
 * }} props
 */
export default function SqliteRenameTableDialog({
  open,
  tableName,
  existingNames,
  onSubmit,
  onClose,
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Start closed so the first open seeds the field: a dialog mounted with
  // `open` already true must still get the current table name.
  const [wasOpen, setWasOpen] = useState(false);
  const nameRef = useRef(/** @type {HTMLInputElement|null} */ (null));

  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setName(tableName);
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
      const clean = cleanTableName(name);
      const duplicate = existingNames.some(
        (existing) =>
          existing.toLowerCase() === clean.toLowerCase() &&
          existing !== tableName,
      );
      if (duplicate) {
        setError("A table with that name already exists.");
        return;
      }
      if (clean === tableName) {
        onClose();
        return;
      }
      setBusy(true);
      setError("");
      await onSubmit(clean);
      onClose();
    } catch (err) {
      setError(String(err?.message || err || "Luna couldn't rename the table."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalCard
      open={open}
      onClose={close}
      title="Rename table"
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
          <span className="block px-4">Table name</span>
          <input
            ref={nameRef}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              if (error) setError("");
            }}
            onFocus={(event) => event.currentTarget.select()}
            className="mt-1 w-full rounded-pill border-2 border-secondary/30 surface-primary px-4 py-2 text-sm text-secondary outline-none no-focus-outline focus:border-accent"
            placeholder="New name"
            autoComplete="off"
            spellCheck={false}
          />
        </label>

        <PageNotice variant="warning" surface="secondary" className="mt-4">
          Renaming <InlinePill>{tableName}</InlinePill> can break forms that
          use this table. Test them after you save.
        </PageNotice>

        {error ? <InlineError className="mt-3">{error}</InlineError> : null}

        <div className="mt-4 flex flex-wrap gap-3">
          <Button variant="primary" type="submit" loading={busy}>
            Rename table
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

SqliteRenameTableDialog.propTypes = {
  open: PropTypes.bool.isRequired,
  tableName: PropTypes.string.isRequired,
  existingNames: PropTypes.arrayOf(PropTypes.string).isRequired,
  onSubmit: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};
