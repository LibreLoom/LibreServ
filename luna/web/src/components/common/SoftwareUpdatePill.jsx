import { Link } from "react-router-dom";
import { Download } from "lucide-react";
import Pill from "./Pill.jsx";
import { useSoftwareUpdates } from "../../hooks/useSoftwareUpdates.jsx";
import { ICON_SIZE } from "@/lib/ui-tokens";
import { haptic } from "../../utils/haptics.js";

/**
 * SoftwareUpdatePill — shows in the dashboard header when a Luna software
 * update is available (admin only). Hidden when up to date or still checking.
 */
export default function SoftwareUpdatePill() {
  const { data, isLoading, error } = useSoftwareUpdates();

  if (isLoading || error || !data?.update_available) return null;

  const version = data.latest_version || "Update";

  return (
    <Link
      to="/settings#about"
      onClick={() => haptic("light")}
      data-slot="software-update-pill"
      className="rounded-pill no-focus-outline focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 motion-safe:transition-transform active:motion-safe:scale-95"
      aria-label={`Software update ${version} available. Open Settings to install.`}
    >
      <Pill variant="warning" className="hover:brightness-110">
        <Download size={ICON_SIZE.xs} strokeWidth={2.5} aria-hidden="true" />
        <span className="font-medium">{version} ready</span>
      </Pill>
    </Link>
  );
}
