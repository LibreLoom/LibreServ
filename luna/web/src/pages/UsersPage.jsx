import { useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { House, Pencil, Plus, Shield, Trash2, User, UserPlus } from "lucide-react";
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
import { InfoHint, TermHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { apiErrorMessage, deleteJson, getDrives, getJson, patchJson, postJson, putJson } from "../lib/api";
import { meetsPasswordPolicy, passwordPolicyError } from "@libreloom/ui/lib/passwordPolicy.js";
import { useAuth } from "../context/AuthContext";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import CreateUserForm from "../components/common/forms/CreateUserForm";
import FormInput from "../components/common/forms/FormInput";
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
  const deleteMutation = useMutation({
    mutationFn: (id) => deleteJson(`/api/v1/users/${id}`),
    onSuccess: () => {
      addToast({ type: "success", message: "User removed." });
      setUserToDelete(null);
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["users"] });
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

  const actionModalOpen = creating || userToDelete != null || userToEdit != null;
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

        <MemberHomeCard />

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
                      render: (row) => (
                        <span className="inline-flex items-center gap-2">
                          <span className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
                            <User size={14} className="text-accent" aria-hidden="true" />
                          </span>
                          <span className="font-semibold text-sm text-primary">
                            {row.display_name || row.username}
                          </span>
                        </span>
                      ),
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
                              content="An Admin can add users, change settings, manage drives, and see everything on this Luna."
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
                      render: (row) => (
                        <span className="flex items-center justify-center gap-1">
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
                          <Button
                            variant="ghost"
                            size="iconSm"
                            surface="secondary"
                            disabled={row.id === user.id || deleteMutation.isPending}
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
                      ),
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
        open={!!userToEdit}
        user={userToEdit}
        selfId={user?.id}
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
        message={`Remove "${userToDelete?.name}" from this Luna? They will lose access to shared drives.`}
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
function EditUserModal({ open, user: target, selfId, busy, submitError, onClose, onSubmit }) {
  const [name, setName] = useState(target?.display_name || target?.username || "");
  const [role, setRole] = useState(target?.role || "user");
  const [password, setPassword] = useState("");
  const isSelf = target?.id === selfId;
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
        error={name ? nameError : null}
        required
        surface="primary"
      />
      <div className="mb-4">
        <p className="text-secondary text-sm mb-1">Role</p>
        <Dropdown
          options={ROLE_OPTIONS}
          value={role}
          onChange={setRole}
          fullWidth
          bg="primary"
          disabled={isSelf}
          aria-label="Role"
        />
        <p className="text-secondary text-xs mt-1">
          {isSelf
            ? "You can't change your own role."
            : role === "admin"
              ? "An Admin can add users, manage drives and settings, and see everything except members' private folders."
              : "A Member gets a private folder and can use whatever is shared with them."}
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
        surface="primary"
      />
      {password ? <PasswordStrengthChecklist password={password} /> : null}
      {password ? (
        <p className="text-secondary text-xs mb-4">
          Setting a new password signs them out on every device.
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="outline" surface="primary" size="sm" onClick={onClose}>
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

/**
 * Where members' private Home folders live. The setting warns before it
 * moves anything — existing files travel one member at a time as real move
 * jobs, so nothing is half-copied.
 */
function MemberHomeCard() {
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const [pendingDrive, setPendingDrive] = useState(null);
  const [error, setError] = useState(null);

  const memberHome = useQuery({
    queryKey: ["member-home"],
    queryFn: () => getJson("/api/v1/users/member-home"),
  });
  const drives = useQuery({ queryKey: ["drives"], queryFn: getDrives });
  const users = useQuery({ queryKey: ["users"], queryFn: () => getJson("/api/v1/users") });
  // Home-move jobs (repins, plus deferred moves that started when a drive
  // came back) get live progress bars on this card. Poll fast while any
  // run, slowly otherwise so a catch-up move still shows up.
  const jobs = useQuery({
    queryKey: ["jobs"],
    queryFn: () => getJson("/api/v1/jobs"),
    refetchInterval: (q) =>
      (q.state.data || []).some((j) => j.state === "running" || j.state === "queued")
        ? 1000
        : 10000,
  });
  const homeMoves = (jobs.data || []).filter(
    (j) => j.member && (j.state === "running" || j.state === "queued"),
  );
  const memberName = (job) => {
    const u = (users.data || []).find((x) => x.id === job.user_id || x.username === job.member);
    return u?.display_name || job.member;
  };

  const move = useMutation({
    mutationFn: (driveId) => putJson("/api/v1/users/member-home", { drive_id: driveId }),
    onSuccess: (res) => {
      addToast({
        type: "success",
        message: res?.message || "Member files now live on the new drive.",
      });
      setPendingDrive(null);
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["member-home"] });
      queryClient.invalidateQueries({ queryKey: ["drives"] });
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (err) => {
      haptic("error");
      setError(apiErrorMessage(err, "Couldn't move member folders. Try again."));
    },
  });
  useStrandedErrorToast(error, pendingDrive != null, () => setError(null));

  const current = memberHome.data;
  const ready = (drives.data || []).filter(
    (d) => d.state === "as_is" && d.writable !== false,
  );
  const options = ready.map((d) => ({ value: d.id, label: d.label }));
  const currentLabel = current?.label || "None yet";

  return (
    <>
      <Card
        icon={House}
        title="Member folders"
        className="mt-5"
        headerActions={
          current?.drive_id ? (
            <Pill variant={current.configured ? "info" : "muted"}>
              {current.configured
                ? currentLabel
                : `${currentLabel} · automatic`}
            </Pill>
          ) : null
        }
      >
        <p className="text-primary text-sm">
          Every member gets a private{" "}
          <TermHint content="A member's own folder on this drive. Only they can open it — not even admins — unless they share something from inside it.">
            Home folder
          </TermHint>{" "}
          on this drive. Pick where those folders live.
        </p>
        {!current?.configured && current?.drive_id ? (
          <p className="text-primary text-sm mt-2">
            Luna is using {currentLabel} — it was the first drive added.
          </p>
        ) : null}
        {memberHome.isError ? (
          <p className="text-primary text-sm mt-2">
            Couldn't load where member folders live. Try again.
          </p>
        ) : null}
        <div className="mt-3">
          <Dropdown
            options={options}
            value={current?.drive_id || ""}
            onChange={(id) => {
              const drive = ready.find((d) => d.id === id);
              if (drive && drive.id !== current?.drive_id) {
                setPendingDrive(drive);
              }
            }}
            placeholder={ready.length ? "Choose a drive" : "No ready drives"}
            fullWidth
            bg="primary"
            disabled={!ready.length || memberHome.isLoading}
            aria-label="Drive for member folders"
          />
          {ready.length === 0 && !drives.isLoading ? (
            <p className="text-primary text-xs mt-2">
              Add a drive first — member folders need somewhere to live.
            </p>
          ) : null}
        </div>
        {homeMoves.length > 0 ? (
          <div className="mt-3 space-y-3">
            {homeMoves.map((job) => (
              <div key={job.id}>
                <p className="text-primary text-sm">
                  Moving {memberName(job)}'s folder
                  {job.state === "queued" ? " — waiting" : ""}
                </p>
                <p className="text-primary text-xs mt-1">
                  {job.total > 0
                    ? `${Math.min(100, Math.round((100 * job.progress) / job.total))}% done`
                    : "Starting…"}
                </p>
                <div className="mt-1.5 h-2 rounded-pill bg-primary overflow-hidden" aria-hidden="true">
                  <div
                    className="h-full bg-accent motion-safe:transition-all"
                    style={{
                      width: `${job.total > 0 ? Math.min(100, (100 * job.progress) / job.total) : 8}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </Card>

      <ConfirmModal
        open={!!pendingDrive}
        title="Move member folders?"
        message={`Members' private folders — and every file inside them — will move to "${pendingDrive?.label}". Luna does this in the background, one folder at a time; nothing disappears while a move is running.`}
        confirmLabel="Move folders"
        icon={House}
        loading={move.isPending}
        error={pendingDrive ? error : null}
        onConfirm={() => pendingDrive && move.mutate(pendingDrive.id)}
        onClose={() => {
          setPendingDrive(null);
          setError(null);
        }}
      />
    </>
  );
}
