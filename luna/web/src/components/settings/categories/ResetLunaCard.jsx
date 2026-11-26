import { useRef, useState } from "react";
import PropTypes from "prop-types";
import { useMutation, useQuery } from "@tanstack/react-query";
import { RotateCcw, Unlink } from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import ConfirmModal from "@libreloom/ui/components/cards/ConfirmModal.jsx";
import SettingsCard from "@libreloom/ui/components/settings/SettingsCard.jsx";
import SettingsRow from "@libreloom/ui/components/settings/SettingsRow.jsx";
import { getJson, postJson, apiErrorMessage } from "../../../lib/api";
import { connectState } from "../../../lib/connectState.js";

/** What the reset tells lunad about Luna Connect (`api/search.rs ConnectChoice`). */
const KEEP = "keep";
const DISCONNECT = "disconnect";

/**
 * Admin-only: wipe accounts, shares and settings and start setup over.
 * Files on the drives stay where they are. The password is typed again so a
 * stray click or a borrowed browser can't do it. Every reset then asks whether
 * to keep Connect or use the normal disconnect flow.
 *
 * @param {{ index?: number }} props
 */
export default function ResetLunaCard({ index = 0 }) {
  const [open, setOpen] = useState(false);
  // "confirm" (password) → "connect" (keep/disconnect) → reset.
  const [step, setStep] = useState(/** @type {"confirm"|"connect"} */ ("confirm"));
  const [password, setPassword] = useState("");
  const [error, setError] = useState(/** @type {string|null} */ (null));
  const [disconnectFailed, setDisconnectFailed] = useState(false);
  // Once settled, a retried reset doesn't ask again.
  const [connectChoice, setConnectChoice] = useState(/** @type {string|null} */ (null));
  const passwordRef = useRef(/** @type {HTMLInputElement|null} */ (null));

  const connect = useQuery({
    queryKey: ["connect-status"],
    queryFn: () => getJson("/api/v1/connect/status", { cache: "no-store" }),
    retry: false,
  });
  const state = connectState(connect.data);
  const alreadyPending = state === "pending";
  const needsDisconnectRequest = state === "bound" || state === "pending" || state === "pairing" || state === "revoked";
  const canResetAfterDisconnectFailure = state === "bound" || state === "pending";

  const reset = useMutation({
    mutationFn: (/** @type {string} */ choice) =>
      postJson("/api/v1/system/factory-reset", { confirm: true, password, connect: choice }),
    onSuccess: () => { window.location.href = "/setup"; },
    // The dialog is open and owns this error; return to the password step.
    onError: (err) => {
      setStep("confirm");
      setError(apiErrorMessage(err, "Couldn't reset this Luna. Try again."));
    },
  });

  const disconnect = useMutation({
    mutationFn: () => postJson("/api/v1/connect/unbind", { password }),
    onSuccess: () => {
      setConnectChoice(DISCONNECT);
      reset.mutate(DISCONNECT);
    },
    onError: (err) => {
      const status = /** @type {any} */ (err)?.status;
      const message = apiErrorMessage(err, "Couldn't disconnect Luna Connect. Try again.");
      if (status === 401 || status === 429) {
        setStep("confirm");
        setError(message);
        return;
      }
      setDisconnectFailed(true);
      setError(message);
    },
  });

  const busy = reset.isPending || disconnect.isPending;
  const confirming = step === "confirm";

  function startReset(/** @type {string} */ choice) {
    setError(null);
    setConnectChoice(choice);
    reset.mutate(choice);
  }

  function confirmPassword() {
    if (!connectChoice) {
      setError(null);
      setDisconnectFailed(false);
      setStep("connect");
      return;
    }
    startReset(connectChoice);
  }

  function tryDisconnect() {
    setError(null);
    setDisconnectFailed(false);
    // When Luna positively reports no binding, there is no remote credential
    // to revoke. Without that answer, ask Luna so reset never guesses.
    if (connect.isSuccess && !needsDisconnectRequest) {
      startReset(DISCONNECT);
      return;
    }
    disconnect.mutate();
  }

  function close() {
    if (busy) return;
    setOpen(false);
    setStep("confirm");
    setPassword("");
    setError(null);
    setDisconnectFailed(false);
    setConnectChoice(null);
  }

  const connectActions = () =>
    disconnectFailed ? (
      <>
        {canResetAfterDisconnectFailure ? (
          <Button
            variant="accent"
            surface="secondary"
            onClick={() => startReset(DISCONNECT)}
            loading={reset.isPending}
            disabled={busy}
            className="flex-1"
          >
            Reset and keep trying
          </Button>
        ) : null}
        <Button
          variant="primary"
          onClick={tryDisconnect}
          loading={disconnect.isPending}
          disabled={busy}
          className="flex-1"
        >
          Try disconnect again
        </Button>
      </>
    ) : (
      <>
        <Button
          variant="outline"
          surface="secondary"
          onClick={() => startReset(KEEP)}
          loading={reset.isPending}
          disabled={busy || alreadyPending}
          className="flex-1"
        >
          Keep Connect
        </Button>
        <Button
          variant="danger"
          onClick={tryDisconnect}
          loading={disconnect.isPending}
          disabled={busy}
          className="flex-1"
        >
          Disconnect
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
      <ConfirmModal
        open={open}
        onClose={close}
        onConfirm={confirmPassword}
        variant={confirming ? "danger" : "warning"}
        icon={confirming ? RotateCcw : Unlink}
        title={confirming ? "Reset this Luna?" : "Keep or disconnect Luna Connect?"}
        message={confirming
          ? "Everyone is signed out and backups stop. Files on your drives are not deleted, and getting cloud backups back later needs your recovery phrase."
          : state === "pairing"
            ? "Keep Connect leaves this pairing attempt in place. Disconnect cancels it, and you can pair this Luna again later."
            : state === "revoked"
              ? "Keep Connect leaves this Luna disconnected from remote access. Disconnect clears it from your Connect account, and you can pair it again later."
              : "Keep Connect leaves this Luna's connection as it is. Disconnect stops remote access, and you can connect this Luna again later."}
        confirmLabel="Reset this Luna"
        actions={confirming ? undefined : connectActions}
        loading={busy}
        disabledConfirm={!password.trim()}
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
        ) : state === "revoked" ? (
          <p className="text-sm text-primary">
            {disconnectFailed ? (
              <>
                Luna couldn&apos;t clear this Luna from your Connect account. Disconnect it on the{" "}
                <a className="underline" href="https://connect.luna.libreloom.org" target="_blank" rel="noopener noreferrer">
                  Luna Connect website
                </a>{" "}
                before resetting.
              </>
            ) : (
              <>You can also disconnect this Luna from the <a className="underline" href="https://connect.luna.libreloom.org" target="_blank" rel="noopener noreferrer">Luna Connect website</a>.</>
            )}
          </p>
        ) : state === "pairing" && disconnectFailed ? (
          <p className="text-sm text-primary">
            Luna couldn&apos;t cancel pairing. Try again before resetting.
          </p>
        ) : (
          <p className="text-sm text-primary">
            {disconnectFailed
              ? "Luna couldn't confirm the disconnect. Remote access and pairing stay off while Luna keeps trying."
              : alreadyPending
                ? "Remote access and pairing are off until the previous disconnect finishes. Finish disconnecting before you can keep Connect."
                : "You can also disconnect this Luna from the Luna Connect website."}
          </p>
        )}
      </ConfirmModal>
    </SettingsCard>
  );
}

ResetLunaCard.propTypes = { index: PropTypes.number };
