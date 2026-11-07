import { useEffect, useRef, useState } from "react";
import { HardDrive, Lock } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import ModalCard, { NESTED_OVERLAY_CLASS } from "@libreloom/ui/components/cards/ModalCard.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import Pill from "@libreloom/ui/components/common/Pill.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import LinearProgress from "@libreloom/ui/components/common/LinearProgress.jsx";
import { InfoHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { useAuth } from "../../context/AuthContext";
import { apiErrorMessage } from "../../lib/api";
import {
  decryptDrive,
  encryptDrive,
  encryptionCopy,
  encryptionState,
  getDriveEncryption,
  getWipePreview,
  lockDrive,
  reformatDrive,
  unlockDrive,
} from "../../lib/encryption.js";
import WipeDriveDialog from "./WipeDriveDialog.jsx";

/** What the wipe dialog is called, per direction. */
const WIPE_TITLES = {
  encrypt: "Wipe and encrypt?",
  decrypt: "Wipe and decrypt?",
  reformat: "Wipe this drive?",
};

/** The button that performs the wipe, per direction. */
const WIPE_LABELS = {
  encrypt: "Wipe and encrypt",
  decrypt: "Wipe and decrypt",
  reformat: "Wipe",
};

const NO_RECOVERY_WARNING =
  "If you forget this password, the files on this drive are gone. Nobody can recover them, including us.";

const PASSWORD_HINT = "This drive stays unlocked until you lock it or Luna restarts.";

const STATE_PILL = {
  unencrypted: { variant: "muted", label: "Not encrypted" },
  encrypting: { variant: "info", label: "Encrypting" },
  decrypting: { variant: "info", label: "Decrypting" },
  locked: { variant: "warning", label: "Locked" },
  unlocked: { variant: "success", label: "Encrypted" },
};

/**
 * One drive's encryption, as a sheet opened from the drive card — the same
 * modal shape as Backups and Sharing. A conversion can outlive the sheet;
 * closing it does not stop the format, and the card keeps showing the state.
 *
 * @param {{
 *   drive: { id: string, label: string } | null,
 *   open: boolean,
 *   onClose: () => void,
 * }} props
 */
export default function DriveEncryptionSheet({ drive, open, onClose }) {
  const driveId = drive?.id || "";
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const encryption = useQuery({
    queryKey: ["drive-encryption", driveId],
    queryFn: () => getDriveEncryption(driveId),
    enabled: open && Boolean(driveId),
    refetchInterval: (query) =>
      query.state.data?.converting || wipeJobRef.current ? 1500 : false,
  });

  const data = encryption.data;
  const state = encryptionState(data);
  const copy = encryptionCopy(state, data);
  const pill = STATE_PILL[state] || STATE_PILL.unencrypted;

  const [dialog, setDialog] = useState(
    /** @type {null | "unlock" | "encrypt" | "decrypt" | "wipe"} */ (null),
  );
  const [pending, setPending] = useState(
    /** @type {{ direction: "encrypt" | "decrypt" | "reformat", password: string } | null} */ (null),
  );
  const wipePreview = useQuery({
    queryKey: ["drive-wipe-preview", driveId, pending?.direction],
    queryFn: () => getWipePreview(driveId, pending?.direction ?? "reformat"),
    enabled: open && dialog === "wipe" && Boolean(pending),
  });

  const [wiping, setWiping] = useState(false);
  const [wipeError, setWipeError] = useState("");
  const [wipeJob, setWipeJob] = useState(
    /** @type {null | { direction: "encrypt" | "decrypt" | "reformat" }} */ (null),
  );
  const wipeJobRef = useRef(wipeJob);
  wipeJobRef.current = wipeJob;
  const wipeSawRunning = useRef(false);
  const wipeGraceDone = useRef(false);

  useEffect(() => {
    if (!wipeJob) {
      wipeGraceDone.current = false;
      return undefined;
    }
    const timer = setTimeout(() => {
      wipeGraceDone.current = true;
    }, 4000);
    return () => clearTimeout(timer);
  }, [wipeJob]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["drive-encryption", driveId] });
    queryClient.invalidateQueries({ queryKey: ["drives"] });
    queryClient.invalidateQueries({ queryKey: ["drive-summary", driveId] });
  };

  const runWipe = async () => {
    if (!pending || wiping) return;
    setWiping(true);
    setWipeError("");
    try {
      if (pending.direction === "encrypt") {
        await encryptDrive(driveId, pending.password);
      } else if (pending.direction === "decrypt") {
        await decryptDrive(driveId, pending.password);
      } else {
        await reformatDrive(driveId);
      }
      // The format is still running on Luna. Poll until the drive reports a
      // finished state before saying it worked.
      wipeSawRunning.current = false;
      setWipeJob({ direction: pending.direction });
      setPending(null);
      setDialog(null);
      refresh();
    } catch (e) {
      setWipeError(apiErrorMessage(e));
    } finally {
      setWiping(false);
    }
  };

  // Report the outcome only once the drive itself says the format finished.
  useEffect(() => {
    if (!wipeJob || !data) return;
    if (data.converting) {
      wipeSawRunning.current = true;
      return;
    }
    if (!wipeSawRunning.current && !wipeGraceDone.current) return;
    const finished = wipeJob.direction === "encrypt"
      ? data.encrypted === true
      : (data.encrypted ?? false) === false;
    const verb = wipeJob.direction === "encrypt"
      ? "encrypt"
      : wipeJob.direction === "decrypt"
        ? "decrypt"
        : "reformat";
    if (!finished) {
      addToast(
        "error",
        `Luna couldn't finish ${verb === "encrypt" ? "encrypting" : verb === "decrypt" ? "decrypting" : "reformatting"} this drive.`,
        "The drive may not open until it is formatted again from Files.",
      );
    } else {
      addToast("success", verb === "encrypt" ? "Drive encrypted" : verb === "decrypt" ? "Drive decrypted" : "Drive reformatted");
    }
    setWipeJob(null);
    refresh();
  }, [addToast, data, driveId, queryClient, wipeJob]);

  const working = Boolean(wipeJob) || state === "encrypting" || state === "decrypting";

  return (
    <ModalCard
      open={open}
      title={drive ? `${drive.label} encryption` : "Encryption"}
      onClose={onClose}
      size="md"
    >
      <div className="space-y-4">
        <section className="rounded-large-element surface-primary p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Pill variant={pill.variant}>{pill.label}</Pill>
            {state === "unlocked" ? (
              <span className="inline-flex items-center gap-1 text-sm">
                <Lock size={14} aria-hidden="true" />
                Stays open until locked or restarted
              </span>
            ) : null}
          </div>
          <p className="text-sm">{copy.body}</p>

          {wipeJob && !data?.converting ? (
            <p className="text-sm">
              Luna is starting the format. The drive is not ready to use until this finishes — you
              can close this sheet.
            </p>
          ) : null}

          {working ? <LinearProgress active label={wipeJob ? "Formatting this drive" : copy.title} /> : null}

          <div className="flex flex-wrap items-center gap-2">
            {state === "unencrypted" && isAdmin && !working && (
              <>
                <Button
                  size="sm"
                  variant="accent"
                  disabled={!data?.can_encrypt}
                  onClick={() => setDialog("encrypt")}
                >
                  Encrypt this drive
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  surface="primary"
                  onClick={() => {
                    setPending({ direction: "reformat", password: "" });
                    setDialog("wipe");
                  }}
                >
                  Reformat
                </Button>
              </>
            )}
            {state === "locked" && !working && (
              <Button size="sm" variant="secondary" onClick={() => setDialog("unlock")}>
                Unlock
              </Button>
            )}
            {state === "unlocked" && !working && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  surface="primary"
                  onClick={() => {
                    lockDrive(driveId)
                      .then(() => {
                        addToast("success", "Drive locked");
                        refresh();
                      })
                      .catch((e) => addToast("error", "Couldn't lock this drive", apiErrorMessage(e)));
                  }}
                >
                  Lock
                </Button>
                {isAdmin && (
                  <Button size="sm" variant="accent" onClick={() => setDialog("decrypt")}>
                    Decrypt
                  </Button>
                )}
              </>
            )}
          </div>
        </section>

        {state === "unencrypted" && data && !data.can_encrypt && data.cannot_encrypt_reason ? (
          <PageNotice variant="warning">
            <p>{data.cannot_encrypt_reason}</p>
          </PageNotice>
        ) : null}

        {state === "unencrypted" ? (
          <p className="flex items-start gap-1.5 text-sm">
            <HardDrive size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>
              An encrypted drive can only be read by a Luna. Reading it on another computer needs an
              app that does not exist yet.
              <InfoHint
                surface="secondary"
                content="Until that app ships, keep the password somewhere safe and unlock the drive in Luna."
              />
            </span>
          </p>
        ) : null}
      </div>

      {dialog === "unlock" && (
        <PasswordDialog
          title={`Unlock ${drive?.label ?? "drive"}`}
          confirmLabel="Unlock"
          hint={PASSWORD_HINT}
          onClose={() => setDialog(null)}
          onSubmit={async (password) => {
            await unlockDrive(driveId, password);
            addToast("success", "Drive unlocked");
            setDialog(null);
            refresh();
          }}
        />
      )}

      {dialog === "encrypt" && (
        <PasswordDialog
          title="Encrypt this drive"
          confirmLabel="Continue"
          warning={NO_RECOVERY_WARNING}
          hint="Luna needs this password to open the drive after it restarts."
          confirmTwice
          onClose={() => setDialog(null)}
          onSubmit={async (password) => {
            setPending({ direction: "encrypt", password });
            setDialog("wipe");
          }}
        />
      )}

      {dialog === "decrypt" && (
        <PasswordDialog
          title="Decrypt this drive"
          confirmLabel="Continue"
          warning="After this, anyone who plugs this drive in can read its files."
          hint="Enter the password to confirm it's you."
          onClose={() => {
            setPending(null);
            setDialog(null);
          }}
          onSubmit={async (password) => {
            setPending({ direction: "decrypt", password });
            setDialog("wipe");
          }}
        />
      )}

      {dialog === "wipe" && pending ? (
        <WipeDriveDialog
          key={wipePreview.data?.drive_id ?? "pending"}
          title={WIPE_TITLES[pending.direction]}
          confirmLabel={WIPE_LABELS[pending.direction]}
          preview={wipePreview.data}
          loading={wipePreview.isLoading}
          busy={wiping}
          error={wipeError}
          onClose={() => {
            setPending(null);
            setWipeError("");
            setDialog(null);
          }}
          onConfirm={runWipe}
        />
      ) : null}
    </ModalCard>
  );
}

