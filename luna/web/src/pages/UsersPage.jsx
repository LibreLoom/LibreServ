import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { House, Pencil, Shield, Trash2, User, UserPlus } from "lucide-react";
import Page from "@libreloom/ui/components/ui/Page.jsx";
import Card from "@libreloom/ui/components/cards/Card.jsx";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import ConfirmModal from "@libreloom/ui/components/cards/ConfirmModal.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import Pill from "@libreloom/ui/components/common/Pill.jsx";
import Table from "@libreloom/ui/components/common/Table.jsx";
import SegmentedControl from "@libreloom/ui/components/common/SegmentedControl.jsx";
import Dropdown from "@libreloom/ui/components/common/Dropdown.jsx";
import EmptyState from "@libreloom/ui/components/common/EmptyState.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import { InfoHint, TermHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { apiErrorMessage, deleteJson, getDrives, getJson, postJson, putJson } from "../lib/api";
import { useAuth } from "../context/AuthContext";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import CreateUserForm from "../components/common/forms/CreateUserForm";
import useStrandedErrorToast from "../hooks/useStrandedErrorToast";
import { haptic } from "@libreloom/ui/utils/haptics.js";

export default function UsersPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { user } = useAuth();
  // You edit yourself in Settings → Security; everyone else gets a full page.
  const editPath = (row) => (row.id === user?.id ? "/settings#security" : `/settings/users/${row.id}`);
  const { addToast } = useToast();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);
  const [userToDelete, setUserToDelete] = useState(null);
  // Safe default: keep the person's files unless the Admin picks otherwise.
  const [keepFiles, setKeepFiles] = useState(true);

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
    mutationFn: (/** @type {{ id: string, keepFiles: boolean }} */ { id, keepFiles }) =>
      deleteJson(`/api/v1/users/${id}${keepFiles ? "?keep_files=1" : ""}`),
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

  const actionModalOpen = creating || userToDelete != null;
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
                              content="An Admin manages people, drives and settings. Admins have their own private My files too, and can't open yours."
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
                              content="A Member has their own private My files and can use what's shared with them. They can't manage people, drives or settings."
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
                            <Button
                              asChild
                              variant="ghost"
                              size="iconSm"
                              surface="secondary"
                              aria-label={`Edit ${row.display_name || row.username}`}
                            >
                              <Link to={editPath(row)}>
                                <Pencil size={16} aria-hidden="true" />
                              </Link>
                            </Button>
                            <Button
                              variant="ghost"
                              size="iconSm"
                              surface="secondary"
                              disabled={isSelf || deleteMutation.isPending}
                              onClick={() =>
                                {
                                  setKeepFiles(true);
                                  setUserToDelete({
                                    id: row.id,
                                    name: row.display_name || row.username,
                                    username: row.username,
                                  });
                                }
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
                  onRowClick={(row) => navigate(editPath(row))}
                  addRow={{
                    label: "Add user",
                    onClick: () => {
                      setError(null);
                      setCreating(true);
                    },
                  }}
                  mobileCards
                />
              </div>
            </Card>
          </section>
        )}

      </Page>

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
        message={`Remove "${userToDelete?.name}" from this Luna? They will lose access to shared drives.`}
        confirmLabel="Remove"
        variant="danger"
        icon={User}
        loading={deleteMutation.isPending}
        error={userToDelete ? error : null}
        onConfirm={() => userToDelete && deleteMutation.mutate({ id: userToDelete.id, keepFiles })}
        onClose={() => {
          setUserToDelete(null);
          setError(null);
        }}
      >
        <p className="text-sm mb-2">What should happen to their files?</p>
        <SegmentedControl
          surface="secondary"
          aria-label="What happens to their files"
          value={keepFiles ? "keep" : "delete"}
          onChange={(v) => setKeepFiles(v === "keep")}
          options={[
            { value: "keep", label: "Keep files" },
            { value: "delete", label: "Delete files" },
          ]}
        />
        <p className="text-sm mt-2">
          {keepFiles
            ? `Their files move into a shared folder named "${userToDelete?.username}'s files" (Luna adds a number if that name is taken) that Admins can open.`
            : "Their files move to the drive's trash."}
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

/**
 * Where everyone's private My files folders live. The setting warns before it
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
        message: res?.message || "Everyone's private folders now live on the new drive.",
      });
      setPendingDrive(null);
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["member-home"] });
      queryClient.invalidateQueries({ queryKey: ["drives"] });
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (err) => {
      haptic("error");
      setError(apiErrorMessage(err, "Couldn't move private folders. Try again."));
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
        title="Private folders"
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
          Everyone, Admins included, gets a private{" "}
          <TermHint content="Each person's own folder, shown as My files. Other people on this Luna can't open it through Luna unless its owner shares something from inside it.">
            My files
          </TermHint>{" "}
          folder on this drive. Pick where those folders live.
        </p>
        {!current?.configured && current?.drive_id ? (
          <p className="text-primary text-sm mt-2">
            Luna is using {currentLabel} — it was the first drive added.
          </p>
        ) : null}
        {memberHome.isError ? (
          <p className="text-primary text-sm mt-2">
            Couldn't load where private folders live. Try again.
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
            aria-label="Drive for private folders"
          />
          {ready.length === 0 && !drives.isLoading ? (
            <p className="text-primary text-xs mt-2">
              Add a drive first — private folders need somewhere to live.
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
                <div className="mt-1.5 h-2 rounded-pill surface-primary p-0.5 overflow-hidden" aria-hidden="true">
                  <div
                    className="h-full rounded-pill surface-secondary motion-safe:transition-all"
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
        title="Move private folders?"
        message={`Everyone's private folders — and every file inside them — will move to "${pendingDrive?.label}". Luna does this in the background, one folder at a time; nothing disappears while a move is running.`}
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
