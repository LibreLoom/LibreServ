import { Laptop, Smartphone } from "lucide-react";
import { Link } from "react-router-dom";
import SettingsCard from "../SettingsCard";
import Button from "../../ui/Button";

/** Official app downloads. No other public URLs exist in this repo yet. */
export const MOBILE_APP_DOWNLOAD_URL = "https://luna.libreloom.org/downloads/mobile";
export const DESKTOP_APP_DOWNLOAD_URL = "https://luna.libreloom.org/downloads/desktop";

export default function DevicesCategory() {
  return (
    <div className="space-y-4" data-slot="devices-category">
      <SettingsCard icon={Smartphone} title="Mobile App" index={0}>
        <p className="text-primary text-sm">
          Back up your photos from your phone onto your Luna.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button asChild variant="primary">
            <a href={MOBILE_APP_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer">
              Download the Luna app for Android
            </a>
          </Button>
          <Button asChild variant="outline">
            <Link to="/settings#security">
              Create an access token on Security
            </Link>
          </Button>
        </div>
      </SettingsCard>

      <SettingsCard icon={Laptop} title="Desktop App" index={1}>
        <p className="text-primary text-sm">
          Backup folders onto your Luna and access your Luna&apos;s files directly from your computer.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button asChild variant="primary">
            <a href={DESKTOP_APP_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer">
              Download Luna Desktop
            </a>
          </Button>
          <Button asChild variant="outline">
            <Link to="/settings#security">
              Create an access token on Security
            </Link>
          </Button>
        </div>
      </SettingsCard>
    </div>
  );
}
