import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2, Users } from "lucide-react";
import ModalCard from "../cards/ModalCard";
import Button from "../ui/Button";
import Dropdown from "../common/Dropdown";
import PageNotice from "../common/PageNotice";
import CreateShareModal from "./CreateShareModal";
import { useAuth } from "../../context/AuthContext";
import { deleteJson, getDrives, getJson, postJson, apiErrorMessage } from "../../lib/api";

function rememberedUrl(shareId) {
  try {
    return sessionStorage.getItem(`luna-share-${shareId}`);
  } catch {
    return null;
  }
}

function expiryLabel(expiresAt) {
  if (!expiresAt) return "never expires";
  const when = new Date(expiresAt * 1000);
  if (Number.isNaN(when.getTime())) return "expires";
  return `expires ${when.toLocaleDateString()}`;
}

function pathKey(value) {
  return value || "";
}

function grantCovers(grant, driveId, path) {
  if (grant.drive_id !== driveId) return false;
  const granted = pathKey(grant.path);
  const target = pathKey(path);
  if (!granted) return true;
  return target === granted || target.startsWith(`${granted}/`);
}

export function AccessButton({ label, onClick }) {
  return (
    <Button
      variant="ghost"
      surface="secondary"
      size="iconSm"
      aria-label={`Sharing for ${label}`}
      onClick={onClick}
    >
      <Users size={14} />
    </Button>
  );
}

