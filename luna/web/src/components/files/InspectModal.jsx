import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import InlineError from "@libreloom/ui/components/common/InlineError.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import { InfoHint, TermHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import Callout from "@libreloom/ui/components/common/Callout.jsx";
import NewPasswordFields from "../drives/NewPasswordFields.jsx";
import UnlockPrompt from "../drives/UnlockPrompt.jsx";
import { newPasswordProblem } from "../../lib/driveCrypt.js";
import { ROOT_TERM_HINT } from "../../lib/rootTerm.js";
import { describeInspectSummary } from "../../lib/fileCounts.js";
export default function InspectModal({
  open = true,
  drive,
  result,
  error,
  onClose,
  onAdopt,
  onErase = null,
  onProtect = null,
  onBeforeUnlock = undefined,
  adoptError,
  adopting
}) {
  const [label, setLabel] = useState("");
  // "inspect" is the look at the drive; "protect" asks for the password the erase will set.
  const [view, setView] = useState("inspect");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [problem, setProblem] = useState("");
  useEffect(() => {
    if (open && drive) {
      /* eslint-disable react-hooks/set-state-in-effect -- seed the draft for each inspected drive */
      setLabel(drive.model || "My drive");
      setView("inspect");
      setPassword("");
      setAgain("");
      setProblem("");
      /* eslint-enable react-hooks/set-state-in-effect */
    }
  }, [open, drive]);
  return <ModalCard open={open} onClose={onClose} title={<span className="inline-flex items-center gap-2 flex-wrap">{`Add ${drive?.model || drive?.name || "drive"}`}<InfoHint label="What happens when you add a drive" content="Luna shows what's on the drive first. Nothing is changed until you confirm." /></span>}>
    {({
      close
    }) => view === "protect" ? <form className="space-y-4" onSubmit={e => {
      e.preventDefault();
      const message = newPasswordProblem(password, again);
      setProblem(message);
      if (message) return;
      // Hands over to the erase window; the password stays in memory only until then.
      Promise.resolve(onProtect(drive, password)).catch(() => {});
    }}>
      <p className="text-sm">Luna will show what&apos;s on this drive, then erase it and set it up with the password you choose here.</p>
      <Callout tone="warning">There is no way to get this password back. If you forget it, the files on this drive are lost.</Callout>
      <NewPasswordFields idPrefix="add-protect" password={password} again={again} onPassword={v => { setPassword(v); setProblem(""); }} onAgain={v => { setAgain(v); setProblem(""); }} error={problem} />
      <div className="flex flex-wrap gap-3">
        <Button type="submit">Continue</Button>
        <Button variant="outline" onClick={() => { setView("inspect"); setPassword(""); setAgain(""); setProblem(""); }}>Back</Button>
      </div>
    </form> : <div className="space-y-4">
      {!result && !error && <p role="status">Checking the drive…</p>}
      {error && <InlineError>{error}</InlineError>}
      {result && <>
        {!result.encrypted && !result.needs_setup && result.readable && <p className="text-sm">{describeInspectSummary(result)}</p>}
        {result.entries?.length > 0 && <div className="surface-primary rounded-large-element p-4"><p className="font-mono text-sm">On this drive</p><ul className="mt-2 space-y-1">{result.entries.map(entry => <li key={`${entry.kind}:${entry.name}`}><InlinePill>{entry.name}</InlinePill></li>)}</ul>{Number(result.files) + Number(result.folders) > result.entries.length && <p className="text-secondary text-xs mt-2">Showing items at the <TermHint content={ROOT_TERM_HINT} surface="primary">root</TermHint> of the drive.</p>}</div>}
        {result.encrypted ? <>
          <p className="text-sm">This drive is protected with a password. Enter it to add the drive.</p>
          <UnlockPrompt deviceName={drive?.name} beforeSend={onBeforeUnlock} onUnlocked={() => close()} buttonLabel="Unlock and add" />
          {onErase && <div className="surface-primary rounded-large-element p-4 space-y-3">
            <p className="text-sm">Don&apos;t know the password? There is no way to get it back. You can erase the drive and start over, but everything on it is lost.</p>
            <Button variant="accent" surface="primary" onClick={() => Promise.resolve(onErase(drive)).catch(() => {})}>Erase and start over</Button>
          </div>}
        </> : result.needs_setup || !result.readable ? <>
          <p className="text-sm">Luna can't use this drive as it is. It has to be erased first, which removes everything on it.</p>
          {onErase && <Button variant="accent" onClick={() => Promise.resolve(onErase(drive)).catch(() => {})}>Erase and set up</Button>}
          {/* Protect with a password asks for the password first, so the one erase also sets it. */}
          {onErase && onProtect && <Button variant="outline" onClick={() => setView("protect")}>Protect with a password</Button>}
        </> : result.writable ? <>
          <div className="flex items-center gap-3">
            <Info size={18} className="shrink-0" aria-hidden="true" />
            <p className="text-sm">Adding it writes a <InlinePill>.luna</InlinePill> database file at the <TermHint content={ROOT_TERM_HINT}>root</TermHint> of the drive. Your files are untouched.</p>
          </div>
          <label className="block text-sm">Drive name<input className="mt-2 w-full rounded-pill surface-primary border-2 border-secondary/30 px-4 py-2 text-sm no-focus-outline focus:border-accent" value={label} maxLength={80} placeholder="e.g. Photos drive" onChange={e => setLabel(e.target.value)} /></label>
          {adoptError && <InlineError>{adoptError}</InlineError>}
          <Button loading={adopting} onClick={() => Promise.resolve(onAdopt(label)).then(close).catch(() => {})}>Add this drive</Button>
        </> : <p className="text-sm">Luna can't save files to this drive right now. If it has a lock switch, slide it to unlock, then try again.</p>}
      </>}
    </div>}
  </ModalCard>;
}
