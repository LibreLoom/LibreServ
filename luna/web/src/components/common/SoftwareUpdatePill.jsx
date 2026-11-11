import { Link } from "react-router-dom";
import { Download } from "lucide-react";
import Pill from "@libreloom/ui/components/common/Pill.jsx";
import { useSoftwareUpdates } from "../../hooks/useSoftwareUpdates.jsx";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";
import { haptic } from "@libreloom/ui/utils/haptics.js";

/**
 * SoftwareUpdatePill — shows in the dashboard header when a Luna software
 * update is available (admin only). Hidden when up to date or still checking.
 */
export default function SoftwareUpdatePill() {
  const { data, isLoading, error } = useSoftwareUpdates();

  // A failed install still needs saying even when nothing newer is out — that
  // is exactly when the pill would otherwise vanish and leave someone thinking
  // it worked.
  const failed = Boolean(data?.os_update_failed);
  if (isLoading || error || (!data?.update_available && !failed)) return null;

  // Name the version that failed, not whatever release happens to be newest:
  // a later release is not the one that broke.
  const failedVersion = typeof data.os_update_failed === "object" ? data.os_update_failed.version : "";
  const version = (failed ? failedVersion || data.latest_version : data.latest_version) || "Update";

  return (
    <Link
      to="/settings#about"
      onClick={() => haptic("light")}
      data-slot="software-update-pill"
      data-header-item
      className="rounded-pill no-focus-outline focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 motion-safe:transition-transform active:motion-safe:scale-95"
      aria-label={
        failed
          ? `Software update ${version} didn't install. Open Settings to try again.`
          : `Software update ${version} available. Open Settings to install.`
      }
    >
      <Pill variant={failed ? "error" : "warning"} className="hover:brightness-110">
        <Download size={ICON_SIZE.xs} strokeWidth={2.5} aria-hidden="true" />
        <span className="font-medium">
          {failed ? `${version} didn't install` : `${version} ready`}
        </span>
      </Pill>
    </Link>
  );
}
