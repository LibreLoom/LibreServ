import { useState } from "react";
import PropTypes from "prop-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserMinus, UserPlus } from "lucide-react";
import Button from "../ui/Button.jsx";
import Dropdown from "../common/Dropdown.jsx";
import ModalErrorNotice from "../common/ModalErrorNotice.jsx";
import Spinner from "../ui/Spinner.jsx";
import { apiErrorMessage, deleteJson, getJson, putJson } from "../../lib/api";

/**
 * Minimal album members list + add/remove for the album owner.
 * Uses /api/v1/users when the signed-in user can list them (Admin);
 * otherwise only shows existing members.
 *
 * @param {{ album: { home_drive_id: string, id: string, name?: string } }} props
 */
export default function AlbumMembersPanel({ album }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState(null);
  const [pickUser, setPickUser] = useState("");

  const members = useQuery({
    queryKey: ["album-members", album.home_drive_id, album.id],
    queryFn: () =>
      getJson(`/api/v1/gallery/albums/${album.home_drive_id}/${album.id}/members`),
  });

  const users = useQuery({
    queryKey: ["users-for-album"],
    queryFn: () => getJson("/api/v1/users"),
    retry: false,
  });

  const addMember = useMutation({
    mutationFn: (userId) =>
      putJson(`/api/v1/gallery/albums/${album.home_drive_id}/${album.id}/members`, {
        user_id: userId,
        role: "contributor",
      }),
    onSuccess: () => {
      setPickUser("");
      queryClient.invalidateQueries({
        queryKey: ["album-members", album.home_drive_id, album.id],
      });
    },
    onError: (err) => setError(apiErrorMessage(err, "Luna couldn't add that person.")),
  });

  const removeMember = useMutation({
    mutationFn: (userId) =>
      deleteJson(
        `/api/v1/gallery/albums/${album.home_drive_id}/${album.id}/members/${userId}`,
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["album-members", album.home_drive_id, album.id],
      }),
    onError: (err) => setError(apiErrorMessage(err, "Luna couldn't remove that person.")),
  });

  const list = members.data || [];
  const userOptions = (users.data || [])
    .filter((u) => !list.some((m) => m.user_id === u.id))
    .map((u) => ({
      value: u.id,
      label: u.display_name || u.username || u.id,
    }));

  return (
    <div
      data-slot="album-members"
      className="mb-4 rounded-large-element bg-secondary text-primary p-4 space-y-3"
    >
      <p className="font-mono text-sm">People with access</p>
      <ModalErrorNotice error={error} />
      {members.isLoading ? (
        <div className="flex items-center gap-2 py-2">
          <Spinner size="sm" decorative />
          <p className="text-sm">Loading…</p>
        </div>
      ) : list.length === 0 ? (
        <p className="text-sm">Only you can open this album right now.</p>
      ) : (
        <ul className="space-y-2">
          {list.map((m) => (
            <li
              key={m.user_id}
              className="flex items-center justify-between gap-2 rounded-pill bg-primary text-secondary px-3 py-2"
            >
              <span className="text-sm font-mono truncate">
                {m.user_id}
                {m.role ? ` · ${m.role}` : ""}
              </span>
              <Button
                variant="ghost"
                size="iconSm"
                surface="primary"
                aria-label={`Remove ${m.user_id}`}
                loading={removeMember.isPending && removeMember.variables === m.user_id}
                onClick={() => removeMember.mutate(m.user_id)}
              >
                <UserMinus size={16} />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {userOptions.length > 0 && (
        <div className="flex flex-wrap items-end gap-2 pt-1">
          <div className="min-w-[12rem] flex-1">
            <Dropdown
              options={userOptions}
              value={pickUser}
              onChange={setPickUser}
              fullWidth
              surface="secondary"
              placeholder="Add a person…"
            />
          </div>
          <Button
            variant="accent"
            size="sm"
            disabled={!pickUser}
            loading={addMember.isPending}
            onClick={() => addMember.mutate(pickUser)}
          >
            <UserPlus size={14} /> Add
          </Button>
        </div>
      )}
    </div>
  );
}

AlbumMembersPanel.propTypes = {
  album: PropTypes.shape({
    home_drive_id: PropTypes.string.isRequired,
    id: PropTypes.string.isRequired,
    name: PropTypes.string,
  }).isRequired,
};
