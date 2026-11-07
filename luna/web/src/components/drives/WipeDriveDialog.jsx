/**
 * The one confirmation that stands in front of every wipe.
 *
 * Every flow that destroys a drive's contents goes through this: reformatting
 * a plain drive, turning encryption on, turning it off. One dialog means one
 * rule, and the rule is:
 *
 * - A drive holding nothing meaningful gets a single confirmation.
 * - A drive holding anything gets the same confirmation, but the button stays
 *   disabled while a countdown runs and the dialog lists what is on the drive.
 *
 * The waiting period is not ceremony. It is the only thing between a mis-click
 * and someone's photos, and it is deliberately long enough to read the list.
 */

import { useEffect, useState } from "react";
import { AlertTriangle, Lock } from "lucide-react";
import ModalCard, { NESTED_OVERLAY_CLASS } from "@libreloom/ui/components/cards/ModalCard.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import LinearProgress from "@libreloom/ui/components/common/LinearProgress.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import {
  WIPE_WAIT_SECONDS,
  wipeContentsHeading,
  wipeContentsNote,
  wipeTargetCopy,
} from "../../lib/wipeCopy.js";

/** How many names to list before summarising the rest. */
const MAX_LISTED = 12;

/**
 * A countdown that survives re-renders without an effect writing state back.
 *
 * The deadline is set once, when the dialog mounts, and the remaining seconds
 * are derived on each render. The caller gives the dialog a `key` tied to the
 * drive, so a different drive mounts a fresh dialog and therefore starts a
 * fresh wait — which is the only way a second wipe could otherwise skip it.
 *
 * @param {boolean} waiting
 * @returns {number} seconds left, 0 when there is nothing to wait for
 */
function useCountdown(waiting) {
  const [deadline] = useState(() =>
    waiting ? Date.now() + WIPE_WAIT_SECONDS * 1000 : 0,
  );
  const [now, setNow] = useState(() => Date.now());

  // Tick only while there is something to count down to.
  useEffect(() => {
    if (!deadline) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [deadline]);

  if (!deadline) return 0;
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

/**
 * @param {{
 *   preview: import("../../lib/encryption.js").WipePreview | undefined,
 *   loading?: boolean,
 *   title: string,
 *   confirmLabel: string,
 *   busy?: boolean,
 *   error?: string,
 *   onClose: () => void,
 *   onConfirm: () => void,
 * }} props
 */
export default function WipeDriveDialog({
  preview,
  loading = false,
  title,
  confirmLabel,
  busy = false,
  error = "",
  onClose,
  onConfirm,
}) {
  const meaningful = Boolean(preview?.meaningful);
  const remaining = useCountdown(meaningful);

  const waiting = remaining > 0;
  const canConfirm = Boolean(preview) && !waiting && !busy && !loading;

  return (
    <ModalCard
      title={title}
      onClose={onClose}
      overlayClassName={NESTED_OVERLAY_CLASS}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="accent"
            onClick={onConfirm}
            disabled={!canConfirm}
          >
            {busy
              ? "Working…"
              : waiting
                ? `Wait ${remaining}s`
                : confirmLabel}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-3">
        {loading ? (
          <LinearProgress active label="Checking this drive" />
        ) : null}

        {preview ? (
          <>
            <PageNotice variant="warning">
              <p>{wipeContentsNote(preview)}</p>
            </PageNotice>

            <div className="flex flex-col gap-1">
              <p className="text-primary text-sm">{wipeContentsHeading(preview)}</p>
              {preview.entries.length > 0 ? (
                <ul className="flex flex-wrap gap-1">
                  {preview.entries.slice(0, MAX_LISTED).map((entry) => (
                    <li key={entry.name}>
                      <InlinePill>{entry.name}</InlinePill>
                    </li>
                  ))}
                  {preview.folders + preview.files > MAX_LISTED ? (
                    <li className="text-primary text-sm">
                      and {preview.folders + preview.files - MAX_LISTED} more
                    </li>
                  ) : null}
                </ul>
              ) : null}
            </div>

            {wipeTargetCopy(preview) ? (
              <p className="text-primary text-sm">{wipeTargetCopy(preview)}</p>
            ) : null}

            {waiting ? (
              <p className="text-primary text-sm">
                You can wipe this drive in {remaining} seconds.
              </p>
            ) : null}
          </>
        ) : null}

        {preview?.target_encrypted ? (
          <p className="text-primary flex items-center gap-1 text-sm">
            <Lock size={14} aria-hidden="true" />
            Keep the password safe. Nobody can recover this drive without it.
          </p>
        ) : null}

        {error ? (
          <p className="text-primary flex items-center gap-1 text-sm">
            <AlertTriangle size={14} aria-hidden="true" />
            {error}
          </p>
        ) : null}
      </div>
    </ModalCard>
  );
}
