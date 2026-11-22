import { useRef, useState } from "react";
import PropTypes from "prop-types";
import { useMutation, useQuery } from "@tanstack/react-query";
import { RotateCcw, Unlink } from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import ConfirmModal from "@libreloom/ui/components/cards/ConfirmModal.jsx";
import SettingsCard from "@libreloom/ui/components/settings/SettingsCard.jsx";
import SettingsRow from "@libreloom/ui/components/settings/SettingsRow.jsx";
import { getJson, postJson, apiErrorMessage } from "../../../lib/api";

/** What the reset tells lunad about Luna Connect (api/search.rs `ConnectChoice`). */
const KEEP = "keep";
const UNBOUND = "unbound";
const PENDING = "pending";

/**
 * Admin-only: wipe accounts, shares and settings and start setup over.
 * Files on the drives stay where they are. The password is typed again so a
 * stray click or a borrowed browser can't do it. When Luna is linked to a
 * Luna Connect account, one more step asks whether to unbind it first.
 *
 * @param {{ index?: number }} props
 */
export default function ResetLunaCard({ index = 0 }) {
  const [open, setOpen] = useState(false);
  // "confirm" (password) → "connect" (unbind?) → reset.
  const [step, setStep] = useState(/** @type {"confirm"|"connect"} */ ("confirm"));
  const [password, setPassword] = useState("");
  const [error, setError] = useState(/** @type {string|null} */ (null));
  const [unbindFailed, setUnbindFailed] = useState(false);
  // Once settled (unbound, or chosen to keep), a retried reset doesn't ask again.
  const [connectChoice, setConnectChoice] = useState(/** @type {string|null} */ (null));
  const passwordRef = useRef(/** @type {HTMLInputElement|null} */ (null));

  const connect = useQuery({
    queryKey: ["connect-status"],
    queryFn: () => getJson("/api/v1/connect/status"),
    retry: false,
  });
  const linked = connect.data?.paired === true;

  const reset = useMutation({
    mutationFn: (/** @type {string} */ choice) =>
      postJson("/api/v1/system/factory-reset", { confirm: true, password, connect: choice }),
    onSuccess: () => { window.location.href = "/setup"; },
    // The dialog is open and owns this error; back to the password step to fix it.
    onError: (err) => {
      setStep("confirm");
      setError(apiErrorMessage(err, "Couldn't reset this Luna. Try again."));
    },
  });

  const unbind = useMutation({
    mutationFn: () => postJson("/api/v1/connect/unbind", { password }),
    onSuccess: () => {
      setConnectChoice(UNBOUND);
      reset.mutate(UNBOUND);
    },
    onError: (err) => {
      const status = /** @type {any} */ (err)?.status;
      const message = apiErrorMessage(err, "Couldn't unbind Luna Connect. Try again.");
      // A wrong password or too many tries: fix it on the password step.
      if (status === 401 || status === 429) {
        setStep("confirm");
        setError(message);
        return;
      }
      setUnbindFailed(true);
      setError(message);
    },
  });

  const busy = reset.isPending || unbind.isPending;
  const confirming = step === "confirm";

  function startReset(/** @type {string} */ choice) {
    setError(null);
    reset.mutate(choice);
  }

  function confirmPassword() {
    if (linked && !connectChoice) {
      setError(null);
      setUnbindFailed(false);
      setStep("connect");
      return;
    }
    startReset(connectChoice ?? KEEP);
  }

  function tryUnbind() {
    setError(null);
    setUnbindFailed(false);
    unbind.mutate();
  }

  function close() {
    if (busy) return;
    setOpen(false);
    setStep("confirm");
    setPassword("");
    setError(null);
    setUnbindFailed(false);
  }

  const connectActions = () =>
    unbindFailed ? (
      <>
        <Button variant="outline" surface="secondary" onClick={() => startReset(PENDING)} loading={reset.isPending} disabled={busy} className="flex-1">
          Skip
        </Button>
        <Button variant="primary" onClick={tryUnbind} loading={unbind.isPending} disabled={busy} className="flex-1">
          Retry
        </Button>
      </>
    ) : (
      <>
        <Button
          variant="outline"
          surface="secondary"
          onClick={() => {
            setConnectChoice(KEEP);
            startReset(KEEP);
          }}
          loading={reset.isPending}
          disabled={busy}
          className="flex-1"
        >
          Keep linked
        </Button>
        <Button variant="primary" onClick={tryUnbind} loading={unbind.isPending} disabled={busy} className="flex-1">
          Unbind
        </Button>
      </>
    );

  return (
    <SettingsCard icon={RotateCcw} title="Reset this Luna" padding={false} index={index}>
      <SettingsRow
        label="Erase accounts and settings"
        description="Removes every account, share, backup setting, and drive from Luna, then starts setup again. Files on your drives are not deleted."
        hideDivider
        stack
      >
        <Button variant="accent" onClick={() => setOpen(true)}>
          Reset this Luna
        </Button>
      </SettingsRow>
      {/* One dialog, two steps: the password, then (when linked) the unbind question. */}
      <ConfirmModal
        open={open}
        onClose={close}
        onConfirm={confirmPassword}
        variant={confirming ? "danger" : "default"}
        icon={confirming ? RotateCcw : Unlink}
        title={confirming ? "Reset this Luna?" : "Unbinding Luna Connect"}
        message={confirming
          ? "Everyone is signed out and backups stop. Files on your drives are not deleted, and getting cloud backups back later needs your recovery phrase."
          : "This Luna is linked to a Luna Connect account. Unbind it so that account can no longer reach this Luna?"}
        confirmLabel="Reset this Luna"
        actions={confirming ? undefined : connectActions}
        loading={busy}
        // Wait to learn whether Luna is linked, so the unbind step is never skipped.
        disabledConfirm={!password.trim() || connect.isLoading}
        error={error}
        initialFocusRef={passwordRef}
      >
        {confirming ? (
          <>
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
          </>
        ) : (
          <p className="text-sm">
            {unbindFailed
              ? "Skip resets anyway, and Luna keeps trying to unbind in the background. You can also unbind it on the Luna Connect website."
              : "You can also unbind it on the Luna Connect website."}
          </p>
        )}
      </ConfirmModal>
    </SettingsCard>
  );
}

ResetLunaCard.propTypes = { index: PropTypes.number };
