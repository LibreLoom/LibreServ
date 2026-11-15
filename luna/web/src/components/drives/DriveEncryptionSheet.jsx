import { useState } from "react";
import PropTypes from "prop-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import Callout from "@libreloom/ui/components/common/Callout.jsx";
import InlineError from "@libreloom/ui/components/common/InlineError.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import Pill from "@libreloom/ui/components/common/Pill.jsx";
import { InfoHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import FormInput from "../common/forms/FormInput.jsx";
import NewPasswordFields from "./NewPasswordFields.jsx";
import UnlockPrompt from "./UnlockPrompt.jsx";
import { apiErrorMessage, getJson, postJson } from "../../lib/api.js";
import { newPasswordProblem } from "../../lib/driveCrypt.js";

const NO_RECOVERY = "There is no way to get this password back. If you forget it, the files on this drive are lost.";

/**
 * Encryption (password protection) for one drive, for an Admin. Shows whether the drive is
 * protected and open, and offers what fits:
 *
 * - a plain drive: Protect with a password
 * - a protected drive: Lock, Change password, Remove protection
 * - a locked drive: the unlock prompt first
 *
 * Protect and Remove protection erase the drive, so this sheet never erases
 * anything itself. It collects what the erase needs and hands off:
 * `onProtect(password)` and `onRemove()` are for the page to open the one
 * erase window (FormatDriveFlow) with, and the sheet closes first.
 *
 * @param {{
 *   open?: boolean,
 *   drive: { id: string, label: string, encrypted?: boolean, locked?: boolean } | null,
 *   onClose: () => void,
 *   onProtect: (drive: any, password: string) => void,
 *   onRemove: (drive: any) => void,
 * }} props
 */
export default function DriveEncryptionSheet({ open = true, drive, onClose, onProtect, onRemove }) {
  return (
    <ModalCard open={open && drive != null} onClose={onClose} title="Encryption">
      {({ close }) => drive && <SheetBody drive={drive} close={close} onProtect={onProtect} onRemove={onRemove} />}
    </ModalCard>
  );
}

/** What the drive is, in a word, from what lunad says. */
function stateOf(drive, status) {
  if (!drive.encrypted) return { pill: "Not protected", variant: "default" };
  if (status === "locked" || (status == null && drive.locked)) return { pill: "Protected · Locked", variant: "info" };
  return { pill: "Protected · Unlocked", variant: "success" };
}

function SheetBody({ drive, close, onProtect, onRemove }) {
  const client = useQueryClient();
  const { addToast } = useToast();
  const [view, setView] = useState(/** @type {"home" | "protect" | "change" | "remove"} */ ("home"));
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [current, setCurrent] = useState("");
  const [currentError, setCurrentError] = useState("");
  const [mismatch, setMismatch] = useState("");

  const encryption = useQuery({
    queryKey: ["drive-encryption", drive.id],
    queryFn: () => getJson(`/api/v1/drives/${drive.id}/encryption`),
    refetchInterval: 5000,
  });
  const status = encryption.data?.status ?? null;
  const plugged = status !== "unplugged";
  const erasing = status === "formatting";
  const locked = status === "locked" || (status == null && Boolean(drive.encrypted && drive.locked));
  const state = stateOf(drive, status);
  // Offer protection only when lunad says this drive can take a password.
  // Until it answers, keep the offer (the erase window checks again).
  const canProtect = encryption.data?.can_protect !== false;
  const cantProtectReason = encryption.data?.cant_protect_reason || "";

  const refresh = () => {
    for (const queryKey of [["drives"], ["drive-encryption", drive.id], ["drive-summary", drive.id], ["backups"]]) {
      client.invalidateQueries({ queryKey });
    }
  };

  const lock = useMutation({
    mutationFn: () => postJson(`/api/v1/drives/${drive.id}/lock`, {}),
    onSuccess: () => {
      addToast({ type: "success", message: "Drive locked." });
      setError("");
      refresh();
    },
    onError: (err) => setError(apiErrorMessage(err, "Luna couldn't lock this drive. Try again.")),
  });

  const change = useMutation({
    mutationFn: () => postJson(`/api/v1/drives/${drive.id}/password`, { current_password: current, new_password: password }),
    onSuccess: () => {
      addToast({ type: "success", message: "Password changed." });
      goHome();
      refresh();
    },
    onError: (err) => {
      const code = /** @type {any} */ (err)?.code;
      const message = apiErrorMessage(err, "Luna couldn't change the password. Try again.");
      // The wrong current password belongs under its field; anything else is about the whole sheet.
      if (code === "wrong_password" || code === "too_many_tries") setCurrentError(message);
      else setError(message);
    },
  });

  function goHome() {
    setView("home");
    setError("");
    setCurrentError("");
    setMismatch("");
    setPassword("");
    setAgain("");
    setCurrent("");
  }

  function checkNewPassword() {
    const problem = newPasswordProblem(password, again);
    setMismatch(problem);
    return !problem;
  }

  const busyLine = !plugged ? "Plug it in to change its protection." : erasing ? "Luna is erasing this drive right now. Try again when it finishes." : "";
  const actionsOff = Boolean(busyLine);

  if (view === "protect") {
    return (
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!checkNewPassword()) return;
          const chosen = password;
          // The password leaves this sheet only to go to the erase window.
          close();
          onProtect(drive, chosen);
        }}
      >
        <p className="text-sm">Next, Luna shows what&apos;s on <InlinePill>{drive.label}</InlinePill>, then erases it and sets it up with this password.</p>
        <Callout tone="warning">{NO_RECOVERY}</Callout>
        <NewPasswordFields idPrefix={`protect-${drive.id}`} password={password} again={again} onPassword={(v) => { setPassword(v); setMismatch(""); }} onAgain={(v) => { setAgain(v); setMismatch(""); }} error={mismatch} />
        <div className="flex flex-wrap gap-3">
          <Button type="submit">Continue</Button>
          <Button variant="outline" onClick={goHome}>Back</Button>
        </div>
      </form>
    );
  }

  if (view === "change") {
    return (
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError("");
          setCurrentError("");
          if (!current) { setCurrentError("Enter the current password."); return; }
          if (!checkNewPassword()) return;
          change.mutate();
        }}
      >
        <FormInput label="Current password" name={`current-${drive.id}`} type="password" icon="password" autoComplete="current-password" value={current} onChange={(e) => { setCurrent(e.target.value); setCurrentError(""); }} error={currentError} loading={change.isPending} className="mb-0" />
        <NewPasswordFields idPrefix={`change-${drive.id}`} label="New password" password={password} again={again} onPassword={(v) => { setPassword(v); setMismatch(""); }} onAgain={(v) => { setAgain(v); setMismatch(""); }} error={mismatch} />
        <Callout tone="warning">{NO_RECOVERY}</Callout>
        {error && <InlineError>{error}</InlineError>}
        <div className="flex flex-wrap gap-3">
          <Button type="submit" loading={change.isPending}>Change password</Button>
          <Button variant="outline" onClick={goHome}>Back</Button>
        </div>
      </form>
    );
  }

  if (view === "remove") {
    return (
      <div className="space-y-4">
        <Callout tone="warning">Removing protection erases everything on <InlinePill>{drive.label}</InlinePill>. Luna then sets it up again without a password. This can&apos;t be undone.</Callout>
        <p className="text-sm">Next, Luna shows what&apos;s on the drive so you can check it&apos;s the right one.</p>
        <div className="flex flex-wrap gap-3">
          <Button variant="accent" onClick={() => { close(); onRemove(drive); }}>Remove protection and erase</Button>
          <Button variant="outline" onClick={goHome}>Back</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="surface-primary rounded-large-element p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="font-mono text-base">{drive.label}</p>
          <Pill variant={/** @type {any} */ (state.variant)}>{state.pill}</Pill>
        </div>
        <p className="text-sm">
          {!drive.encrypted
            ? "Its files can be read by anyone who plugs it into a computer."
            : locked
              ? "Its files are unavailable, and backups that use it wait, until someone enters the password."
              : "Its files are open for everyone with access. Lock it to close them until someone enters the password."}
          {!drive.encrypted && <> <InfoHint surface="primary" content="Protecting a drive scrambles everything on it. Without the password, nobody can read the files, on Luna or on any other computer." /></>}
        </p>
        {busyLine && <p className="text-sm">{busyLine}</p>}
      </div>

      {drive.encrypted && locked && plugged && !erasing && (
        <div>
          <p className="text-sm mb-3">Enter the password to open it.</p>
          <UnlockPrompt driveId={drive.id} />
        </div>
      )}

      {error && <InlineError>{error}</InlineError>}

      <div className="flex flex-wrap gap-3">
        {!drive.encrypted ? (
          canProtect && <Button disabled={actionsOff} onClick={() => setView("protect")}>Protect with a password</Button>
        ) : (
          <>
            {!locked && <Button variant="outline" disabled={actionsOff} loading={lock.isPending} onClick={() => { setError(""); lock.mutate(); }}>Lock</Button>}
            <Button variant="outline" disabled={actionsOff} onClick={() => setView("change")}>Change password</Button>
            <Button variant="accent" disabled={actionsOff} onClick={() => setView("remove")}>Remove protection</Button>
          </>
        )}
      </div>
      {!drive.encrypted && !canProtect && cantProtectReason && <p className="text-sm">{cantProtectReason}</p>}
      {!drive.encrypted && canProtect && !actionsOff && <p className="text-xs">Protecting it erases the drive first, so you&apos;ll see what&apos;s on it before anything is lost.</p>}
    </div>
  );
}

DriveEncryptionSheet.propTypes = {
  open: PropTypes.bool,
  drive: PropTypes.object,
  onClose: PropTypes.func.isRequired,
  onProtect: PropTypes.func.isRequired,
  onRemove: PropTypes.func.isRequired,
};
