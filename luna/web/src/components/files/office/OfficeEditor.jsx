import PropTypes from "prop-types";
import { Download } from "lucide-react";
import Button from "../../ui/Button.jsx";
import PageNotice from "../../common/PageNotice.jsx";
import { downloadHref, pathBasename } from "../../../lib/paths.js";
import { ICON_SIZE } from "@/lib/ui-tokens";
import { haptic } from "../../../utils/haptics.js";
import EuroOfficeHost from "./EuroOfficeHost.jsx";

/**
 * Office entry — EuroOffice or nothing.
 * FileViewer owns the EuroOffice probe and chooses modal vs fullscreen shell.
 * Pass `phase` from that probe so escalating to fullscreen does not re-check.
 *
 * @param {{
 *   driveId: string,
 *   path: string,
 *   canWrite?: boolean,
 *   onSaved?: () => void,
 *   onClose?: () => void,
 *   onPresenceChange?: (label: string) => void,
 *   onSaveStateChange?: (hasUnsaved: boolean) => void,
 *   onRegisterSave?: (save: (() => Promise<unknown>) | null) => void,
 *   phase: "checking"|"ready"|"missing",
 *   layout?: "modal"|"fullscreen",
 * }} props
 */
export default function OfficeEditor({
  driveId,
  path,
  canWrite = false,
  onSaved,
  onClose,
  onPresenceChange,
  onSaveStateChange,
  onRegisterSave,
  phase,
  layout = "modal",
}) {
  const name = pathBasename(path) || path;
  const inModal = layout === "modal";

  if (phase === "checking") {
    return (
      <div
        className={`flex items-center justify-center ${
          inModal
            ? "min-h-[30vh] text-primary"
            : "h-full min-h-0 flex-1 bg-primary text-secondary"
        }`}
      >
        <p className="font-mono text-sm motion-safe:animate-pulse">Checking for EuroOffice…</p>
      </div>
    );
  }

  if (phase === "missing") {
    return (
      <div
        className={`flex flex-col gap-3 ${
          inModal
            ? "text-primary"
            : "h-full min-h-0 flex-1 items-center justify-center bg-primary p-6 text-secondary"
        }`}
      >
        <div className={`space-y-3 ${inModal ? "" : "w-full max-w-lg"}`}>
          <h3 className={`font-mono ${inModal ? "text-base text-primary" : "text-lg text-secondary"}`}>
            EuroOffice is not on this Luna
          </h3>
          <p className={`text-sm ${inModal ? "text-primary" : "text-secondary"}`}>
            Office files open only in EuroOffice. Luna does not include a built-in editor.
            Install the EuroOffice pack on this Luna (see{" "}
            <span className="font-mono">luna/docs/eurooffice.md</span>), or download the file
            and open it on another device.
          </p>
          <PageNotice variant="info" surface={inModal ? "secondary" : "primary"}>
            Needed file:{" "}
            <span className="font-mono">
              /eurooffice/web-apps/apps/api/documents/api.js
            </span>
          </PageNotice>
          <div className="flex flex-wrap gap-3 pt-1">
            <Button
              variant={inModal ? "primary" : "secondary"}
              surface={inModal ? "secondary" : "primary"}
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
                surface={inModal ? "secondary" : "primary"}
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
      onPresenceChange={onPresenceChange}
      onSaveStateChange={onSaveStateChange}
      onRegisterSave={onRegisterSave}
    />
  );
}

OfficeEditor.propTypes = {
  driveId: PropTypes.string.isRequired,
  path: PropTypes.string.isRequired,
  canWrite: PropTypes.bool,
  onSaved: PropTypes.func,
  onClose: PropTypes.func,
  onPresenceChange: PropTypes.func,
  onSaveStateChange: PropTypes.func,
  onRegisterSave: PropTypes.func,
  phase: PropTypes.oneOf(["checking", "ready", "missing"]).isRequired,
  layout: PropTypes.oneOf(["modal", "fullscreen"]),
};
