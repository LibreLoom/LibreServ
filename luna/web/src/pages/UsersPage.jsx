import { useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Shield, Trash2, User, UserPlus } from "lucide-react";
import Page from "@libreloom/ui/components/ui/Page.jsx";
import Card from "@libreloom/ui/components/cards/Card.jsx";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import ConfirmModal from "@libreloom/ui/components/cards/ConfirmModal.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import Pill from "@libreloom/ui/components/common/Pill.jsx";
import Table from "@libreloom/ui/components/common/Table.jsx";
import Dropdown from "@libreloom/ui/components/common/Dropdown.jsx";
import EmptyState from "@libreloom/ui/components/common/EmptyState.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import PasswordStrengthChecklist from "@libreloom/ui/components/common/PasswordStrengthChecklist.jsx";
import { InfoHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { apiErrorMessage, deleteJson, getJson, patchJson, postJson } from "../lib/api";
import { meetsPasswordPolicy, passwordPolicyError } from "@libreloom/ui/lib/passwordPolicy.js";
import { useAuth } from "../context/AuthContext";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import CreateUserForm from "../components/common/forms/CreateUserForm";
import FormInput from "../components/common/forms/FormInput";
import FieldLabel from "@libreloom/ui/components/common/forms/FieldLabel.jsx";
import useStrandedErrorToast from "../hooks/useStrandedErrorToast";
import { haptic } from "@libreloom/ui/utils/haptics.js";

export default function UsersPage() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { addToast } = useToast();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);
  const [userToDelete, setUserToDelete] = useState(null);
  const [userToEdit, setUserToEdit] = useState(null);

  const users = useQuery({
    queryKey: ["users"],
    queryFn: () => getJson("/api/v1/users"),
    enabled: user?.role === "admin",
  });

  const createMutation = useMutation({
    mutationFn: (body) => postJson("/api/v1/users", body),
    onSuccess: () => {
      addToast({ type: "success", message: "User added." });
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
  const [adoptId, setAdoptId] = useState("");
  const adoptMutation = useMutation({
    mutationFn: (/** @type {string} */ id) => postJson(`/api/v1/users/${id}/adopt-private`, {}),
    onSuccess: (data) => {
      const n = Number(data?.count) || 0;
      addToast({
        type: "success",
        message: n === 1 ? "1 private folder given." : `${n} private folders given.`,
      });
      setAdoptId("");
      queryClient.invalidateQueries({ queryKey: ["ownerless-private"] });
    },
    onError: (err) => {
      haptic("error");
      addToast({
        type: "error",
        message: "Couldn't give the private folders.",
        description: apiErrorMessage(err, "Try again."),
      });
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

  const updateMutation = useMutation({
    mutationFn: (/** @type {{ id: string, display_name?: string, role?: string, password?: string }} */ { id, ...body }) =>
      patchJson(`/api/v1/users/${id}`, body),
    onSuccess: () => {
      addToast({ type: "success", message: "Person updated." });
      setUserToEdit(null);
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (err) => {
      haptic("error");
      setError(apiErrorMessage(err, "Couldn't update that person. Try again."));
    },
  });

  const actionModalOpen = creating || userToDelete != null || Boolean(userToEdit && userToEdit.id !== user?.id);
  useStrandedErrorToast(error, actionModalOpen, () => setError(null));

  if (user?.role !== "admin") {
    return (
      <Page title="Users">
        <Card padding>
          <p className="text-primary text-sm">
            This page is for Admins. Ask an Admin if you need someone added or removed.
          </p>
        </Card>
      </Page>
    );
  }

  const list = users.data || [];
  const loading = users.isLoading;
  const showList = !loading && !users.isError && list.length > 0;
  const showEmpty = !loading && !users.isError && list.length === 0;

  return (
    <>
      <Page
        title="Users"
        titleId="users-title"
        className={userToDelete ? "pop-out" : "pop-in"}
      >
        {users.isError && (
          <PageNotice variant="error" className="mb-4">
            {String(users.error?.message || "Couldn't load users. Try again.")}
          </PageNotice>
        )}

        {ownerlessCount > 0 && (
          <PageNotice variant="warning" className="mb-4">
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm">
                {ownerlessCount === 1
                  ? "1 private folder came from another Luna and has no owner."
                  : `${ownerlessCount} private folders came from another Luna and have no owner.`}{" "}
                Only an Admin can open {ownerlessCount === 1 ? "it" : "them"} until you give{" "}
                {ownerlessCount === 1 ? "it" : "them"} to someone.
              </p>
              <Dropdown
                options={list.map((u) => ({ value: u.id, label: u.display_name || u.username }))}
                value={adoptId}
                onChange={setAdoptId}
                placeholder="Give to…"
                bg="secondary"
                size="form"
                aria-label="Give private folders to"
              />
              <Button
                size="sm"
                variant="primary"
                disabled={!adoptId || adoptMutation.isPending}
                onClick={() => adoptMutation.mutate(adoptId)}
              >
                Give
              </Button>
            </div>
          </PageNotice>
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
                        {o.drives
                          .map((d) => {
                            const trash = Number(d.trash_count) || 0;
                            const folders = d.count - trash;
                            const counts = [folders ? `${folders} ${folders === 1 ? "folder" : "folders"}` : "", trash ? `${trash} ${trash === 1 ? "item" : "items"} in Trash` : ""].filter(Boolean).join(", ");
                            return `${counts} on ${d.drive_label}${d.readonly ? " (read-only)" : ""}`;
                          })
                          .join(" · ")}
                        {" — nobody can open "}
                        {o.total === 1 ? "it" : "them"}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={cleanMutation.isPending || o.drives.every((d) => d.readonly)}
                      onClick={() => setOrphanToClean(o)}
                      aria-label={`Delete private folders left by ${o.display_name || o.username}`}
                    >
                      Delete permanently
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

        {showEmpty && (
          <EmptyState
            className="mt-5"
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
          <section className="mt-5" aria-label="User list">
            <Card
              surface="primary"
              padding={false}
              className="overflow-hidden border-0 md:border-2 bg-transparent md:bg-primary"
              noHeightAnim
            >
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
                            <span className="font-semibold text-sm text-primary">
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
                        <span className="inline-flex items-center px-2.5 py-1 rounded-pill bg-primary/10 text-sm font-mono text-primary">
                          {row.username}
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
                                <Link to="/settings#security">
                                  <Pencil size={16} aria-hidden="true" />
                                </Link>
                              </Button>
                            ) : (
                              <Button
                                variant="ghost"
                                size="iconSm"
                                surface="secondary"
                                onClick={() => {
                                  setError(null);
                                  setUserToEdit(row);
                                }}
                                aria-label={`Edit ${row.display_name || row.username}`}
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
                          </span>
                        );
                      },
                    },
                  ]}
                  data={list}
                  rowKey="id"
                  mobileCards
                />
              </div>
            </Card>
          </section>
        )}

      </Page>

      {/* Portal + raise above the bottom nav: page-enter / pop-in transforms
          otherwise trap position:fixed to the scrolling shell, and the
          desktop nav's full-width hit layer (z-50) eats clicks at z-40. */}
      {showList &&
        createPortal(
          <Button
            variant="secondary"
            surface="primary"
            className="fixed bottom-28 right-8 z-[60] rounded-full p-4 hover:scale-110"
            aria-label="Add user"
            onClick={() => {
              setError(null);
              setCreating(true);
            }}
          >
            <Plus size={32} aria-hidden="true" />
          </Button>,
          document.body,
        )}

      <CreateUserModal
        open={creating}
        onClose={() => setCreating(false)}
        onSubmit={(body) => createMutation.mutate(body)}
        busy={createMutation.isPending}
        submitError={creating ? error : null}
      />

      <EditUserModal
        key={userToEdit?.id || "closed"}
        open={Boolean(userToEdit && userToEdit.id !== user?.id)}
        user={userToEdit}
        busy={updateMutation.isPending}
        submitError={userToEdit ? error : null}
        onClose={() => {
          setUserToEdit(null);
          setError(null);
        }}
        onSubmit={(body) => updateMutation.mutate(body)}
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

const ROLE_OPTIONS = [
  { value: "user", label: "Member" },
  { value: "admin", label: "Admin" },
];

/**
 * Edit one person: their name, their role, and (optionally) a fresh
 * password. Password resets sign that person out everywhere — old sessions
 * and device tokens die with the old password.
 */
function EditUserModal({ open, user: target, busy, submitError, onClose, onSubmit }) {
  const [name, setName] = useState(target?.display_name || target?.username || "");
  const [role, setRole] = useState(target?.role || "user");
  const [password, setPassword] = useState("");
  const nameClean = name.trim();
  const nameError = !nameClean ? "They need a name." : nameClean.length > 80 ? "Names are 1-80 characters." : null;
  const passwordProblem = password && !meetsPasswordPolicy(password)
    ? passwordPolicyError(password) || "Choose a stronger password."
    : null;

  function save() {
    if (!target || nameError || passwordProblem) return;
    const body = { id: target.id };
    if (nameClean !== (target.display_name || "")) body.display_name = nameClean;
    if (role !== target.role) body.role = role;
    if (password) body.password = password;
    if (Object.keys(body).length === 1) {
      onClose();
      return;
    }
    onSubmit(body);
  }

  return (
    <ModalCard open={open} title={`Edit ${target?.display_name || target?.username || "person"}`} onClose={onClose}>
      {submitError && <PageNotice variant="error" className="mb-4">{submitError}</PageNotice>}
      <FormInput
        label="Name"
        name="edit-user-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Their name"
        error={name ? nameError : null}
        required
      />
      <div className="mb-4">
        <FieldLabel htmlFor="edit-user-role" surface="secondary">
          Role
        </FieldLabel>
        <Dropdown
          id="edit-user-role"
          options={ROLE_OPTIONS}
          value={role}
          onChange={setRole}
          fullWidth
          bg="primary"
          size="form"
          aria-label="Role"
        />
        <p className="text-primary text-xs mt-1">
          {role === "admin"
            ? "An Admin can add users, manage drives and settings, and open everything except other people's private items."
            : "A Member can use whatever is shared with them."}
        </p>
      </div>
      <FormInput
        label="New password"
        name="edit-user-password"
        type="password"
        icon="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Leave blank to keep their password"
        autoComplete="new-password"
      />
      {password ? <PasswordStrengthChecklist password={password} /> : null}
      {password ? (
        <p className="text-primary text-xs mb-4">
          Setting a new password signs them out on every device.
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          loading={busy}
          disabled={Boolean(nameError || passwordProblem)}
          onClick={save}
        >
          Save
        </Button>
      </div>
    </ModalCard>
  );
}
