/**
 * InspectModal — shared drive-inspection / add-drive wizard.
 *
 * Shown after Luna scans a newly plugged-in drive. Presents contents, lets
 * the user name the drive, and confirms the adopt. Nothing on the drive is
 * changed until the user clicks the final confirm button.
 *
 * Used by FilesPage (Unrecognized drives section).
 */
import { useEffect, useRef, useState } from "react";
import { File as FileIcon, Folder, Info, TriangleAlert } from "lucide-react";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import Spinner from "@libreloom/ui/components/ui/Spinner.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import { InfoHint, TermHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { ROOT_TERM_HINT } from "../../lib/rootTerm.js";
import { describeInspectSummary } from "../../lib/fileCounts.js";
import { previewFromInspection } from "../../lib/wipeCopy.js";
import WipeDriveDialog from "../drives/WipeDriveDialog.jsx";

/**
 * @param {{
 *   open: boolean,
 *   drive: any,
 *   result: any,
 *   error: string | null,
 *   onClose: () => void,
 *   onAdopt: (label: string, erase: boolean) => Promise<any>,
 *   adoptError: string | null,
 *   adopting: boolean,
 * }} props
 */
export default function InspectModal({ open = true, drive, result, error, onClose, onAdopt, adoptError, adopting }) {
  const driveSnapRef = useRef(drive);
  if (drive) driveSnapRef.current = drive;
  const shownDrive = drive || driveSnapRef.current;

  const [label, setLabel] = useState(shownDrive?.model || "My Drive");
  const [confirmErase, setConfirmErase] = useState(false);
  const [confirmFormat, setConfirmFormat] = useState(false);
  /**
   * Which wipe the person has asked for, if any. Both destructive paths —
   * erasing installer media and formatting a drive Luna can't write — hand off
   * to the one shared wipe dialog, so the waiting rule is the same here as on
   * the encryption page.
   * @type {[null | "erase" | "format", Function]}
   */
  const [wipe, setWipe] = useState(null);

  useEffect(() => {
    if (open && drive) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- props/open seed draft UI state
      setLabel(drive.model || "My Drive");
      setConfirmErase(false);
      setConfirmFormat(false);
      setWipe(null);
    }
  }, [open, drive]);

  if (!shownDrive) return null;

  const needsErase = Boolean(result?.needs_erase);
  const canUse = Boolean(result) && result.readable && (result.writable || needsErase);
  const offerFormat = Boolean(result) && result.readable && !result.writable && !needsErase;
  const blockedReason = result && !canUse
    ? (!result.readable
      ? "Luna could not read this drive. Make sure it is plugged in firmly and try again."
      : "This drive won't accept new files right now — it may have a write-lock switch, or need formatting.")
    : null;
  const blockedHint = result && !canUse && result.readable
    ? "Usually this means a filesystem issue, or a write-lock switch on the drive. If there's a switch, flip it and try again."
    : null;

  // The one wipe dialog, fed from the inspection this flow already made. A
  // drive that has not been added yet has no id to fetch a preview with, and
  // does not need one: `inspect` measured the same thing and applied the same
  // rule, so the wait here matches every other wipe.
  const wipePreview = previewFromInspection(result, label);

  /** Perform the wipe the person confirmed in the shared dialog. */
  const runWipe = () =>
    Promise.resolve(onAdopt(label, true))
      // `onClose` is the caller's, which tears down the whole Add-drive flow.
      // The dialog's own `close` is not in scope out here.
      .then(() => onClose())
      .catch(() => {});

  return (
    <>
    <ModalCard
      open={open}
      onClose={onClose}
      title={
        <span className="inline-flex items-center gap-2 flex-wrap">
          {`Add ${shownDrive.model || shownDrive.name}`}
          <InfoHint
            label="What happens when you add a drive"
            content="Luna shows what's on the drive first. Nothing is changed until you confirm."
          />
        </span>
      }
    >
      {({ close }) => (
        <>
          {!result && !error && (
            <div className="flex items-center gap-3 text-primary" role="status">
              <Spinner size="sm" decorative className="text-primary shrink-0" />
              <p className="text-sm">Checking the drive…</p>
            </div>
          )}

          {error && (
            <>
              <p className="text-primary text-sm">{error}</p>
              <div className="mt-4"><Button variant="outline" onClick={close}>Close</Button></div>
            </>
          )}

          {result && (
            <>
              <p className="text-primary text-sm">
                {describeInspectSummary(result)}
              </p>
              {Array.isArray(result.entries) && result.entries.length > 0 && (
                <div className="mt-3 rounded-large-element surface-primary p-3">
                  <p className="text-xs font-mono mb-2">
                    On this drive
                  </p>
                  <ul
                    className="grid gap-1.5 max-h-40 overflow-y-auto"
                    aria-label="What's on this drive"
                  >
                    {result.entries.map((entry) => {
                      const isFolder = entry.kind === "folder" || entry.kind === "dir";
                      return (
                        <li
                          key={`${entry.kind}:${entry.name}`}
                          className="flex items-center gap-2 text-sm font-mono min-w-0"
                        >
                          {isFolder ? (
                            <Folder size={14} className="shrink-0" aria-hidden="true" />
                          ) : (
                            <FileIcon size={14} className="shrink-0" aria-hidden="true" />
                          )}
                          <span className="truncate">{entry.name}</span>
                        </li>
                      );
                    })}
                  </ul>
                  {(Number(result.folders) + Number(result.files) > result.entries.length) && (
                    <p className="text-secondary text-xs mt-2">
                      Showing items at the{" "}
                      <TermHint content={ROOT_TERM_HINT} surface="primary">
                        root
                      </TermHint>{" "}
                      of the drive
                      {result.entries.length >= 24 ? " (first 24)" : ""}.
                      Add it to open folders and see everything.
                    </p>
                  )}
                </div>
              )}
              {needsErase ? (
                <div className="mt-4 flex items-center gap-3">
                  <TriangleAlert size={18} className="text-warning shrink-0" />
                  <p className="text-primary text-xs">
                    {result.fs_type
                      ? "If you have moved any files you want to keep off this drive, choose Erase and add this drive. That deletes everything on it so Luna can use it for your photos and files."
                      : "Luna can't read this drive: it may be new, damaged, or in another format. Erasing it deletes everything on it so Luna can use it."}
                  </p>
                </div>
              ) : blockedReason ? (
                <div className="mt-4 space-y-3">
                  <div className="flex items-start gap-3">
                    <TriangleAlert size={18} className="text-warning shrink-0 mt-0.5" />
                    <span className="text-primary text-xs">
                      {blockedReason}
                      {blockedHint && " "}
                      {blockedHint && <InfoHint label="Why this happens" content={blockedHint} />}
                    </span>
                  </div>
                  {offerFormat && (
                    <>
                      {confirmFormat && (
                        <>
                          <p className="text-primary text-xs">
                            Formatting deletes everything on this drive.
                          </p>
                          <label className="block">
                            <span className="block translate-x-5 text-primary text-xs">What should Luna call this drive?</span>
                            <input
                              className="mt-2 w-full rounded-pill surface-primary border-2 border-secondary/30 px-4 py-2 text-sm no-focus-outline focus:outline-none focus:border-secondary"
                              value={label}
                              maxLength={80}
                              placeholder="e.g. Photos drive"
                              onChange={(e) => setLabel(e.target.value)}
                            />
                          </label>
                        </>
                      )}
                      {adoptError && confirmFormat && (
                        <PageNotice variant="error">{adoptError}</PageNotice>
                      )}
                      <div className="flex gap-3 flex-wrap">
                        {!confirmFormat ? (
                          <Button variant="danger" haptic="warning" onClick={() => setConfirmFormat(true)}>
                            Format
                          </Button>
                        ) : (
                          <Button
                            variant="danger"
                            haptic="warning"
                            loading={adopting}
                            onClick={() => setWipe("format")}
                          >
                            Yes, format it
                          </Button>
                        )}
                        <Button variant="outline" onClick={close}>Close</Button>
                      </div>
                    </>
                  )}
                </div>
              ) : result.has_marker ? (
                <p className="text-primary text-sm mt-2">
                  This drive was used with a Luna before — add it here to keep using
                  the files. Luna only updates its on-drive database.
                </p>
              ) : (
                <div className="mt-4 flex items-center gap-3">
                  <Info size={18} className="shrink-0" aria-hidden="true" />
                  <p className="text-primary text-xs">
                    Adding it writes a <InlinePill>.luna</InlinePill> database
                    file at the{" "}
                    <TermHint content={ROOT_TERM_HINT}>root</TermHint> of the drive.
                    Your files are untouched.
                  </p>
                </div>
              )}
              {canUse && (
                <>
                  <label className="block mt-4">
                    <span className="block translate-x-5 text-primary text-xs">What should Luna call this drive?</span>
                    <input
                      className="mt-2 w-full rounded-pill surface-primary border-2 border-secondary/30 px-4 py-2 text-sm no-focus-outline focus:outline-none focus:border-secondary"
                      value={label}
                      maxLength={80}
                      placeholder="e.g. Photos drive"
                      onChange={(e) => setLabel(e.target.value)}
                    />
                  </label>
                  {adoptError && <PageNotice variant="error" className="mt-2">{adoptError}</PageNotice>}
                  <div className="mt-4 flex gap-3">
                    {needsErase && !confirmErase ? (
                      <Button variant="danger" haptic="warning" onClick={() => setConfirmErase(true)}>
                        Erase and add this drive
                      </Button>
                    ) : (
                      <Button
                        variant={needsErase ? "danger" : "primary"}
                        haptic={needsErase ? "warning" : undefined}
                        loading={adopting}
                        onClick={() => {
                          // Erasing goes through the shared wipe dialog, which
                          // applies the waiting rule. A plain add destroys
                          // nothing, so it happens straight away.
                          if (needsErase) {
                            setWipe("erase");
                            return;
                          }
                          Promise.resolve(onAdopt(label, false))
                            .then(() => close())
                            .catch(() => {});
                        }}
                      >
                        {needsErase ? "Yes, erase it" : "Add this drive"}
                      </Button>
                    )}
                    <Button variant="outline" onClick={close}>Cancel</Button>
                  </div>
                </>
              )}
              {!canUse && !offerFormat && (
                <div className="mt-4">
                  <Button variant="outline" onClick={close}>Close</Button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </ModalCard>
    {wipe ? (
      <WipeDriveDialog
        // A different drive must start its own wait.
        key={`${shownDrive.name}:${wipe}`}
        title={wipe === "erase" ? "Erase this drive?" : "Format this drive?"}
        confirmLabel={wipe === "erase" ? "Erase and add" : "Format"}
        preview={wipePreview}
        busy={adopting}
        error={adoptError || ""}
        onClose={() => setWipe(null)}
        onConfirm={runWipe}
      />
    ) : null}
    </>
  );
}
