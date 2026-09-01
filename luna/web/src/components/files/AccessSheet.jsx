import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2, Users } from "lucide-react";
import ModalCard, { NESTED_OVERLAY_CLASS } from "../cards/ModalCard";
import Button from "../ui/Button";
import CopyableValue from "../ui/CopyableValue";
import Dropdown from "../common/Dropdown";
import PageNotice from "../common/PageNotice";
import ShakeTarget from "../ui/ShakeTarget";
import CreateShareModal from "./CreateShareModal";
import { useAuth } from "../../context/AuthContext";
import { TermHint, Tooltip } from "../ui/Tooltip";
import { deleteJson, getJson, patchJson, postJson, apiErrorMessage } from "../../lib/api";
import { dedupeIdenticalGrants, pathKey } from "../../lib/shareTree.js";

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

/** Accept a raw array or a wrapped `{ grants|shares|users|items: [] }` payload. */
function asList(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.grants)) return data.grants;
  if (Array.isArray(data.shares)) return data.shares;
  if (Array.isArray(data.users)) return data.users;
  return [];
}

function rowDriveId(row) {
  return row.drive_id || row.driveId || "";
}

/** This folder, parents that include it, or folders inside it on the same drive. */
function grantRelates(grant, driveId, path) {
  if (rowDriveId(grant) !== driveId) return false;
  const granted = pathKey(grant.path);
  const target = pathKey(path);
  if (!granted || !target) return true;
  return (
    target === granted
    || target.startsWith(`${granted}/`)
    || granted.startsWith(`${target}/`)
  );
}

function grantScopeNote(grant, objectPath, kind) {
  const granted = pathKey(grant.path);
  const target = pathKey(objectPath);
  if (granted === target) return "";
  if (!granted) return kind === "file" ? " (includes this file)" : " (includes this folder)";
  if (!target || granted.startsWith(`${target}/`)) return ` (only ${granted})`;
  return kind === "file" ? " (includes this file)" : " (includes this folder)";
}

/**
 * @param {{ label: string, onClick: () => void, surface?: "primary"|"secondary" }} props
 */
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

