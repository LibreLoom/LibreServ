import { FolderOpen } from "lucide-react";
import Card from "../cards/Card";
import TextLink from "../ui/TextLink";
import CopyableValue from "../ui/CopyableValue";

/**
 * Exact steps to open a Luna drive as a folder on a computer.
 * Finder/Explorer must use an access token from Settings — never the Luna password.
 */
export default function ComputerMountHelp({ driveId, driveLabel }) {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const davUrl = driveId ? `${origin}/dav/${driveId}` : `${origin}/dav/…`;
  const label = driveLabel || "this drive";

  return (
    <Card icon={FolderOpen} title="Open as a folder on a computer">
      <p className="text-primary text-sm">
        This puts {label} next to the other folders on a Mac, Windows PC, or Linux
        computer. Sign in with your Luna username. For the password, use an access
        token from Settings — never your Luna password.
      </p>
      <ol className="mt-4 space-y-2 text-sm text-primary list-decimal list-inside">
        <li>
          Open Settings → Security → create an access token and copy it.
        </li>
        <li>
          On a Mac: Finder → Go → Connect to Server. On Windows: File Explorer →
          This PC → Map network drive. On Linux: Files → Connect to Server.
        </li>
        <li>Paste this address, then your username and the access token.</li>
      </ol>
      <CopyableValue
        className="mt-4"
        value={davUrl}
        copyLabel="Copy address"
        ariaLabel="Folder address for this drive"
      />
      <p className="mt-3 text-sm text-primary">
        Only an admin can open a whole drive as a folder.
        {" "}
        <TextLink surface="secondary" to="/settings#security">Open Settings</TextLink>
      </p>
    </Card>
  );
}
