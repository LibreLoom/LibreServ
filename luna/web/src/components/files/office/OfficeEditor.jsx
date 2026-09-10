import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { Download } from "lucide-react";
import Button from "../../ui/Button.jsx";
import PageNotice from "../../common/PageNotice.jsx";
import { downloadHref, pathBasename } from "../../../lib/paths.js";
import { ICON_SIZE } from "@/lib/ui-tokens";
import { haptic } from "../../../utils/haptics.js";
import EuroOfficeHost from "./EuroOfficeHost.jsx";
import { probeEuroOffice } from "./euroOfficeApi.js";

/**
 * Office entry — EuroOffice or nothing.
 * Luna does not ship a built-in office editor. If EuroOffice assets are missing,
 * we show a clear message and Download.
 *
 * @param {{
 *   driveId: string,
 *   path: string,
 *   canWrite?: boolean,
 *   onSaved?: () => void,
 *   onClose?: () => void,
 * }} props
 */
export default function OfficeEditor({ driveId, path, canWrite = false, onSaved, onClose }) {
  const [phase, setPhase] = useState(/** @type {"checking"|"ready"|"missing"} */ ("checking"));
  const name = pathBasename(path) || path;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ok = await probeEuroOffice();
      if (!cancelled) setPhase(ok ? "ready" : "missing");
    })();
    return () => {
      cancelled = true;
    };
  }, [driveId, path]);

  if (phase === "checking") {
    return (
      <div className="flex h-full min-h-0 flex-1 items-center justify-center bg-primary text-secondary">
        <p className="font-mono text-sm motion-safe:animate-pulse">Checking for EuroOffice…</p>
      </div>
    );
  }

  if (phase === "missing") {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-4 bg-primary p-6 text-secondary">
        <div className="w-full max-w-lg space-y-3">
          <h3 className="font-mono text-lg text-secondary">EuroOffice is not on this Luna</h3>
          <p className="text-sm text-secondary">
            Office files open only in EuroOffice. Luna does not include a built-in editor.
            Install the EuroOffice pack on this Luna (see{" "}
            <span className="font-mono">luna/docs/eurooffice.md</span>), or download the file
            and open it on another device.
          </p>
          <PageNotice variant="info" surface="primary">
            Needed file:{" "}
            <span className="font-mono">
              /eurooffice/web-apps/apps/api/documents/api.js
            </span>
          </PageNotice>
          <div className="flex flex-wrap gap-3 pt-1">
            <Button
              variant="secondary"
              surface="primary"
              asChild
              onClick={() => haptic("light")}
            >
              <a href={downloadHref(driveId, path)}>
                <Download size={ICON_SIZE.sm} aria-hidden="true" />
                Download {name}
              </a>
            </Button>
            {onClose ? (
              <Button
                type="button"
                variant="outline"
                surface="primary"
                onClick={() => {
                  haptic("light");
                  onClose();
                }}
              >
                Close
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <EuroOfficeHost
      driveId={driveId}
      path={path}
      canWrite={canWrite}
      onSaved={onSaved}
    />
  );
}

OfficeEditor.propTypes = {
  driveId: PropTypes.string.isRequired,
  path: PropTypes.string.isRequired,
  canWrite: PropTypes.bool,
  onSaved: PropTypes.func,
  onClose: PropTypes.func,
};
