import { useEffect, useState } from "react";
import { Button } from "../components/ui/button.jsx";
import { UnlockCard } from "../components/cloud/UnlockCard.jsx";
import { CloudBrowser } from "../components/cloud/CloudBrowser.jsx";
import { getShareInfo, shareSource } from "../lib/cloudSource.js";
import { unlockBackups } from "../lib/cloudUnlock.js";
import { formatWhen } from "../lib/cloudTree.js";
import { tokenFromHash } from "../lib/shareLinks.js";
import { userRecordPart } from "@libreloom/ui/lib/cloud/cloudKeys.js";

/**
 * Public page for a share link. The link alone opens nothing: the recovery phrase is always required.
 * Reached at /share#<token>, so the token never reaches the server in the URL.
 */
export default function SharePage() {
  const [token] = useState(() => tokenFromHash(window.location.hash));
  const [info, setInfo] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [unlocked, setUnlocked] = useState(null);

  useEffect(() => {
    if (!token) return undefined;
    let active = true;
    getShareInfo(token)
      .then((data) => {
        if (active) setInfo(data);
      })
      .catch((err) => {
        if (active) setLoadError(err.message);
      });
    return () => {
      active = false;
    };
  }, [token]);

  async function onUnlock(words) {
    const source = shareSource(token, info.luna_id);
    const res = await unlockBackups(source, words, { requireLatest: true });
    if (info.scope.kind === "user") {
      if (!res.userIds.some((id) => userRecordPart(id) === info.scope.value)) {
        throw new Error(
          "This recovery phrase belongs to someone else. Use the phrase of the person these backups were shared for.",
        );
      }
      setUnlocked({ source, backups: res.backups, privateOwners: res.privateOwners || [] });
      return;
    }
    // A folder or backup link shows only that backup, so no other person's private items belong here.
    const backups = res.backups.filter((b) => !b.private && b.protectionId === info.scope.value);
    setUnlocked({ source, backups, privateOwners: [] });
  }

  let body;
  if (!token) {
    body = (
      <p role="alert" className="text-sm text-error">
        This link is not complete. Ask the person who sent it to copy the whole link again.
      </p>
    );
  } else if (loadError) {
    body = (
      <p role="alert" className="text-sm text-error">
        {loadError}
      </p>
    );
  } else if (!info) {
    body = <p className="text-sm text-muted-foreground">Checking the link...</p>;
  } else if (unlocked) {
    body = (
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">Viewing shared backups.</p>
          <Button type="button" variant="outline" size="sm" onClick={() => setUnlocked(null)}>
            Lock
          </Button>
        </div>
        <CloudBrowser source={unlocked.source} backups={unlocked.backups} privateOwners={unlocked.privateOwners} />
      </div>
    );
  } else {
    const lunaName = info.luna_name || "their Luna";
    body = (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {info.sent_by} shared backups from {lunaName}. The link turns off {formatWhen(info.expires_at)}.
        </p>
        <UnlockCard
          testId="share-unlock"
          description={
            info.scope.kind === "user"
              ? "Type the recovery phrase of the person whose backups these are."
              : "Type your recovery phrase."
          }
          onUnlock={onUnlock}
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-3xl px-4 py-10 space-y-6">
        <h1 className="font-mono text-3xl">Shared cloud backups</h1>
        {body}
      </div>
    </div>
  );
}
