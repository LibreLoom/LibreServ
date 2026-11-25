import DeviceTokenCard from "./DeviceTokenCard.jsx";
import RemoteCategory from "./RemoteCategory.jsx";
import CloudBackupCategory from "./CloudBackupCategory.jsx";

/**
 * Luna Connect and cloud backup are one thing to the person using them: the
 * pairing details, the address and what is stored in the cloud. They share one
 * settings entry rather than making people guess which card to open.
 */
export default function LunaConnectCategory() {
  return (
    <div className="space-y-5" data-slot="luna-connect-category">
      <DeviceTokenCard />
      <RemoteCategory />
      <CloudBackupCategory />
    </div>
  );
}
