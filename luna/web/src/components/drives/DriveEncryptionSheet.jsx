import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import InlineError from "@libreloom/ui/components/common/InlineError.jsx";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { useAuth } from "../../context/AuthContext";
import { apiErrorMessage } from "../../lib/api";
import { changeDrivePassword, getDriveEncryption, lockDrive, unlockDrive } from "../../lib/encryption.js";
const inputClass = "mt-2 w-full rounded-pill surface-primary border-2 border-secondary/30 px-4 py-2 text-sm focus:border-accent";
export default function DriveEncryptionSheet({
  drive,
  open,
  onClose,
  onFormat
}) {
  const id = drive?.id || "";
  const {
    user
  } = useAuth();
  const {
    addToast
  } = useToast();
  const client = useQueryClient();
  const [mode, setMode] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const query = useQuery({
    queryKey: ["drive-encryption", id],
    queryFn: () => getDriveEncryption(id),
    enabled: open && !!id,
    refetchInterval: q => q.state.data?.converting ? 2000 : false
  });
  useEffect(() => {
    if (!open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear password fields when the sheet closes
      setMode("");
      setPassword("");
      setNewPassword("");
      setConfirm("");
      setError("");
    }
  }, [open, id]);
  const data = query.data;
  const unavailable = data?.encrypted && data.status === "unavailable";
  const run = async action => {
    setError("");
    if (action === "password" && (!newPassword || newPassword !== confirm)) {
      setError("The new passwords must match.");
      haptic("error");
      return;
    }
    setBusy(true);
    try {
      if (action === "unlock") await unlockDrive(id, password);
      if (action === "lock") await lockDrive(id);
      if (action === "password") await changeDrivePassword(id, password, newPassword);
      await Promise.all([client.invalidateQueries({
        queryKey: ["drive-encryption", id]
      }), client.invalidateQueries({
        queryKey: ["drives"]
      })]);
      setMode("");
      setPassword("");
      setNewPassword("");
      setConfirm("");
      addToast({
        type: "success",
        message: action === "unlock" ? "Drive unlocked." : action === "lock" ? "Drive locked." : "Drive password changed."
      });
    } catch (err) {
      haptic("error");
      setError(apiErrorMessage(err, `Could not ${action === "password" ? "change the password" : action + " this drive"}.`));
    } finally {
      setBusy(false);
    }
  };
  return <ModalCard open={open} onClose={onClose} title={drive ? `${drive.label} encryption` : "Encryption"}>
    {() => <div className="space-y-4">
      {query.isLoading && <p role="status">Checking encryption…</p>}
      {query.isError && <><InlineError>Could not check encryption for this drive.</InlineError><Button variant="outline" onClick={() => query.refetch()}>Try again</Button></>}
      {!query.isError && data && <>
        <div className="surface-primary rounded-large-element p-4 space-y-2">
          <h3 className="font-mono text-base">{!data.present ? "Disconnected" : unavailable ? "Unavailable" : data.converting ? "Formatting" : !data.encrypted ? "Not encrypted" : data.unlocked ? "Encrypted and unlocked" : "Encrypted and locked"}</h3>
          <p className="text-sm">{!data.present ? "Connect this drive to manage its encryption." : unavailable ? "Luna cannot open this drive right now. Check that it is connected and try again." : data.converting ? "This drive is unavailable while formatting finishes." : !data.encrypted ? "Anyone who plugs in this drive can read its files." : data.unlocked ? "This drive is available to people who already have access." : "Unlock this drive to make it available to people who already have access."}</p>
        </div>
        {data.present && !data.converting && !data.encrypted && user?.role === "admin" && <><p className="text-sm">Setting up encryption formats the whole drive and erases all its files.</p><Button variant="accent" onClick={() => onFormat(drive, true)}>Set up encryption</Button></>}
        {data.present && !data.converting && !unavailable && data.encrypted && <>
          {!data.unlocked && mode !== "unlock" && <Button onClick={() => {
            setMode("unlock");
            setError("");
          }}>Unlock</Button>}
          {data.unlocked && !mode && <div className="flex gap-2 flex-wrap"><Button variant="outline" haptic="warning" onClick={() => setMode("lock")}>Lock</Button>{user?.role === "admin" && <Button variant="outline" onClick={() => setMode("password")}>Change password</Button>}</div>}
          {mode === "lock" && <div className="surface-primary rounded-large-element p-4 space-y-3">
            <p className="text-sm">Locking this drive makes its files unavailable to everyone who has access until someone unlocks it.</p>
            {error && <InlineError>{error}</InlineError>}
            <div className="flex gap-2"><Button variant="accent" loading={busy} onClick={() => run("lock")}>Lock drive</Button><Button variant="outline" surface="primary" onClick={() => {
                setMode("");
                setError("");
              }}>Cancel</Button></div>
          </div>}
          {(mode === "unlock" || mode === "password") && <form className="space-y-3" onSubmit={e => {
            e.preventDefault();
            run(mode);
          }}>
            <label className="block text-sm">{mode === "unlock" ? "Drive password" : "Current password"}<input className={inputClass} type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required /></label>
            {mode === "password" && <><label className="block text-sm">New password<input className={inputClass} type="password" autoComplete="new-password" value={newPassword} onChange={e => setNewPassword(e.target.value)} required /></label><label className="block text-sm">Confirm new password<input className={inputClass} type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} required /></label></>}
            {error && <InlineError>{error}</InlineError>}
            <div className="flex gap-2"><Button type="submit" loading={busy}>{mode === "unlock" ? "Unlock" : "Change password"}</Button><Button variant="outline" onClick={() => {
                setMode("");
                setError("");
              }}>Cancel</Button></div>
          </form>}
          {!mode && error && <InlineError>{error}</InlineError>}
        </>}
        {data.present && !data.converting && data.encrypted && user?.role === "admin" && <div className="surface-primary rounded-large-element p-4 space-y-3"><p className="text-sm">Formatting without encryption erases all files and partitions on the whole drive.</p><Button variant="outline" surface="primary" onClick={() => onFormat(drive, false)}>Format without encryption</Button></div>}
      </>}
    </div>}
  </ModalCard>;
}
