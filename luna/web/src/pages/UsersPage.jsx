import { useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Shield, Trash2, User, UserPlus } from "lucide-react";
import Page from "../components/ui/Page";
import Card from "../components/cards/Card";
import ModalCard from "../components/cards/ModalCard";
import ConfirmModal from "../components/cards/ConfirmModal";
import Button from "../components/ui/Button";
import Pill from "../components/common/Pill";
import Table from "../components/common/Table";
import EmptyState from "../components/common/EmptyState";
import PageNotice from "../components/common/PageNotice";
import { showPageLevelError } from "../lib/modalScopedError";
import { InfoHint } from "../components/ui/Tooltip";
import { apiErrorMessage, deleteJson, getJson, postJson } from "../lib/api";
import { useAuth } from "../context/AuthContext";
import CreateUserForm from "../components/common/forms/CreateUserForm";

export default function UsersPage() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);
  const [userToDelete, setUserToDelete] = useState(null);

  const users = useQuery({
    queryKey: ["users"],
    queryFn: () => getJson("/api/v1/users"),
    enabled: user?.role === "admin",
  });

  const createMutation = useMutation({
    mutationFn: (body) => postJson("/api/v1/users", body),
    onSuccess: () => {
      setCreating(false);
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (err) => setError(apiErrorMessage(err, "Couldn't add this user. Try again.")),
  });
  const deleteMutation = useMutation({
    mutationFn: (id) => deleteJson(`/api/v1/users/${id}`),
    onSuccess: () => {
      setUserToDelete(null);
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (err) => {
      setError(apiErrorMessage(err, "Couldn't remove this user. Try again."));
    },
  });

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

  const actionModalOpen = creating || userToDelete != null;

  return (
    <>
      <Page
        title="Users"
        titleId="users-title"
        className={userToDelete ? "pop-out" : "pop-in"}
      >
        {showPageLevelError(error, actionModalOpen) && (
          <PageNotice variant="error" className="mb-4">
            {error}
          </PageNotice>
        )}

        {users.isError && (
          <PageNotice variant="error" className="mb-4">
            {String(users.error?.message || "Couldn't load users. Try again.")}
          </PageNotice>
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
                        <span className="flex items-center justify-center">
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
