import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { HardDrive, Lock } from "lucide-react";
import Page from "@libreloom/ui/components/ui/Page.jsx";
import Card from "@libreloom/ui/components/cards/Card.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import EmptyState from "@libreloom/ui/components/common/EmptyState.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import LinearProgress from "@libreloom/ui/components/common/LinearProgress.jsx";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import ModalErrorNotice from "@libreloom/ui/components/common/ModalErrorNotice.jsx";
import { InfoHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import usePageTitle from "../hooks/usePageTitle.js";
import { useAuth } from "../context/AuthContext";
import { apiErrorMessage, getDrives } from "../lib/api";
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
} from "../lib/encryption.js";
import WipeDriveDialog from "../components/drives/WipeDriveDialog.jsx";

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

/** The warning that has to be read before a drive is encrypted. */
const NO_RECOVERY_WARNING =
  "If you forget this password, the files on this drive are gone. Nobody can recover them, including us.";

const PASSWORD_HINT =
  "This drive stays unlocked until you lock it or Luna restarts.";

/**
 * The encryption page: one drive's encryption state, and the only place
 * Encrypt, Decrypt, Unlock and Lock can be started.
 *
 * A route rather than a modal, so progress survives a refresh and a
 * navigation, and so it is a place you return to rather than a dialog you
 * dismiss.
 */
