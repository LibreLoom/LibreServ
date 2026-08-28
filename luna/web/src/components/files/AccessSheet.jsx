import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2, Users } from "lucide-react";
import ModalCard from "../cards/ModalCard";
import Button from "../ui/Button";
import CopyableValue from "../ui/CopyableValue";
import Dropdown from "../common/Dropdown";
import PageNotice from "../common/PageNotice";
import CreateShareModal from "./CreateShareModal";
import { useAuth } from "../../context/AuthContext";
import { TermHint, Tooltip } from "../ui/Tooltip";
import { deleteJson, getJson, patchJson, postJson, apiErrorMessage } from "../../lib/api";

const PERMISSION_OPTIONS = [
  { value: "read", label: "Read" },
  { value: "write", label: "Write" },
];

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

export function AccessButton({ label, onClick, surface = "secondary" }) {
  return (
    <Tooltip content="Share">
      <Button
        variant="ghost"
        surface={surface}
        size="iconSm"
        aria-label={`Sharing for ${label}`}
        onClick={onClick}
      >
        <Users size={14} />
      </Button>
    </Tooltip>
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
  const [updatingGrantId, setUpdatingGrantId] = useState(null);

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

  const matchingGrants = (grants.data || []).filter((g) => grantCovers(g, driveId, objectPath));
  const matchingShares = (shares.data || []).filter(
    (s) => s.drive_id === driveId && pathKey(s.path) === objectPath,
  );
  const members = (users.data || []).filter((u) => u.role !== "admin");

  const grantMutation = useMutation({
    mutationFn: (body) => postJson("/api/v1/grants", body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["grants"] });
      setError(null);
      setPersonId("");
    },
    onError: (err) => setError(apiErrorMessage(err)),
  });
  const updateGrant = useMutation({
    mutationFn: ({ id, permission: next }) => patchJson(`/api/v1/grants/${id}`, { permission: next }),
    onMutate: ({ id }) => setUpdatingGrantId(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["grants"] });
      setError(null);
    },
    onError: (err) => setError(apiErrorMessage(err, "Couldn't change that person's access. Try again.")),
    onSettled: () => setUpdatingGrantId(null),
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

  function personName(userId) {
    const found = (users.data || []).find((u) => u.id === userId);
    return found?.display_name || found?.username || userId;
  }

  function changePermission(grant, next) {
    if (next === grant.permission) return;
    updateGrant.mutate({ id: grant.id, permission: next });
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
          {matchingGrants.map((g) => {
            const name = personName(g.user_id);
            return (
              <div key={g.id} className="flex items-center justify-between gap-2 rounded-large-element border border-primary/20 p-3">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                  <span className="text-primary text-xs truncate">
                    {name}
                    {pathKey(g.path) !== objectPath ? " (includes this folder)" : ""}
                  </span>
                  <Dropdown
                    options={PERMISSION_OPTIONS}
                    value={g.permission === "write" ? "write" : "read"}
                    onChange={(next) => changePermission(g, next)}
                    disabled={updatingGrantId === g.id}
                    aria-label={`Access for ${name}`}
                  />
                </div>
                <Button size="iconSm" variant="danger" aria-label={`Remove access for ${name}`} onClick={() => revokeGrant.mutate(g.id)}>
                  <Trash2 size={12} />
                </Button>
              </div>
            );
          })}
          <Dropdown
            options={members.map((u) => ({ value: u.id, label: u.display_name || u.username }))}
            value={personId}
            onChange={setPersonId}
            placeholder="Add a person"
            fullWidth
          />
          <Dropdown
            options={PERMISSION_OPTIONS}
            value={permission}
            onChange={setPermission}
            fullWidth
          />
          <p className="text-primary text-xs">
            <TermHint content="Can open files in this folder, but cannot save changes.">
              Read
            </TermHint>
            {" "}opens files.{" "}
            <TermHint content="Can open files and save changes in this folder.">
              Write
            </TermHint>
            {" "}can also save changes.
          </p>
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
                  <CopyableValue
                    className="mt-2"
                    value={url}
                    copyLabel="Copy address"
                    ariaLabel="Share link address"
                  />
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

    </ModalCard>
  );
}
