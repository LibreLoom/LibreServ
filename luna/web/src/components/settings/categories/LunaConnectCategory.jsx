import RemoteCategory from "./RemoteCategory.jsx";
import CloudBackupCategory from "./CloudBackupCategory.jsx";

/**
 * Luna Connect and cloud backup are one thing to the person using them: the
 * address, the device token and what is stored in the cloud. They share one
 * settings entry rather than making people guess which of two cards to open.
 */
export default function LunaConnectCategory() {
  return (
    <div className="space-y-5">
      <RemoteCategory />
      <CloudBackupCategory />
    </div>
  );
}