export default function AccessSheet({ driveId, path = "", kind = "folder", onClose }) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const queryClient = useQueryClient();
  const [error, setError] = useState(null);
  const [creatingLink, setCreatingLink] = useState(false);
  const [personId, setPersonId] = useState("");
  const [permission, setPermission] = useState("read");
  const [targetDrive, setTargetDrive] = useState("");

  const canProtect = isAdmin && kind !== "file";
  const objectPath = pathKey(path);

  const users = useQuery({
    queryKey: ["users"],
    queryFn: () => getJson("/api/v1/users"),
    enabled: isAdmin,
  });
  const grants = useQuery({
    queryKey: ["grants"],
    queryFn: () => getJson("/api/v1/grants"),
    enabled: isAdmin,
  });
  const shares = useQuery({
    queryKey: ["shares"],
    queryFn: () => getJson("/api/v1/shares"),
  });
  const drives = useQuery({ queryKey: ["drives"], queryFn: getDrives, enabled: canProtect });
  const protections = useQuery({
    queryKey: ["protections"],
    queryFn: () => getJson("/api/v1/protections"),
    enabled: canProtect,
  });

  const matchingGrants = (grants.data || []).filter((g) => grantCovers(g, driveId, objectPath));
  const matchingShares = (shares.data || []).filter(
    (s) => s.drive_id === driveId && pathKey(s.path) === objectPath,
  );
  const matchingProtections = (protections.data || []).filter(
    (p) => p.source_drive === driveId && pathKey(p.source_path) === objectPath,
  );
  const driveList = drives.data || [];
  const tooFewDrives = driveList.length < 2;
  const household = (users.data || []).filter((u) => u.role !== "admin");

  const grantMutation = useMutation({
    mutationFn: (body) => postJson("/api/v1/grants", body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["grants"] });
      setError(null);
      setPersonId("");
    },
    onError: (err) => setError(apiErrorMessage(err)),
  });
  const revokeGrant = useMutation({
    mutationFn: (id) => deleteJson(`/api/v1/grants/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["grants"] }),
    onError: (err) => setError(apiErrorMessage(err)),
  });
  const revokeShare = useMutation({
    mutationFn: (id) => deleteJson(`/api/v1/shares/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["shares"] }),
    onError: (err) => setError(apiErrorMessage(err, "Couldn't remove that link.")),
  });
  const createProtect = useMutation({
    mutationFn: () =>
      postJson("/api/v1/protections", {
        source_drive_id: driveId,
        source_path: objectPath,
        target_drive_id: targetDrive,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["protections"] });
      setError(null);
      setTargetDrive("");
    },
    onError: (err) => setError(apiErrorMessage(err)),
  });
  const runProtect = useMutation({
    mutationFn: (id) => postJson(`/api/v1/protections/${id}/run`, {}),
    onError: (err) => setError(apiErrorMessage(err)),
  });
  const stopProtect = useMutation({
    mutationFn: (id) => deleteJson(`/api/v1/protections/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["protections"] }),
    onError: (err) => setError(apiErrorMessage(err)),
  });

  function personName(userId) {
    const found = (users.data || []).find((u) => u.id === userId);
    return found?.display_name || found?.username || userId;
  }

  function driveName(id) {
    return driveList.find((d) => d.id === id)?.label || id;
  }

  if (creatingLink) {
    return (
      <CreateShareModal
        driveId={driveId}
        path={objectPath}
        onClose={() => setCreatingLink(false)}
        onError={(msg) => setError(msg)}
        onDone={() => {
          setCreatingLink(false);
          queryClient.invalidateQueries({ queryKey: ["shares"] });
        }}
      />
    );
  }

  return (
    <ModalCard title="Sharing" onClose={onClose}>
      {error && <PageNotice variant="error" className="mb-3">{error}</PageNotice>}

      {isAdmin && (
        <section className="space-y-2">
          <h3 className="text-primary text-sm font-semibold">Users</h3>
          {matchingGrants.map((g) => (
            <div key={g.id} className="flex items-center justify-between gap-2 rounded-large-element border border-primary/20 p-3">
              <span className="text-primary text-xs">
                {personName(g.user_id)} · {g.permission === "write" ? "Write" : "Read"}
                {pathKey(g.path) !== objectPath ? " (includes this folder)" : ""}
              </span>
              <Button size="iconSm" variant="danger" aria-label={`Remove access for ${personName(g.user_id)}`} onClick={() => revokeGrant.mutate(g.id)}>
                <Trash2 size={12} />
              </Button>
            </div>
          ))}
          <Dropdown
            options={household.map((u) => ({ value: u.id, label: u.display_name || u.username }))}
            value={personId}
            onChange={setPersonId}
            placeholder="Add a person"
            fullWidth
          />
          <Dropdown
            options={[
              { value: "read", label: "Read" },
              { value: "write", label: "Write" },
            ]}
            value={permission}
            onChange={setPermission}
            fullWidth
          />
          <Button
            variant="primary"
            size="sm"
            loading={grantMutation.isPending}
            disabled={!personId}
            onClick={() => grantMutation.mutate({
              user_id: personId,
              drive_id: driveId,
              path: objectPath,
              permission,
            })}
          >
            Grant access
          </Button>
        </section>
      )}

      <section className={`space-y-2 ${isAdmin ? "mt-5" : ""}`}>
        <h3 className="text-primary text-sm font-semibold">Link</h3>
        {matchingShares.map((s) => {
          const url = rememberedUrl(s.id);
          return (
            <div key={s.id} className="flex items-center justify-between gap-2 rounded-large-element border border-primary/20 p-3">
              <div className="min-w-0">
                <p className="text-primary text-xs">
                  {s.has_password ? "Password" : "Anyone with the link"} · {expiryLabel(s.expires_at)}
                </p>
                {url && (
                  <Button size="sm" variant="outline" className="mt-2" onClick={() => navigator.clipboard.writeText(url)}>
                    Copy address
                  </Button>
                )}
              </div>
              <Button size="iconSm" variant="danger" aria-label="Remove this link" onClick={() => revokeShare.mutate(s.id)}>
                <Trash2 size={12} />
              </Button>
            </div>
          );
        })}
        <Button size="sm" variant="primary" onClick={() => { setError(null); setCreatingLink(true); }}>
          New link
        </Button>
      </section>

      {canProtect && (
        <section className="space-y-2 mt-5">
          <h3 className="text-primary text-sm font-semibold">Protect</h3>
          {tooFewDrives ? (
            <p className="text-primary text-sm">Needs a second drive.</p>
          ) : (
            <>
              {matchingProtections.map((p) => (
                <div key={p.id} className="rounded-large-element border border-primary/20 p-3 space-y-2">
                  <p className="text-primary text-xs">
                    Copy on {driveName(p.target_drive)}
                    {p.last_run ? ` · ${new Date(p.last_run * 1000).toLocaleString()}` : ""}
                  </p>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" loading={runProtect.isPending} onClick={() => runProtect.mutate(p.id)}>
                      Refresh now
                    </Button>
                    <Button size="sm" variant="danger" loading={stopProtect.isPending} onClick={() => stopProtect.mutate(p.id)}>
                      Stop
                    </Button>
                  </div>
                </div>
              ))}
              {matchingProtections.length === 0 && (
                <>
                  <Dropdown
                    options={driveList.filter((d) => d.id !== driveId).map((d) => ({ value: d.id, label: d.label }))}
                    value={targetDrive}
                    onChange={setTargetDrive}
                    placeholder="Copy onto"
                    fullWidth
                  />
                  <Button
                    size="sm"
                    variant="primary"
                    loading={createProtect.isPending}
                    disabled={!targetDrive}
                    onClick={() => createProtect.mutate()}
                  >
                    Protect
                  </Button>
                </>
              )}
            </>
          )}
        </section>
      )}
    </ModalCard>
  );
}
