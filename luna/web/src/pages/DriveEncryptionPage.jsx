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
  lockDrive,
  unlockDrive,
} from "../lib/encryption.js";

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
    /** @type {null | "unlock" | "encrypt" | "decrypt"} */ (null),
  );

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
              <Button
                size="sm"
                variant="accent"
                disabled={!data?.can_encrypt}
                onClick={() => setDialog("encrypt")}
              >
                Encrypt this drive
              </Button>
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
            {state === "interrupted" && (
              <Button size="sm" variant="primary" onClick={() => setDialog("unlock")}>
                Resume
              </Button>
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
          title={state === "interrupted" ? "Resume encryption" : `Unlock ${drive?.label ?? "drive"}`}
          confirmLabel={state === "interrupted" ? "Resume" : "Unlock"}
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
          confirmLabel="Encrypt"
          warning={NO_RECOVERY_WARNING}
          hint="Luna needs this password to open the drive after it restarts."
          confirmTwice
          onClose={() => setDialog(null)}
          onSubmit={async (password) => {
            await encryptDrive(id, password);
            addToast("success", "Encryption started");
            setDialog(null);
            refresh();
          }}
        />
      )}

      {dialog === "decrypt" && (
        <PasswordDialog
          title="Decrypt this drive"
          confirmLabel="Decrypt"
          warning="After this, anyone who plugs this drive in can read its files."
          hint="Enter the password to confirm it's you."
          onClose={() => setDialog(null)}
          onSubmit={async (password) => {
            await decryptDrive(id, password);
            addToast("success", "Decryption started");
            setDialog(null);
            refresh();
          }}
        />
      )}
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
