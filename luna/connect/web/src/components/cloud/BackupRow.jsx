import { Archive } from "lucide-react";
import { Button } from "../ui/button.jsx";
import { formatWhen } from "../../lib/cloudTree.js";
import { Chip, ROW_CLASS, RowIcon } from "./Chip.jsx";

/**
 * One backup in the list: its name, how many versions, when it last ran, and what you can do with it.
 */
/** @param {{ backup: any, onOpen: (id: string) => void, actions?: import("react").ReactNode }} props */
export function BackupRow({ backup, onOpen, actions = null }) {
  const count = backup.versions.length;
  return (
    <div className={ROW_CLASS}>
      <div className="flex min-w-0 items-center gap-3">
        <RowIcon icon={Archive} />
        <div className="min-w-0 space-y-1.5">
          <p className="font-mono text-base break-words">{backup.name}</p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip>{count === 1 ? "1 version" : `${count} versions`}</Chip>
            <Chip>Latest {formatWhen(backup.versions[0].createdAt)}</Chip>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="default" size="sm" onClick={() => onOpen(backup.protectionId)}>
          Open
        </Button>
        {actions}
      </div>
    </div>
  );
}