export default function AccessSheet({ driveId, path = "", kind = "folder", onClose, open = true }) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const queryClient = useQueryClient();
  const [error, setError] = useState(null);
  const [grantError, setGrantError] = useState(null);
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

  const matchingGrants = dedupeIdenticalGrants(
    asList(grants.data).filter((g) => grantRelates(g, driveId, objectPath)),
  );
  const matchingShares = asList(shares.data).filter((s) => grantRelates(s, driveId, objectPath));
  const members = asList(users.data).filter((u) => u.role !== "admin");
  const grantedUserIds = new Set(
    matchingGrants
      .filter((g) => rowDriveId(g) === driveId && pathKey(g.path) === objectPath)
      .map((g) => g.user_id),
  );
  const addablePeople = members.filter((u) => !grantedUserIds.has(u.id));
  const noPeopleToAdd = users.isSuccess && addablePeople.length === 0;
  const sheetError = error
    || (isAdmin && grants.isError
      ? apiErrorMessage(grants.error, "Couldn't load who has access. Refresh and try again.")
      : null)
    || (shares.isError
      ? apiErrorMessage(shares.error, "Couldn't load share links. Refresh and try again.")
      : null);

  /** @type {import('@tanstack/react-query').UseMutationResult<any, Error, { user_id: string, drive_id: string, path: string, permission: string }, unknown>} */
  const grantMutation = useMutation({
    mutationFn: (body) => postJson("/api/v1/grants", body),
    onMutate: () => { setError(null); setGrantError(null); },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["grants"] });
      queryClient.invalidateQueries({ queryKey: ["my-access"] });
      setError(null);
      setGrantError(null);
      setPersonId("");
    },
    onError: (err) => {
      const msg = apiErrorMessage(err, "Couldn't grant access. Try again.");
      setError(msg);
      setGrantError(msg);
    },
  });
  /** @type {import('@tanstack/react-query').UseMutationResult<any, Error, { id: string, permission: string }, unknown>} */
  const updateGrant = useMutation({
    mutationFn: ({ id, permission: next }) => patchJson(`/api/v1/grants/${id}`, { permission: next }),
    onMutate: ({ id }) => setUpdatingGrantId(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["grants"] });
      queryClient.invalidateQueries({ queryKey: ["my-access"] });
      setError(null);
    },
    onError: (err) => setError(apiErrorMessage(err, "Couldn't change that person's access. Try again.")),
    onSettled: () => setUpdatingGrantId(null),
  });
  const revokeGrant = useMutation({
    mutationFn: (id) => deleteJson(`/api/v1/grants/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["grants"] });
      queryClient.invalidateQueries({ queryKey: ["my-access"] });
    },
    onError: (err) => setError(apiErrorMessage(err, "Couldn't remove that person's access. Try again.")),
  });
  const revokeShare = useMutation({
    mutationFn: (id) => deleteJson(`/api/v1/shares/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["shares"] }),
    onError: (err) => setError(apiErrorMessage(err, "Couldn't remove that link.")),
  });

  function personName(userId) {
    const found = asList(users.data).find((u) => u.id === userId);
    return found?.display_name || found?.username || userId;
  }

  function changePermission(grant, next) {
    if (next === grant.permission) return;
    updateGrant.mutate({ id: grant.id, permission: next });
  }

  return (
    <>
    <ModalCard open={open} title="Sharing" onClose={onClose}>
      {sheetError && <PageNotice variant="error" className="mb-3">{sheetError}</PageNotice>}

      {isAdmin && (
        <section className="space-y-2">
          <h3 className="text-primary text-sm font-semibold">Users</h3>
          {matchingGrants.map((g) => {
            const name = personName(g.user_id);
            return (
              <div key={g.id} className="flex items-center justify-between gap-2 rounded-large-element bg-primary text-secondary p-3">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                  <span className="text-secondary text-xs truncate">
                    {name}
                    {grantScopeNote(g, objectPath, kind)}
                  </span>
                  <Dropdown
                    options={PERMISSION_OPTIONS}
                    value={g.permission === "write" ? "write" : "read"}
                    onChange={(next) => changePermission(g, next)}
                    disabled={updatingGrantId === g.id}
                    aria-label={`Access for ${name}`}
                    bg="secondary"
                  />
                </div>
                <Button size="iconSm" variant="danger" aria-label={`Remove access for ${name}`} onClick={() => revokeGrant.mutate(g.id)}>
                  <Trash2 size={12} />
                </Button>
              </div>
            );
          })}
          {noPeopleToAdd ? (
            <div className="space-y-3 rounded-large-element bg-primary text-secondary p-3">
              <p className="text-secondary text-sm">
                {members.length === 0
                  ? "No people to share with yet. Add a Member on the Users page."
                  : "Everyone already has access. Add more people on the Users page."}
              </p>
              <Button variant="secondary" surface="primary" size="sm" asChild>
                <Link to="/settings/users" onClick={onClose}>
                  Go to Users
                </Link>
              </Button>
            </div>
          ) : (
            <>
              <ShakeTarget shake={grantError}>
                <Dropdown
                  options={addablePeople.map((u) => ({ value: u.id, label: u.display_name || u.username }))}
                  value={personId}
                  onChange={setPersonId}
                  placeholder="Add a person"
                  fullWidth
                  bg="primary"
                />
              </ShakeTarget>
              <Dropdown
                options={PERMISSION_OPTIONS}
                value={permission}
                onChange={setPermission}
                fullWidth
                bg="primary"
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
            </>
          )}
        </section>
      )}

      <section className={`space-y-2 ${isAdmin ? "mt-5" : ""}`}>
        <h3 className="text-primary text-sm font-semibold">Link</h3>
        {matchingShares.map((s) => {
          const url = rememberedUrl(s.id);
          return (
            <div key={s.id} className="flex items-center justify-between gap-2 rounded-large-element bg-primary text-secondary p-3">
              <div className="min-w-0">
                <p className="text-secondary text-xs">
                  {s.has_password ? "Password" : "Anyone with the link"}
                  {pathKey(s.path) && pathKey(s.path) !== objectPath ? ` · ${pathKey(s.path)}` : ""}
                  {" · "}
                  {expiryLabel(s.expires_at)}
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
    {creatingLink && (
      <CreateShareModal
        open
        driveId={driveId}
        path={objectPath}
        overlayClassName={NESTED_OVERLAY_CLASS}
        onClose={() => setCreatingLink(false)}
        onDone={() => {
          setCreatingLink(false);
          queryClient.invalidateQueries({ queryKey: ["shares"] });
        }}
      />
    )}
    </>
  );
}
