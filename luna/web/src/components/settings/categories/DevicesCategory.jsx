import { Laptop } from "lucide-react";
import SettingsCard from "../SettingsCard";

export default function DevicesCategory() {
  return (
    <SettingsCard icon={Laptop} title="Devices">
      <p className="text-primary text-sm">
        Phone photos: install the Luna app from the same place you downloaded
        Luna, sign in with your Luna username, and turn photo backup on.
        Photos save on Wi-Fi while the phone charges, into a folder named Phone Backup.
      </p>
      <p className="text-primary text-sm mt-3">
        Computers: use the Luna Desktop app.
      </p>
    </SettingsCard>
  );
}
