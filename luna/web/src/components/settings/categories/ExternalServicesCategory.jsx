import RemoteCategory from "./RemoteCategory.jsx";
import CloudBackupCategory from "./CloudBackupCategory.jsx";
import TailscaleCard from "./TailscaleCard.jsx";

/** Connect and Tailscale settings share the External services category. */
export default function ExternalServicesCategory() {
  return (
    <div className="space-y-4">
      <TailscaleCard />
      <RemoteCategory />
      <CloudBackupCategory />
    </div>
  );
}
