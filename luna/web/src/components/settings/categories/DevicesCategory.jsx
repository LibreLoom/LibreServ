import { Laptop, Smartphone } from "lucide-react";
import { Link } from "react-router-dom";
import SettingsCard from "../SettingsCard";
import Button from "../../ui/Button";
import { TermHint } from "../../ui/Tooltip.jsx";

/** Official app downloads. No other public URLs exist in this repo yet. */
export const MOBILE_APP_DOWNLOAD_URL = "https://luna.libreloom.org/downloads/mobile";
export const DESKTOP_APP_DOWNLOAD_URL = "https://luna.libreloom.org/downloads/desktop";

export default function DevicesCategory() {
  return (
    <div className="space-y-4" data-slot="devices-category">
      <SettingsCard icon={Smartphone} title="Mobile App" index={0}>
        <p className="text-primary text-sm">
          The Luna app on your phone copies photos to this Luna. Sign in with
          your Luna username, then turn photo backup on. Photos save on Wi-Fi
          while the phone charges, into a folder named Phone Backup.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button asChild variant="primary">
            <a href={MOBILE_APP_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer">
              Download the Luna app for phones
            </a>
          </Button>
        </div>
      </SettingsCard>

      <SettingsCard icon={Laptop} title="Desktop App" index={1}>
        <p className="text-primary text-sm">
          Luna Desktop runs on a computer. Use it to copy folders onto this Luna
          (backup), or keep a folder on the computer and a folder on Luna up to
          date (sync).
        </p>
        <p className="text-primary text-sm mt-3">
          Sign in with an{" "}
          <TermHint content="A sign-in the app remembers so you do not type your Luna password on this computer. Create one on Security, paste it in Luna Desktop, then Luna Desktop stores it on that computer.">
            access token
          </TermHint>
          {" "}from Security so Luna Desktop can reach this Luna without storing
          your password.
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
