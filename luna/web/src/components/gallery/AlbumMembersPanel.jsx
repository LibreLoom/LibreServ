import { useState } from "react";
import PropTypes from "prop-types";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import Dropdown from "../common/Dropdown.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import Spinner from "@libreloom/ui/components/ui/Spinner.jsx";
import { TermHint } from "@libreloom/ui/components/ui/Tooltip.jsx";
import { useAuth } from "../../context/AuthContext";
import { useToast } from "../../context/ToastContext.jsx";
import { apiErrorMessage, deleteJson, getJson, putJson } from "../../lib/api";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";

const MEMBER_ROLE_OPTIONS = [
  { value: "viewer", label: "Can view" },
  { value: "contributor", label: "Can add photos" },
];

/**
 * The "Users" section of ShareAlbumModal — the same shape AccessSheet uses
 * for folder sharing: a row per person (permission dropdown + remove), then
 * an add-person flow, or a card explaining there is nobody to add.
 * Uses /api/v1/users/directory so Members who own albums can pick people
 * without the Admin-only user management API.
 *
 * @param {{ album: { home_drive_id: string, id: string, name?: string } }} props
 */
export default function AlbumMembersPanel({ album }) {
  const { addToast } = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const queryClient = useQueryClient();
  const [error, setError] = useState(null);
  const [pickUser, setPickUser] = useState("");
  const [pickRole, setPickRole] = useState("viewer");
  const [updatingUserId, setUpdatingUserId] = useState(null);

  const members = useQuery({
    queryKey: ["album-members", album.home_drive_id, album.id],
    queryFn: () =>
      getJson(`/api/v1/gallery/albums/${album.home_drive_id}/${album.id}/members`),
  });

  const users = useQuery({
    queryKey: ["users-directory"],
    queryFn: () => getJson("/api/v1/users/directory"),
    retry: false,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: ["album-members", album.home_drive_id, album.id],
    });

  const addMember = useMutation({
    /** @param {string} userId */
    mutationFn: async (userId) =>
      putJson(`/api/v1/gallery/albums/${album.home_drive_id}/${album.id}/members`, {
        user_id: userId,
        role: pickRole,
      }),
    onSuccess: () => {
      addToast({ type: "success", message: "Added to the album." });
      setPickUser("");
      setError(null);
      invalidate();
    },
    onError: (err) => setError(apiErrorMessage(err, "Luna couldn't add that person.")),
  });

  const updateRole = useMutation({
    /** @param {{ userId: string, role: string }} args */
    mutationFn: async ({ userId, role }) =>
      putJson(`/api/v1/gallery/albums/${album.home_drive_id}/${album.id}/members`, {
        user_id: userId,
        role,
      }),
    onMutate: ({ userId }) => setUpdatingUserId(userId),
    onSuccess: () => {
      addToast({ type: "success", message: "Access updated." });
      setError(null);
      invalidate();
    },
    onError: (err) =>
      setError(apiErrorMessage(err, "Luna couldn't change that person's access.")),
    onSettled: () => setUpdatingUserId(null),
  });

  const removeMember = useMutation({
    mutationFn: (userId) =>
      deleteJson(
        `/api/v1/gallery/albums/${album.home_drive_id}/${album.id}/members/${userId}`,
      ),
    onSuccess: () => {
      addToast({ type: "success", message: "Removed from the album." });
      invalidate();
    },
    onError: (err) => setError(apiErrorMessage(err, "Luna couldn't remove that person.")),
  });

  const list = members.data || [];
  const directory = users.data || [];
  const labelFor = (userId) => {
    const match = directory.find((u) => u.id === userId);
    return match?.display_name || match?.username || userId;
  };
  // Same rule as AccessSheet: admins already have access to everything, and
  // you can't share your own album with yourself.
  const userOptions = directory
    .filter((u) => u.role !== "admin" && u.id !== user?.id)
    .filter((u) => !list.some((m) => m.user_id === u.id))
    .map((u) => ({
      value: u.id,
      label: u.display_name || u.username || u.id,
    }));
  const noPeopleToAdd = users.isSuccess && userOptions.length === 0;

  return (
    <section className="space-y-2" data-slot="album-members">
      <h3 className="text-primary text-sm font-semibold">Users</h3>
      {error && <PageNotice variant="error">{error}</PageNotice>}
      {members.isLoading ? (
        <div className="flex items-center gap-2 py-2">
          <Spinner size="sm" decorative />
          <p className="text-sm">Loading…</p>
        </div>
      ) : (
        list.map((m) => {
          const name = labelFor(m.user_id);
          return (
            <div
              key={m.user_id}
              className="flex items-center justify-between gap-2 rounded-large-element bg-primary text-secondary p-3"
            >
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                <span className="text-secondary text-xs truncate">{name}</span>
                <Dropdown
                  options={MEMBER_ROLE_OPTIONS}
                  value={m.role === "contributor" ? "contributor" : "viewer"}
                  onChange={(next) => updateRole.mutate({ userId: m.user_id, role: next })}
                  disabled={updatingUserId === m.user_id}
                  aria-label={`Access for ${name}`}
                  bg="secondary"
                />
              </div>
              <Button
                size="iconSm"
                variant="danger"
                aria-label={`Remove access for ${name}`}
                loading={removeMember.isPending && removeMember.variables === m.user_id}
                onClick={() => removeMember.mutate(m.user_id)}
              >
                <Trash2 size={ICON_SIZE.xs} />
              </Button>
            </div>
          );
        })
      )}
      {noPeopleToAdd ? (
        <div className="space-y-3 rounded-large-element bg-primary text-secondary p-3">
          <p className="text-secondary text-sm">
            {directory.length === 0
              ? isAdmin
                ? "No people to share with yet. Add a Member on the Users page."
                : "No people to share with yet. Ask an Admin to add people on this Luna."
              : "Everyone already has access."}
          </p>
          {isAdmin && directory.length === 0 && (
            <Button variant="secondary" surface="primary" size="sm" asChild>
              <Link to="/settings/users">Go to Users</Link>
            </Button>
          )}
        </div>
      ) : (
        <>
          <Dropdown
            options={userOptions}
            value={pickUser}
            onChange={setPickUser}
            fullWidth
            bg="primary"
            placeholder="Add a person"
          />
          <Dropdown
            options={MEMBER_ROLE_OPTIONS}
            value={pickRole}
            onChange={setPickRole}
            fullWidth
            bg="primary"
          />
          <p className="text-primary text-xs">
            <TermHint content="Can open this album, but cannot add or remove photos.">
              Can view
            </TermHint>
            {" "}opens the album.{" "}
            <TermHint content="Can open this album and add their own photos to it.">
              Can add photos
            </TermHint>
            {" "}can also add their own pictures.
          </p>
          <Button
            variant="primary"
            size="sm"
            disabled={!pickUser}
            loading={addMember.isPending}
            onClick={() => addMember.mutate(pickUser)}
          >
            Add
          </Button>
        </>
      )}
    </section>
  );
}

AlbumMembersPanel.propTypes = {
  album: PropTypes.shape({
    home_drive_id: PropTypes.string.isRequired,
    id: PropTypes.string.isRequired,
    name: PropTypes.string,
  }).isRequired,
};
