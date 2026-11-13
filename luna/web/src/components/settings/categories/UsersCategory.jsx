import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Shield, Trash2, User, UserPlus, Users } from "lucide-react";
import Card from "@libreloom/ui/components/cards/Card.jsx";
import SettingsCard from "@libreloom/ui/components/settings/SettingsCard.jsx";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import ConfirmModal from "@libreloom/ui/components/cards/ConfirmModal.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import Pill from "@libreloom/ui/components/common/Pill.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import Table from "@libreloom/ui/components/common/Table.jsx";
import Dropdown from "@libreloom/ui/components/common/Dropdown.jsx";
import EmptyState from "@libreloom/ui/components/common/EmptyState.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import InlineError from "@libreloom/ui/components/common/InlineError.jsx";
import { InfoHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { apiErrorMessage, deleteJson, getJson, postJson } from "../../../lib/api";
import { useAuth } from "../../../context/AuthContext";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import CreateUserForm from "../../common/forms/CreateUserForm";
import EditUserModal from "./EditUserModal.jsx";
import useStrandedErrorToast from "../../../hooks/useStrandedErrorToast";
import { haptic } from "@libreloom/ui/utils/haptics.js";

/** One line of what a removed person left behind, drive by drive. */
function orphanDriveLine(owner) {
  return owner.drives
    .map((d) => {
      const trash = Number(d.trash_count) || 0;
      const folders = d.count - trash;
      const counts = [
        folders ? `${folders} ${folders === 1 ? "folder" : "folders"}` : "",
        trash ? `${trash} ${trash === 1 ? "item" : "items"} in Trash` : "",
      ].filter(Boolean).join(", ");
      return `${counts} on ${d.drive_label}${d.readonly ? " (read-only)" : ""}`;
    })
    .join(" · ");
}

export default function UsersCategory() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { user } = useAuth();
  // You edit yourself in Settings → Security; everyone else opens the same
  // kind of modal Add a user uses.
  const SELF_SECURITY = "/settings#security";
  const { addToast } = useToast();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState(null);
  const [userToDelete, setUserToDelete] = useState(null);

  const users = useQuery({
    queryKey: ["users"],
    queryFn: () => getJson("/api/v1/users"),
    enabled: user?.role === "admin",
    // Keep the failure visible so the person can choose when to retry.
    retry: false,
  });

  const createMutation = useMutation({
    mutationFn: (body) => postJson("/api/v1/users", body),
    onSuccess: (data) => {
      // A password Luna could not check against known breaches is reported,
      // not silently accepted.
      addToast({
        type: data?.warning ? "info" : "success",
        message: "User added.",
        description: data?.warning || undefined,
        duration: data?.warning ? 10000 : undefined,
      });
      setCreating(false);
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (err) => {
      haptic("error");
      setError(apiErrorMessage(err, "Couldn't add this user. Try again."));
    },
  });
  // Removing someone keeps their private folders on the drives — hidden
  // from everyone, cleaned up separately below. Say how many.
  const privateCountQuery = useQuery({
    queryKey: ["user-private-count", userToDelete?.id],
    queryFn: () => getJson(`/api/v1/users/${userToDelete.id}/private-count`),
    enabled: Boolean(userToDelete?.id),
    retry: false,
  });
  const privateCount = userToDelete ? Number(privateCountQuery.data?.count) || 0 : 0;

  // Removed people whose private folders are still on a drive.
  const orphansQuery = useQuery({
    queryKey: ["private-orphans"],
    queryFn: () => getJson("/api/v1/private/orphans"),
    enabled: user?.role === "admin",
    retry: false,
  });
  const orphans = orphansQuery.data?.owners || [];
  const orphanOffline = orphansQuery.data?.offline_drives || [];
  const [orphanToClean, setOrphanToClean] = useState(null);
  const cleanMutation = useMutation({
    mutationFn: (/** @type {string} */ owner) => deleteJson(`/api/v1/private/orphans/${owner}`),
    onSuccess: (data) => {
      const skipped = data?.skipped_readonly || [];
      const failed = data?.failed_drives || [];
      const offline = data?.offline_drives || [];
      const partial = skipped.length > 0 || failed.length > 0 || offline.length > 0;
      addToast({
        type: partial ? "warning" : "success",
        message: partial ? "Some private content remains." : "Private content deleted.",
        description: partial ? [
          skipped.length ? `${skipped.join(", ")} ${skipped.length === 1 ? "is" : "are"} read-only.` : "",
          offline.length ? `${offline.join(", ")} ${offline.length === 1 ? "is" : "are"} disconnected.` : "",
          failed.length ? `Cleanup failed on ${failed.join(", ")}. Refresh this page and try again.` : "",
        ].filter(Boolean).join(" ") : undefined,
      });
      setOrphanToClean(null);
      queryClient.invalidateQueries({ queryKey: ["private-orphans"] });
    },
    onError: (err) => {
      haptic("error");
      addToast({
        type: "error",
        message: "Couldn't delete those private folders.",
        description: apiErrorMessage(err, "Try again."),
      });
    },
  });

  // Private items that came with a drive from another Luna belong to nobody
  // until an Admin gives them to someone.
  const ownerlessQuery = useQuery({
    queryKey: ["ownerless-private"],
    queryFn: () => getJson("/api/v1/private/ownerless"),
    enabled: user?.role === "admin",
    retry: false,
  });
  const ownerlessCount = Number(ownerlessQuery.data?.count) || 0;
  const ownerless = ownerlessQuery.data?.items || [];

  // One modal for both kinds: give an ownerless folder away, or manage the
  // folders a removed person left behind (give them away or delete them).
  const [giveTarget, setGiveTarget] = useState(
    /** @type {null | { kind: "ownerless", folder: any } | { kind: "orphan", owner: any }} */ (null),
  );
  const [giveTo, setGiveTo] = useState("");
  const [giveError, setGiveError] = useState("");
  const giveMutation = useMutation({
    mutationFn: (/** @type {{ userId: string, target: any }} */ vars) => {
      const { userId, target } = vars;
      if (target.kind === "ownerless") {
        return postJson(`/api/v1/users/${userId}/adopt-private`, {
          drive_id: target.folder.drive_id,
          path: target.folder.path,
        });
      }
      return postJson(`/api/v1/private/orphans/${target.owner.user_id}/give`, { user_id: userId });
    },
    onSuccess: (_data, vars) => {
      const person = list.find((u) => u.id === vars.userId);
      const name = person ? person.display_name || person.username : "them";
      addToast({
        type: "success",
        message: vars.target.kind === "ownerless"
          ? `Gave ${vars.target.folder.name || vars.target.folder.path} to ${name}.`
          : `Gave ${vars.target.owner.display_name || vars.target.owner.username}'s private folders to ${name}.`,
      });
      setGiveTarget(null);
      setGiveTo("");
      setGiveError("");
      queryClient.invalidateQueries({ queryKey: ["ownerless-private"] });
      queryClient.invalidateQueries({ queryKey: ["private-orphans"] });
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (err) => {
      haptic("error");
      setGiveError(apiErrorMessage(err, "Couldn't give those private folders. Try again."));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => deleteJson(`/api/v1/users/${id}`),
    onSuccess: () => {
      addToast({ type: "success", message: "User removed." });
      setUserToDelete(null);
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["private-orphans"] });
    },
    onError: (err) => {
      haptic("error");
      setError(apiErrorMessage(err, "Couldn't remove this user. Try again."));
    },
  });

  const actionModalOpen = creating || userToDelete != null;
  useStrandedErrorToast(error, actionModalOpen, () => setError(null));

  const list = users.data || [];
  const adminCount = list.filter((person) => person.role === "admin").length;
  const loading = users.isLoading;
  const showList = !loading && !users.isError && list.length > 0;
  const showEmpty = !loading && !users.isError && list.length === 0;

  return (
    <>
      <div data-slot="users-category" className={userToDelete ? "pop-out" : "pop-in"}>
        {users.isError && (
          <PageNotice variant="error" className="mb-4">
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm">Couldn't load people. Try again.</p>
              <Button
                size="sm"
                variant="outline"
                surface="primary"
                disabled={users.isFetching}
                onClick={() => users.refetch()}
              >
                Try again
              </Button>
            </div>
          </PageNotice>
        )}

        {ownerlessCount > 0 && (
          <section className="mb-4" aria-label="Private folders without an owner">
            <Card surface="primary" padding>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="font-mono text-secondary text-sm">
                    Private folders without an owner
                  </h2>
                  <p className="text-secondary text-sm mt-1">
                    {ownerlessCount === 1
                      ? "1 private folder came from another Luna."
                      : `${ownerlessCount} private folders came from another Luna.`}{" "}
                    Only an Admin can open {ownerlessCount === 1 ? "it" : "them"} until you give{" "}
                    {ownerlessCount === 1 ? "it" : "them"} to someone.
                  </p>
                </div>
                <Pill variant="warning">{ownerlessCount}</Pill>
              </div>

              {ownerless.length === 0 ? (
                <p className="text-secondary text-sm mt-3">
                  Refresh this page to see {ownerlessCount === 1 ? "it" : "them"}.
                </p>
              ) : (
                <ul className="mt-3 space-y-2" aria-label="Private folders without an owner">
                  {ownerless.map((folder) => {
                    const key = `${folder.drive_id}:${folder.path}`;
                    const name = folder.name || folder.path.split("/").pop() || folder.path;
                    return (
                      <li
                        key={key}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-large-element surface-secondary p-3"
                      >
                        <div className="min-w-0">
                          <p className="text-sm text-primary">
                            <InlinePill>{name}</InlinePill>
                          </p>
                          <p className="text-xs text-primary mt-0.5">{folder.drive_label}</p>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          surface="secondary"
                          onClick={() => {
                            setGiveTo("");
                            setGiveError("");
                            setGiveTarget({ kind: "ownerless", folder });
                          }}
                        >
                          Give…
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          </section>
        )}

        {(orphans.length > 0 || orphanOffline.length > 0) && (
          <section className="mb-4" aria-label="Private folders left behind">
            <Card surface="primary" padding>
              <h2 className="font-mono text-secondary text-sm">Private folders left behind</h2>
              {orphanOffline.length > 0 && (
                <p className="text-secondary text-sm mt-2">
                  {orphanOffline.length === 1
                    ? `${orphanOffline[0]} isn't connected, so what it holds isn't counted here.`
                    : `${orphanOffline.join(", ")} aren't connected, so what they hold isn't counted here.`}
                </p>
              )}
              <ul className="mt-3 space-y-2">
                {orphans.map((o) => (
                  <li
                    key={o.user_id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-large-element surface-secondary p-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm text-primary">
                        {o.display_name || o.username}
                        {" "}(removed)
                      </p>
                      <p className="text-xs text-primary mt-0.5">
                        {orphanDriveLine(o)}
                        {" — nobody can open "}
                        {o.total === 1 ? "it" : "them"}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      surface="secondary"
                      onClick={() => {
                        setGiveTo("");
                        setGiveError("");
                        setGiveTarget({ kind: "orphan", owner: o });
                      }}
                      aria-label={`Manage private folders left by ${o.display_name || o.username}`}
                    >
                      Manage
                    </Button>
                  </li>
                ))}
              </ul>
              <p className="text-secondary text-xs mt-3">
                Private folders inside them that belong to other people are kept.
              </p>
            </Card>
          </section>
        )}

        <section className="mt-5" aria-label="User list">
          <SettingsCard icon={Users} title="People on this Luna">
        {showEmpty && (
          <EmptyState
            icon={User}
            title="No people yet"
            description="Add someone to share drives with."
            action={
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  setError(null);
                  setCreating(true);
                }}
              >
                <UserPlus size={14} aria-hidden="true" />
                Add user
              </Button>
            }
          />
        )}
            {showList && (
              <div className="overflow-x-auto">
                <Table
                  columns={[
                    {
                      key: "display_name",
                      label: "Name",
                      render: (row) => {
                        const isSelf = row.id === user?.id;
                        const content = (
                          <>
                            <span className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
                              <User size={14} aria-hidden="true" />
                            </span>
                            <span className="text-sm text-primary">
                              {row.display_name || row.username}
                            </span>
                          </>
                        );
                        if (isSelf) {
                          return (
                            <Link
                              to="/settings#security"
                              className="inline-flex items-center gap-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-pill"
                            >
                              {content}
                            </Link>
                          );
                        }
                        return (
                          <span className="inline-flex items-center gap-2">
                            {content}
                          </span>
                        );
                      },
                    },
                    {
                      key: "username",
                      label: "Username",
                      render: (row) => (
                        <span className="text-sm text-primary">
                          <InlinePill>{row.username}</InlinePill>
                        </span>
                      ),
                    },
                    {
                      key: "role",
                      label: "Role",
                      render: (row) =>
                        row.role === "admin" ? (
                          <span className="inline-flex items-center gap-1">
                            <Pill variant="accent">
                              <Shield size={12} className="mr-0.5" aria-hidden="true" />
                              Admin
                            </Pill>
                            <InfoHint
                              label="What Admin means"
                              content="An Admin can add users, change settings, manage drives, and open everything on this Luna except other people's private items."
                            />
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1">
                            <Pill variant="default">
                              <Shield size={12} className="mr-0.5" aria-hidden="true" />
                              Member
                            </Pill>
                            <InfoHint
                              label="What Member means"
                              content="A Member can use folders and albums shared with them. They cannot manage users, drives, or Luna settings."
                            />
                          </span>
                        ),
                    },
                    {
                      key: "actions",
                      label: "Actions",
                      align: "center",
                      srOnly: true,
                      width: "w-16",
                      noRowClick: true,
                      render: (row) => {
                        const isSelf = row.id === user?.id;
                        const isSoleAdmin = isSelf && row.role === "admin" && adminCount === 1;
                        return (
                          <span className="flex items-center justify-center gap-1">
                            {isSelf ? (
                              <Button
                                asChild
                                variant="ghost"
                                size="iconSm"
                                surface="secondary"
                                aria-label={`Edit ${row.display_name || row.username}`}
                              >
                                <Link to={SELF_SECURITY}>
                                  <Pencil size={16} aria-hidden="true" />
                                </Link>
                              </Button>
                            ) : (
                              <Button
                                variant="ghost"
                                size="iconSm"
                                surface="secondary"
                                aria-label={`Edit ${row.display_name || row.username}`}
                                onClick={() => setEditing(row)}
                              >
                                <Pencil size={16} aria-hidden="true" />
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="iconSm"
                              surface="secondary"
                              disabled={isSelf || deleteMutation.isPending}
                              onClick={() =>
                                setUserToDelete({
                                  id: row.id,
                                  name: row.display_name || row.username,
                                })
                              }
                              aria-label={`Remove ${row.display_name || row.username}`}
                            >
                              <Trash2 size={16} aria-hidden="true" />
                            </Button>
                            {isSoleAdmin && (
                              <InfoHint
                                label="Why can't I remove the only Admin?"
                                content="You can't remove the only Admin. Add another person, make them an Admin, then sign in as them to remove this account."
                              />
                            )}
                          </span>
                        );
                      },
                    },
                  ]}
                  data={list}
                  rowKey="id"
                  onRowClick={(row) => (
                    row.id === user?.id ? navigate(SELF_SECURITY) : setEditing(row)
                  )}
                  addRow={{
                    label: "Add user",
                    onClick: () => {
                      setError(null);
                      setCreating(true);
                    },
                  }}
                  mobileCards
                  renderMobileCard={(row, columns) => {
                    const cell = (key) => columns.find((col) => col.key === key)?.render?.(row, 0);
                    return (
                      <div className="flex items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2">{cell("display_name")}</div>
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            {cell("username")}
                            {cell("role")}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">{cell("actions")}</div>
                      </div>
                    );
                  }}
                />
              </div>
            )}
          </SettingsCard>
        </section>

      </div>

      <CreateUserModal
        open={creating}
        onClose={() => setCreating(false)}
        onSubmit={(body) => createMutation.mutate(body)}
        busy={createMutation.isPending}
        submitError={creating ? error : null}
      />

      <ConfirmModal
        open={!!userToDelete}
        title="Remove user"
        disabledConfirm={privateCountQuery.isPending || privateCountQuery.isError}
        message={`Remove "${userToDelete?.name}" from this Luna? They will lose access to shared drives.${
          privateCountQuery.isError ? " Luna couldn't check for their private folders, so removing is paused. Close this and try again." : ""
        }${
          privateCount > 0
            ? ` Their ${privateCount === 1 ? "1 private folder stays" : `${privateCount} private folders stay`} on the drives, hidden from everyone — you can delete them under "Private folders left behind" on this page.`
            : ""
        }`}
        confirmLabel="Remove"
        variant="danger"
        icon={User}
        loading={deleteMutation.isPending}
        error={userToDelete ? error : null}
        onConfirm={() => userToDelete && deleteMutation.mutate(userToDelete.id)}
        onClose={() => {
          setUserToDelete(null);
          setError(null);
        }}
      />

      <EditUserModal target={editing} onClose={() => setEditing(null)} />

      <ModalCard
        open={!!giveTarget}
        title={
          giveTarget?.kind === "ownerless"
            ? "Give this private folder away"
            : `Private folders left by ${giveTarget?.owner?.display_name || giveTarget?.owner?.username || ""}`
        }
        onClose={() => {
          setGiveTarget(null);
          setGiveTo("");
          setGiveError("");
        }}
        size="md"
      >
        {giveTarget && (
          <div className="space-y-4">
            {giveTarget.kind === "ownerless" ? (
              <p className="text-primary text-sm">
                Choose who should get{" "}
                <InlinePill>{giveTarget.folder.name || giveTarget.folder.path.split("/").pop() || giveTarget.folder.path}</InlinePill>{" "}
                and everything inside it. It becomes their private folder.
              </p>
            ) : (
              <>
                <p className="text-primary text-sm">
                  {orphanDriveLine(giveTarget.owner)} — nobody can open{" "}
                  {giveTarget.owner.total === 1 ? "it" : "them"} right now.
                </p>
                <p className="text-primary text-sm">
                  Giving them to someone makes them that person&apos;s private folders. Their files stay where they are. Items in Trash stay behind for deletion.
                </p>
              </>
            )}

            <div className="space-y-2">
              <p className="text-primary text-sm">
                {giveTarget.kind === "ownerless" ? "Give to" : "Give them to"}
              </p>
              <Dropdown
                options={list.map((u) => ({ value: u.id, label: u.display_name || u.username }))}
                value={giveTo}
                onChange={setGiveTo}
                placeholder="Choose someone"
                fullWidth
                bg="primary"
                size="form"
                aria-label="Who should get these private folders"
              />
              {giveError && <InlineError>{giveError}</InlineError>}
              <div className="flex flex-wrap justify-end gap-2 pt-1">
                <Button
                  variant="outline"
                  surface="secondary"
                  onClick={() => {
                    setGiveTarget(null);
                    setGiveTo("");
                    setGiveError("");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  surface="secondary"
                  disabled={!giveTo}
                  loading={giveMutation.isPending}
                  onClick={() => giveMutation.mutate({ userId: giveTo, target: giveTarget })}
                >
                  Give
                </Button>
              </div>
            </div>

            {giveTarget.kind === "orphan" && (
              <div className="space-y-2 border-t border-primary/10 pt-4">
                <p className="text-primary text-sm">
                  Deleting removes these folders and the files deleted from them for good. Read-only and disconnected drives are skipped.
                </p>
                <Button
                  variant="danger"
                  surface="secondary"
                  disabled={cleanMutation.isPending || giveTarget.owner.drives.every((d) => d.readonly)}
                  onClick={() => {
                    setOrphanToClean(giveTarget.owner);
                    setGiveTarget(null);
                    setGiveTo("");
                    setGiveError("");
                  }}
                >
                  Delete these folders
                </Button>
              </div>
            )}
          </div>
        )}
      </ModalCard>

      <ConfirmModal
        open={!!orphanToClean}
        title="Delete private content?"
        variant="danger"
        confirmLabel="Delete permanently"
        loading={cleanMutation.isPending}
        onConfirm={() => orphanToClean && cleanMutation.mutate(orphanToClean.user_id)}
        onClose={() => setOrphanToClean(null)}
      >
        <p className="text-primary text-sm">
          {orphanToClean?.display_name || orphanToClean?.username}&apos;s{" "}
          private folders and files deleted from them will be deleted permanently — Luna cannot get them back. Read-only and disconnected drives are skipped.
        </p>
      </ConfirmModal>
    </>
  );
}

function CreateUserModal({ open = true, onClose, onSubmit, busy, submitError = null }) {
  return (
    <ModalCard open={open} title="Add a user" onClose={onClose}>
      {({ close }) => (
        <CreateUserForm
          onSubmit={onSubmit}
          busy={busy}
          submitError={submitError}
          onCancel={close}
          resetKey={open}
        />
      )}
    </ModalCard>
  );
}
