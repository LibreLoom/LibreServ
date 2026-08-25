import { FolderOpen } from "lucide-react";
import Card from "../cards/Card";
import TextLink from "../ui/TextLink";
import Button from "../ui/Button";

/**
 * Exact steps to open a Luna drive as a folder on a household computer.
 * Finder/Explorer must use an access token from Settings — never the Luna password.
 */
export default function ComputerMountHelp({ driveId, driveLabel }) {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const davUrl = driveId ? `${origin}/dav/${driveId}` : `${origin}/dav/…`;
  const label = driveLabel || "this drive";

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(davUrl);
    } catch {
      // The address is still visible to copy by hand.
    }
  }

  return (
    <Card icon={FolderOpen} title="Open as a folder on a computer">
      <p className="text-primary text-sm">
        This puts {label} next to the other folders on a Mac, Windows PC, or Linux
        computer. Sign in with your Luna username. For the password, use an access
        token from Settings — never your Luna password.
      </p>
      <ol className="mt-4 space-y-2 text-sm text-primary list-decimal list-inside">
        <li>
          Open Settings → Apps and access tokens → create an access token and copy it.
        </li>
        <li>
          On a Mac: Finder → Go → Connect to Server. On Windows: File Explorer →
          This PC → Map network drive. On Linux: Files → Connect to Server.
        </li>
        <li>Paste this address, then your username and the access token.</li>
      </ol>
      <div className="mt-4 flex flex-col sm:flex-row gap-2">
        <input
          readOnly
          className="w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm font-mono"
          value={davUrl}
          onFocus={(e) => e.target.select()}
          aria-label="Folder address for this drive"
        />
        <Button size="sm" variant="outline" type="button" onClick={copyUrl}>
          Copy address
        </Button>
      </div>
      <p className="mt-3 text-sm text-primary">
        Only an admin can open a whole drive as a folder.
        {" "}
        <TextLink surface="secondary" to="/settings#apps">Open Settings</TextLink>
      </p>
    </Card>
  );
}
