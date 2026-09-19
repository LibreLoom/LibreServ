import PropTypes from "prop-types";
import PageNotice from "../../common/PageNotice.jsx";
import { downloadHref, pathBasename } from "../../../lib/paths.js";
import EuroOfficeHost from "./EuroOfficeHost.jsx";
import OfficeIssueCard from "./OfficeIssueCard.jsx";

/**
 * Office entry — EuroOffice or nothing.
 * There is no pre-flight probe: the host mounts straight into FileViewer's
 * fullscreen shell and a missing pack is discovered when the DocsAPI script
 * fails to load. The host reports that through `onUnavailable`, and
 * FileViewer passes `missing` back down so this card replaces the host.
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
 *   onUnavailable?: () => void,
 *   missing?: boolean,
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
  onUnavailable,
  missing = false,
}) {
  const name = pathBasename(path) || path;

  if (missing) {
    return (
      <OfficeIssueCard
        title="This Luna can't open office files"
        downloadUrl={downloadHref(driveId, path)}
        downloadName={name}
        onClose={onClose}
      >
        <p>
          Your file is fine — this Luna just doesn't have its office editor.
          Download it to keep working in another office app.
        </p>
        <PageNotice variant="info" surface="secondary" className="mt-3">
          Technical details: Luna's <span className="font-mono">EuroOffice</span>{" "}
          pack is missing or incomplete. It normally arrives with Luna setup and
          lives in the{" "}
          <span className="font-mono">eurooffice</span> folder inside Luna's data
          directory (<span className="font-mono">/var/lib/luna/eurooffice</span>{" "}
          on installed devices). Add the pack and restart Luna.
        </PageNotice>
      </OfficeIssueCard>
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
      onUnavailable={onUnavailable}
      onClose={onClose}
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
  onUnavailable: PropTypes.func,
  missing: PropTypes.bool,
};