export default function DriveEncryptionPage() {
  const { id } = useParams();
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const drives = useQuery({ queryKey: ["drives"], queryFn: getDrives });
  const drive = (drives.data || []).find((d) => d.id === id);

  const encryption = useQuery({
    queryKey: ["drive-encryption", id],
    queryFn: () => getDriveEncryption(id),
    // A conversion runs for hours; poll while one is in flight so the page
    // notices when it finishes without a refresh.
    refetchInterval: (query) => (query.state.data?.converting ? 5000 : false),
  });

  const data = encryption.data;
  const state = encryptionState(data);
  const copy = encryptionCopy(state, data);

  usePageTitle(drive ? `${drive.label} encryption` : "Encryption");

  // Which dialog is open, if any.
  const [dialog, setDialog] = useState(
    /** @type {null | "unlock" | "encrypt" | "decrypt" | "wipe"} */ (null),
  );

  // The configuration decided before the wipe: the password (encrypting) or
  // just the confirmation (decrypting). Held here so the wipe step can run the
  // request without asking for anything again.
  const [pending, setPending] = useState(
    /** @type {{ direction: "encrypt" | "decrypt" | "reformat", password: string } | null} */ (null),
  );

  const wipePreview = useQuery({
    queryKey: ["drive-wipe-preview", id, pending?.direction],
    queryFn: () => getWipePreview(id, pending?.direction ?? "reformat"),
    // Only needed once the person has asked to wipe.
    enabled: dialog === "wipe" && Boolean(pending),
  });

  const [wiping, setWiping] = useState(false);
  const [wipeError, setWipeError] = useState("");

  /** Run the wipe the person just confirmed. */
  const runWipe = async () => {
    if (!pending || wiping) return;
    setWiping(true);
    setWipeError("");
    try {
      if (pending.direction === "encrypt") {
        await encryptDrive(id, pending.password);
        addToast("success", "Drive wiped and encrypted");
      } else if (pending.direction === "decrypt") {
        await decryptDrive(id, pending.password);
        addToast("success", "Drive wiped and decrypted");
      } else {
        await reformatDrive(id);
        addToast("success", "Drive reformatted");
      }
      setPending(null);
      setDialog(null);
      refresh();
    } catch (e) {
      // Keep the dialog open: the drive is unchanged and the person can retry
      // or cancel, rather than being dropped back with no explanation.
      setWipeError(apiErrorMessage(e));
    } finally {
      setWiping(false);
    }
  };

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["drive-encryption", id] });
    queryClient.invalidateQueries({ queryKey: ["drives"] });
    queryClient.invalidateQueries({ queryKey: ["drive-summary", id] });
  };

  if (!drives.isLoading && !drive) {
    return (
      <Page title="Encryption" titleId="encryption-title">
        <EmptyState
          className="mt-4"
          icon={HardDrive}
          title="Drive not found"
          description="Luna can't find this drive. Make sure it's plugged in."
          action={
            <Button size="sm" variant="primary" asChild>
              <Link to="/files">Go to Files</Link>
            </Button>
          }
        />
      </Page>
    );
  }

  return (
    <Page
      title={drive ? `${drive.label} encryption` : "Encryption"}
      titleId="encryption-title"
      leftContent={(
        <Button size="sm" variant="outline" asChild>
          <Link to={`/files/${id}`}>Back to files</Link>
        </Button>
      )}
    >
      <div className="mt-4 flex max-w-xl flex-col gap-4">
        <Card icon={state === "locked" ? Lock : HardDrive} title={copy.title}>
          <p className="text-primary text-sm">{copy.body}</p>

          {state === "encrypting" || state === "decrypting" ? (
            <div className="mt-3">
              <LinearProgress active label={copy.title} />
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {state === "unencrypted" && isAdmin && (
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
                  onClick={() => {
                    setPending({ direction: "reformat", password: "" });
                    setDialog("wipe");
                  }}
                >
                  Reformat
                </Button>
              </>
            )}
            {state === "locked" && (
              <Button size="sm" variant="primary" onClick={() => setDialog("unlock")}>
                Unlock
              </Button>
            )}
            {state === "unlocked" && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    lockDrive(id)
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
        </Card>

        {state === "unencrypted" && data && !data.can_encrypt && data.cannot_encrypt_reason ? (
          <PageNotice variant="warning">
            <p>{data.cannot_encrypt_reason}</p>
          </PageNotice>
        ) : null}

        {state === "unencrypted" ? (
          <p className="text-secondary text-sm">
            An encrypted drive can only be read by a Luna. Reading it on another
            computer needs an app that does not exist yet.
            <InfoHint
              surface="primary"
              content="Until that app ships, keep the password somewhere safe and unlock the drive in Luna."
            />
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
            await unlockDrive(id, password);
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
            // Configuration first: the password is decided here, and the wipe
            // is the next step rather than something this dialog performs.
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
          // A different drive must start its own wait, so the dialog is
          // remounted rather than reused.
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
    </Page>
  );
}

/**
 * One dialog for every password the page needs: unlock, resume, encrypt and
 * decrypt differ only in their words.
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
function PasswordDialog({
  title,
  confirmLabel,
  hint,
  warning,
  confirmTwice = false,
  onClose,
  onSubmit,
}) {
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
      setBusy(false);
    }
  };

  return (
    <ModalCard
      title={title}
      onClose={onClose}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={!canSubmit || busy}>
            {busy ? "Working…" : confirmLabel}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-3">
        {warning ? (
          <PageNotice variant="warning">
            <p>{warning}</p>
          </PageNotice>
        ) : null}
        <label className="flex flex-col gap-1">
          <span className="text-primary text-sm">Password</span>
          <input
            type="password"
            className="w-full rounded-pill surface-primary border-2 border-secondary/30 px-4 py-2 text-sm focus:border-accent"
            value={password}
            autoFocus
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
        </label>
        {confirmTwice ? (
          <label className="flex flex-col gap-1">
            <span className="text-primary text-sm">Password again</span>
            <input
              type="password"
              className="w-full rounded-pill surface-primary border-2 border-secondary/30 px-4 py-2 text-sm focus:border-accent"
              value={again}
              onChange={(e) => setAgain(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
          </label>
        ) : null}
        {mismatch ? (
          <p className="text-primary text-sm">Those two passwords don't match.</p>
        ) : null}
        {hint ? <p className="text-primary text-sm">{hint}</p> : null}
        {error ? <ModalErrorNotice error={error} /> : null}
      </div>
    </ModalCard>
  );
}
