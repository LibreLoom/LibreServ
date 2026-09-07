/**
 * InspectModal — shared drive-inspection / add-drive wizard.
 *
 * Shown after Luna scans a newly plugged-in drive. Presents contents, lets
 * the user name the drive, and confirms the adopt. Nothing on the drive is
 * changed until the user clicks the final confirm button.
 *
 * Used by DrivesPage (Unrecognized Drives section) and by the Dashboard
 * "New drive plugged in" card → "Add drive" modal flow.
 */
import { useEffect, useRef, useState } from "react";
import { File as FileIcon, Folder, Info, TriangleAlert } from "lucide-react";
import ModalCard from "../cards/ModalCard.jsx";
import Button from "../ui/Button.jsx";
import Spinner from "../ui/Spinner.jsx";
import PageNotice from "../common/PageNotice.jsx";
import { InfoHint, TermHint } from "../ui/Tooltip.jsx";
import { ROOT_TERM_HINT } from "../../lib/rootTerm.js";
import { describeInspectSummary } from "../../lib/fileCounts.js";

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

  useEffect(() => {
    if (open && drive) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- props/open seed draft UI state
      setLabel(drive.model || "My Drive");
      setConfirmErase(false);
      setConfirmFormat(false);
    }
  }, [open, drive]);

  if (!shownDrive) return null;

  const needsErase = Boolean(result?.needs_erase);
  const canUse = Boolean(result) && result.readable && (result.writable || needsErase);
  const offerFormat = Boolean(result) && result.readable && !result.writable && !needsErase;
  const blockedReason = result && !canUse
    ? (!result.readable
      ? "Luna could not read this drive. Make sure it is plugged in firmly and try again."
      : "This drive will not accept new files right now. Usually that means a filesystem issue, or a write-lock switch on the stick. Check if there is a lock switch, flip it, then try again. If not, you can use the format button below to attempt formatting of the drive. This will delete all data on the drive.")
    : null;

  return (
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
                <div className="mt-3 rounded-large-element bg-primary text-secondary p-3">
                  <p className="text-xs font-mono uppercase tracking-widest text-accent mb-2">
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
                            <Folder size={14} className="text-accent shrink-0" aria-hidden="true" />
                          ) : (
                            <FileIcon size={14} className="text-accent shrink-0" aria-hidden="true" />
                          )}
                          <span className="truncate">{entry.name}</span>
                          <span className="text-xs text-accent shrink-0">
                            {isFolder ? "folder" : "file"}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                  {(Number(result.folders) + Number(result.files) > result.entries.length) && (
                    <p className="text-secondary text-xs mt-2">
                      Showing names at the{" "}
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
                    If you have moved any files you want to keep off this drive,
                    choose Erase and add this drive. That deletes everything on it
                    so Luna can use it for your photos and files.
                  </p>
                </div>
              ) : blockedReason ? (
                <div className="mt-4 space-y-3">
                  <div className="flex items-start gap-3">
                    <TriangleAlert size={18} className="text-warning shrink-0 mt-0.5" />
                    <p className="text-primary text-xs">{blockedReason}</p>
                  </div>
                  {offerFormat && (
                    <>
                      {confirmFormat && (
                        <label className="block">
                          <span className="text-primary text-xs">What should Luna call this drive?</span>
                          <input
                            className="mt-2 w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm no-focus-outline focus:outline-none focus:border-secondary"
                            value={label}
                            maxLength={80}
                            onChange={(e) => setLabel(e.target.value)}
                          />
                        </label>
                      )}
                      {adoptError && confirmFormat && (
                        <PageNotice variant="error">{adoptError}</PageNotice>
                      )}
                      <div className="flex gap-3 flex-wrap">
                        {!confirmFormat ? (
                          <Button variant="danger" onClick={() => setConfirmFormat(true)}>
                            Format
                          </Button>
                        ) : (
                          <Button
                            variant="danger"
                            loading={adopting}
                            onClick={() => {
                              Promise.resolve(onAdopt(label, true))
                                .then(() => close())
                                .catch(() => {});
                            }}
                          >
                            Yes, format it
                          </Button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              ) : result.has_marker ? (
                <p className="text-primary text-sm mt-2">
                  This drive was used with a Luna before. Add it here to keep using the
                  files. Luna only updates its on-drive database.
                </p>
              ) : (
                <div className="mt-4 flex items-center gap-3">
                  <Info size={18} className="text-accent shrink-0" aria-hidden="true" />
                  <p className="text-primary text-xs">
                    Adding it writes a <span className="font-mono">.luna</span> database
                    file at the{" "}
                    <TermHint content={ROOT_TERM_HINT}>root</TermHint> of the drive.
                    Your files are untouched.
                  </p>
                </div>
              )}
              {canUse && (
                <>
                  <label className="block mt-4">
                    <span className="text-primary text-xs">What should Luna call this drive?</span>
                    <input
                      className="mt-2 w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm no-focus-outline focus:outline-none focus:border-secondary"
                      value={label}
                      maxLength={80}
                      onChange={(e) => setLabel(e.target.value)}
                    />
                  </label>
                  {adoptError && <PageNotice variant="error" className="mt-2">{adoptError}</PageNotice>}
                  <div className="mt-4 flex gap-3">
                    {needsErase && !confirmErase ? (
                      <Button variant="danger" onClick={() => setConfirmErase(true)}>
                        Erase and add this drive
                      </Button>
                    ) : (
                      <Button
                        variant={needsErase ? "danger" : "primary"}
                        loading={adopting}
                        onClick={() => {
                          Promise.resolve(onAdopt(label, needsErase))
                            .then(() => close())
                            .catch(() => {});
                        }}
                      >
                        {needsErase ? "Yes, erase it" : "Add this drive"}
                      </Button>
                    )}
                    <Button variant="outline" onClick={close}>Not now</Button>
                  </div>
                </>
              )}
              {!canUse && (
                <div className="mt-4">
                  <Button variant="outline" onClick={close}>Close</Button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </ModalCard>
  );
}
