import RemoteCategory from "./RemoteCategory.jsx";
import CloudBackupCategory from "./CloudBackupCategory.jsx";

/**
 * Luna Connect remote access + cloud backup — same External services bucket
 * as LibreServ (Connect-backed services in one place).
 */
export default function ExternalServicesCategory() {
  return (
    <div className="space-y-4">
      <RemoteCategory />
      <CloudBackupCategory />
    </div>
  );
}
