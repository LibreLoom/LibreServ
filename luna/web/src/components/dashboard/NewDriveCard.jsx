import { Link } from "react-router-dom";
import { HardDrive } from "lucide-react";
import Card from "@libreloom/ui/components/cards/Card.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import { formatBytes } from "../../lib/formatBytes.js";

/**
 * What the dashboard says about drives Luna found but hasn't added yet. It sits below the
 * added drives and sends the Admin to the Files page, where each one can be previewed and added.
 *
 * @param {{ drives: Array<{ name: string, model?: string, size_bytes?: number }> }} props
 */
export default function NewDriveCard({ drives }) {
  if (drives.length === 0) return null;
  const single = drives.length === 1;
  const first = drives[0];
  const size = first.size_bytes ? formatBytes(first.size_bytes) : null;
  return (
    <Card icon={HardDrive} title="New drive detected">
      <div className="space-y-3">
        <p className="text-primary text-sm">
          {single ? (
            <>
              <InlinePill>{first.model || "A new drive"}</InlinePill>
              {size ? ` (${size})` : ""} isn&apos;t added yet. Nothing on it changes until you add it.
            </>
          ) : (
            `${drives.length} drives aren't added yet. Nothing on them changes until you add them.`
          )}
        </p>
        <Button size="sm" variant="primary" asChild>
          <Link to="/files#unrecognized-drives">{single ? "Add drive" : "Add drives"}</Link>
        </Button>
      </div>
    </Card>
  );
}
