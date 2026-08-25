import { FolderOpen } from "lucide-react";
import SettingsCard from "../SettingsCard";

export default function DevicesCategory() {
  return (
    <SettingsCard icon={FolderOpen} title="Phones and computers">
      <p className="text-primary text-sm">
        Phone photos: install the Luna app from the same place you downloaded
        Luna, sign in with your household username, and turn photo backup on.
        Photos save on Wi-Fi while the phone charges, into a folder named Phone Backup.
      </p>
      <p className="text-primary text-sm mt-3">
        Computers: use the Luna Desktop app, or open a drive as a folder with
        the steps on the Files page. Create an access token under Apps and helper
        tools first — that is the password Finder or Explorer will ask for.
      </p>
    </SettingsCard>
  );
}
