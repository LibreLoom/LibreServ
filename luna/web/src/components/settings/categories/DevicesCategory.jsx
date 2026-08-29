import { Laptop } from "lucide-react";
import SettingsCard from "../SettingsCard";

export default function DevicesCategory() {
  return (
    <SettingsCard icon={Laptop} title="Devices">
      <p className="text-primary text-sm">
        Phone photos: install the Luna app from the same place you downloaded
        Luna. Create an access token under Security, then paste it into the
        phone app — or tap Show as QR code and scan it on the phone. You can
        choose which drive and folder photos go to, and whether backup waits
        for Wi-Fi or charging.
      </p>
      <p className="text-primary text-sm mt-3">
        Computers: use the Luna Desktop app. Sign in with an access token from
        Security → Apps and access tokens.
      </p>
    </SettingsCard>
  );
}
