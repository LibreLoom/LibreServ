import { useEffect, useState } from "react";
import { Link2 } from "lucide-react";
import { Button } from "../ui/button.jsx";
import { Chip, ROW_CLASS, RowIcon } from "./Chip.jsx";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card.jsx";
import { listShareLinks, revokeShareLink } from "../../lib/shareLinks.js";
import { formatWhen } from "../../lib/cloudTree.js";
import { groupByStarter } from "../../lib/cloudUnlock.js";
import { userRecordPart } from "@libreloom/ui/lib/cloud/cloudKeys.js";

/**
 * Lists this Luna's active share links. Connect stores no names, so the names
 * come from the backups the owner has unlocked on this page.
 * @param {{ lunaId: string, backups: any[], refreshKey?: number }} props
 */
export function ShareLinksCard({ lunaId, backups, refreshKey = 0 }) {
  const [links, setLinks] = useState([]);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [busyId, setBusyId] = useState("");

  useEffect(() => {
    let active = true;
    listShareLinks()
      .then((all) => {
        if (!active) return;
        setLinks(all.filter((link) => link.luna_id === lunaId));
        setError("");
      })
      .catch((err) => {
        if (active) setError(err.message);
      });
    return () => {
      active = false;
    };
  }, [lunaId, refreshKey, reload]);

  async function turnOff(id) {
    setError("");
    setBusyId(id);
    try {
      await revokeShareLink(id);
      setReload((n) => n + 1);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId("");
    }
  }

  if (links.length === 0 && !error) return null;

  const groups = groupByStarter(backups || []);

  function whatFor(link) {
    if (link.scope_kind === "user") {
      const group = groups.find((g) => g.startedBy && userRecordPart(g.startedBy) === link.scope_value);
      return group ? group.name : "One person's backups";
    }
    const backup = (backups || []).find((b) => b.protectionId === link.scope_value);
    return backup ? backup.name : "One backup";
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Active backup links</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? (
          <p role="alert" className="text-sm text-error">{error}</p>
        ) : null}
        <ul className="space-y-3">
          {links.map((link) => (
            <li key={link.id} className={ROW_CLASS}>
              <div className="flex min-w-0 items-center gap-3">
                <RowIcon icon={Link2} />
                <div className="min-w-0 space-y-1.5">
                  <p className="font-mono text-base break-words">{whatFor(link)}</p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Chip>Turns off {formatWhen(link.expires_at)}</Chip>
                    <Chip>{link.last_opened_at ? `Last opened ${formatWhen(link.last_opened_at)}` : "Not opened yet"}</Chip>
                  </div>
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                loading={busyId === link.id}
                onClick={() => turnOff(link.id)}
              >
                Turn off
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
