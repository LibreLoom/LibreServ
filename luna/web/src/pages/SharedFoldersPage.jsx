import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FolderOpen, HardDrive } from "lucide-react";
import Page from "@libreloom/ui/components/ui/Page.jsx";
import Card from "@libreloom/ui/components/cards/Card.jsx";
import Pill from "@libreloom/ui/components/common/Pill.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import EmptyState from "@libreloom/ui/components/common/EmptyState.jsx";
import { TermHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import ShareSheet, { ShareButton } from "../components/share/ShareSheet.jsx";
import FileSearch from "../components/files/FileSearch";
import { useAuth } from "../context/AuthContext";
import { getDrives, getJson } from "../lib/api";
import { isPresentDrive } from "../lib/drives.js";
import { folderHref, isMemberHomePath } from "../lib/paths.js";
import { CAP, KIND_ALBUM, capsHint, capsLabel, hasCap, sharedItemAction, sharedItemHref } from "../lib/access.js";
import { memberAccessRoots } from "../lib/shareTree.js";

function PermissionPill({ caps, file = false }) {
  const variant = caps === "full" ? "success" : caps === "upload" ? "warning" : "info";
  const label = capsLabel(caps, { file });
  const hint = capsHint(caps, { file });
  return (
    <Pill variant={variant}>
      {hint ? <TermHint content={hint}>{label}</TermHint> : label}
    </Pill>
  );
}

/**
 * Shared folders: everything outside anyone's private My files. Admins see
 * each drive's top level; members see the folders they were given access to.
 */
export default function SharedFoldersPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [sharing, setSharing] = useState(/** @type {null|{ id: string, path: string }} */ (null));

  const drives = useQuery({ queryKey: ["drives"], queryFn: getDrives, enabled: isAdmin });
  const access = useQuery({
    queryKey: ["my-access"],
    queryFn: () => getJson("/api/v1/me/access"),
    enabled: !isAdmin,
  });

  // Homes (yours or anyone's) live in My files / Shared with me, not here.
  const grants = memberAccessRoots(access.data || []).filter(
    (g) => g.kind !== KIND_ALBUM && !g.is_home && !isMemberHomePath(g.path || ""),
  );
  const presentDrives = (drives.data || []).filter(isPresentDrive);
  const loading = isAdmin ? drives.isLoading : access.isLoading;
  const empty = isAdmin ? presentDrives.length === 0 : grants.length === 0;

  return (
    <Page title="Shared folders" titleId="shared-folders-title" rightContent={<FileSearch />}>
      <div className="grid gap-4 md:grid-cols-2">
        {isAdmin && presentDrives.map((drive) => (
          <Card key={drive.id} icon={HardDrive} title={drive.label}>
            <p className="text-primary font-mono text-sm">Everything outside private My files folders</p>
            <div className="mt-3 flex items-center justify-end gap-2">
              <Button size="sm" variant="primary" asChild>
                <Link to={folderHref(drive.id, "")}>Browse files</Link>
              </Button>
              <ShareButton label={drive.label} onClick={() => setSharing({ id: drive.id, path: "" })} />
            </div>
          </Card>
        ))}
        {!isAdmin && grants.map((grant) => (
          <Card key={grant.id} icon={FolderOpen} title={grant.name || grant.drive_label}>
            <p className="text-primary font-mono text-sm">
              {grant.path ? `${grant.drive_label} · ${grant.path}` : "Whole drive"}
            </p>
            <div className="mt-3 flex items-center justify-between gap-3">
              <PermissionPill caps={grant.caps} file={grant.is_file === true} />
              <div className="flex items-center gap-2">
                <Button size="sm" variant="primary" asChild>
                  <Link to={sharedItemHref(grant)}>{sharedItemAction(grant)}</Link>
                </Button>
                {hasCap(grant.caps, CAP.SHARE) && (
                  <ShareButton
                    label={grant.path || grant.drive_label}
                    onClick={() => setSharing({ id: grant.drive_id, path: grant.path || "" })}
                  />
                )}
              </div>
            </div>
          </Card>
        ))}
      </div>
      {!loading && empty && (
        isAdmin ? (
          <EmptyState
            icon={FolderOpen}
            title="No shared folders yet"
            description="Add a drive and its folders show up here."
            action={
              <Button size="sm" variant="primary" asChild>
                <Link to="/drives">Go to Drives</Link>
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={FolderOpen}
            title="No shared folders yet"
            description="Ask an Admin to give you access to a folder or drive."
          />
        )
      )}
      <ShareSheet
        open={sharing != null}
        subject={sharing ? { kind: "path", driveId: sharing.id, path: sharing.path } : null}
        onClose={() => setSharing(null)}
      />
    </Page>
  );
}