/**
 * One dialog for every password the sheet needs: unlock, encrypt and decrypt
 * differ only in their words.
 *
 * @param {{
 *   title: string,
 *   confirmLabel: string,
 *   hint?: string,
 *   warning?: string,
 *   confirmTwice?: boolean,
 *   onClose: () => void,
 *   onSubmit: (password: string) => Promise<void>,
 * }} props
 */
function PasswordDialog({ title, confirmLabel, hint, warning, confirmTwice = false, onClose, onSubmit }) {
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const mismatch = confirmTwice && again.length > 0 && password !== again;
  const canSubmit = password.length > 0 && (!confirmTwice || (again.length > 0 && !mismatch));

  const submit = async () => {
    if (!canSubmit || busy) return;
    setBusy(true);
    setError("");
    try {
      await onSubmit(password);
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalCard
      open
      title={title}
      onClose={onClose}
      overlayClassName={NESTED_OVERLAY_CLASS}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={busy} disabled={!canSubmit}>
            {confirmLabel}
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        {warning ? (
          <PageNotice variant="warning">
            <p>{warning}</p>
          </PageNotice>
        ) : null}
        {hint ? <p className="text-primary text-sm">{hint}</p> : null}
        <label className="block text-sm text-primary">
          Password
          <input
            type="password"
            className="mt-1 w-full rounded-pill surface-primary border-2 border-secondary/30 px-4 py-2 text-sm"
            value={password}
            onChange={(e) => {
              setError("");
              setPassword(e.target.value);
            }}
            autoComplete="off"
            autoFocus
          />
        </label>
        {confirmTwice ? (
          <label className="block text-sm text-primary">
            Password again
            <input
              type="password"
              className="mt-1 w-full rounded-pill surface-primary border-2 border-secondary/30 px-4 py-2 text-sm"
              value={again}
              onChange={(e) => {
                setError("");
                setAgain(e.target.value);
              }}
              autoComplete="off"
            />
          </label>
        ) : null}
        {mismatch ? <p className="text-sm text-primary" role="alert">Those two passwords don't match.</p> : null}
        {error ? <p className="text-sm text-primary" role="alert">{error}</p> : null}
      </div>
    </ModalCard>
  );
}
