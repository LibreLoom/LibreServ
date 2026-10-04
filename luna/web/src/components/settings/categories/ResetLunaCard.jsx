import { useRef, useState } from "react";
import PropTypes from "prop-types";
import { useMutation } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import ConfirmModal from "@libreloom/ui/components/cards/ConfirmModal.jsx";
import SettingsCard from "@libreloom/ui/components/settings/SettingsCard.jsx";
import SettingsRow from "@libreloom/ui/components/settings/SettingsRow.jsx";
import { postJson, apiErrorMessage } from "../../../lib/api";

/**
 * Admin-only: wipe accounts, shares and settings and start setup over.
 * Files on the drives stay where they are. The password is typed again so a
 * stray click or a borrowed browser can't do it.
 *
 * @param {{ index?: number }} props
 */
export default function ResetLunaCard({ index = 0 }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState(/** @type {string|null} */ (null));
  const passwordRef = useRef(/** @type {HTMLInputElement|null} */ (null));

  const reset = useMutation({
    mutationFn: () => postJson("/api/v1/system/factory-reset", { confirm: true, password }),
    onSuccess: () => { window.location.href = "/setup"; },
    // The dialog is open and owns this error.
    onError: (err) => setError(apiErrorMessage(err)),
  });

  function close() {
    if (reset.isPending) return;
    setOpen(false);
    setPassword("");
    setError(null);
  }

  return (
    <SettingsCard icon={RotateCcw} title="Reset this Luna" padding={false} index={index}>
      <SettingsRow
        label="Erase accounts and settings"
        description="Removes every account, share, and setting, then starts setup over. Files on your drives stay where they are."
        hideDivider
        stack
      >
        <Button variant="accent" onClick={() => setOpen(true)}>
          Reset this Luna
        </Button>
      </SettingsRow>
      <ConfirmModal
        open={open}
        onClose={close}
        onConfirm={() => {
          setError(null);
          reset.mutate();
        }}
        icon={RotateCcw}
        title="Reset this Luna?"
        message="Everyone is signed out and Remote access turns off. Files on your drives are not deleted."
        variant="danger"
        confirmLabel="Reset this Luna"
        loading={reset.isPending}
        disabledConfirm={!password.trim()}
        error={error}
        initialFocusRef={passwordRef}
      >
        <label className="block text-sm" htmlFor="reset-luna-password">
          <span className="block translate-x-5">Type your password to confirm</span>
        </label>
        <input
          id="reset-luna-password"
          type="password"
          autoComplete="current-password"
          className="mt-2 w-full rounded-pill surface-primary border-2 border-secondary/30 px-4 py-2 text-sm outline-none focus:border-accent"
          value={password}
          ref={passwordRef}
          onChange={(e) => setPassword(e.target.value)}
        />
      </ConfirmModal>
    </SettingsCard>
  );
}

ResetLunaCard.propTypes = { index: PropTypes.number };
