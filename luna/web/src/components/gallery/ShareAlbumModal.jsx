import { useState } from "react";
import PropTypes from "prop-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, Trash2 } from "lucide-react";
import ModalCard from "../cards/ModalCard";
import Button from "../ui/Button";
import CopyableValue from "../ui/CopyableValue";
import Dropdown from "../common/Dropdown";
import ModalErrorNotice from "../common/ModalErrorNotice";
import Spinner from "../ui/Spinner";
import { apiErrorMessage, deleteJson, getJson, postJson } from "../../lib/api";

/**
 * Format unix timestamp expiration into a human-readable label.
 * @param {number|null} ts
 */
function formatExpiration(ts) {
  if (!ts) return "Never expires";
  const ms = ts * 1000;
  const now = Date.now();
  if (ms < now) return "Expired";
  const days = Math.round((ms - now) / 86400000);
  if (days <= 1) return "Expires today";
  if (days < 30) return `Expires in ${days} days`;
  return `Expires ${new Date(ms).toLocaleDateString()}`;
}

/**
 * Modal to create and manage RO (view only) and RU (view and add photos)
 * sharing links for a photo album.
 *
 * @param {object} props
 * @param {boolean} props.open
 * @param {{ home_drive_id?: string, id?: string, name?: string } | null} [props.album]
 * @param {() => void} props.onClose
 * @param {string} [props.overlayClassName]
 */
export default function ShareAlbumModal({
  open,
  album,
  onClose,
  overlayClassName,
}) {
  const queryClient = useQueryClient();
  const [role, setRole] = useState("contributor");
  const [days, setDays] = useState("30");
  const [newLinkUrl, setNewLinkUrl] = useState(null);
  const [error, setError] = useState(null);

  const invitesQueryKey = ["album-invites", album?.home_drive_id, album?.id];

  const invites = useQuery({
    queryKey: invitesQueryKey,
    queryFn: () =>
      getJson(`/api/v1/gallery/albums/${album.home_drive_id}/${album.id}/invites`),
    enabled: open && !!album?.id && !!album?.home_drive_id,
  });

  const createInvite = useMutation({
    mutationFn: async () => {
      setError(null);
      const body = {
        role,
        expires_in_days: days ? Number(days) : undefined,
      };
      return postJson(
        `/api/v1/gallery/albums/${album.home_drive_id}/${album.id}/invites`,
        body,
      );
    },
    onSuccess: (data) => {
      const fullUrl = `${window.location.origin}${data.url}`;
      setNewLinkUrl(fullUrl);
      queryClient.invalidateQueries({ queryKey: invitesQueryKey });
      queryClient.invalidateQueries({ queryKey: ["gallery-albums"] });
    },
    onError: (err) => {
      setError(apiErrorMessage(err, "Luna couldn't create that share link. Try again."));
    },
  });

  const deleteInvite = useMutation({
    /** @param {string} inviteId */
    mutationFn: (inviteId) =>
      deleteJson(
        `/api/v1/gallery/albums/${album.home_drive_id}/${album.id}/invites/${inviteId}`,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: invitesQueryKey });
      queryClient.invalidateQueries({ queryKey: ["gallery-albums"] });
    },
    onError: (err) => {
      setError(apiErrorMessage(err, "Luna couldn't remove that share link. Try again."));
    },
  });

  const inviteList = invites.data || [];

  return (
    <ModalCard
      open={open}
      title={`Share "${album?.name || "album"}"`}
      onClose={() => {
        setNewLinkUrl(null);
        setError(null);
        onClose();
      }}
      overlayClassName={overlayClassName}
    >
      {({ close }) => (
        <div className="space-y-5">
          <ModalErrorNotice error={error} />

          {/* New link creation form */}
          <div className="rounded-large-element bg-primary text-secondary p-4 space-y-3">
            <p className="font-mono text-xs uppercase tracking-wider text-accent">
              Create a link
            </p>
            <div className="space-y-3">
              <label className="block text-sm">
                Permission
                <Dropdown
                  options={[
                    { value: "contributor", label: "Can view and add photos" },
                    { value: "viewer", label: "Can view only" },
                  ]}
                  value={role}
                  onChange={setRole}
                  fullWidth
                  surface="secondary"
                  className="mt-1"
                />
              </label>

              <label className="block text-sm">
                Link expiration
                <Dropdown
                  options={[
                    { value: "7", label: "Expires in 7 days" },
                    { value: "30", label: "Expires in 30 days" },
                    { value: "365", label: "Expires in a year" },
                    { value: "", label: "Never expires" },
                  ]}
                  value={days}
                  onChange={setDays}
                  fullWidth
                  surface="secondary"
                  className="mt-1"
                />
              </label>

              <Button
                variant="accent"
                loading={createInvite.isPending}
                onClick={() => createInvite.mutate()}
                className="w-full"
              >
                <Link2 size={16} aria-hidden="true" />
                Generate link
              </Button>
            </div>
          </div>

          {/* Newly generated link banner */}
          {newLinkUrl && (
            <div className="rounded-large-element bg-primary text-secondary p-4 space-y-2 border-2 border-accent">
              <p className="font-mono text-xs uppercase tracking-wider text-success">
                Link ready to share
              </p>
              <CopyableValue
                value={newLinkUrl}
                copyLabel="Copy link"
                surface="primary"
                ariaLabel="New album share link"
              />
            </div>
          )}

          {/* Existing links list */}
          <div className="space-y-2">
            <p className="font-mono text-xs uppercase tracking-wider text-accent">
              Active links ({inviteList.length})
            </p>

            {invites.isLoading ? (
              <div
                className="flex items-center justify-center gap-2 py-4 text-primary"
                role="status"
                aria-live="polite"
              >
                <p className="text-sm">Loading links…</p>
                <Spinner size="sm" decorative className="text-primary" />
              </div>
            ) : inviteList.length === 0 ? (
              <p className="text-sm text-accent py-2">
                No active share links yet. Generate one above to share this album.
              </p>
            ) : (
              <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                {inviteList.map((inv) => {
                  const fullUrl = `${window.location.origin}${inv.url}`;
                  const isContributor = inv.role === "contributor";
                  return (
                    <div
                      key={inv.id}
                      className="rounded-large-element bg-primary text-secondary p-3 flex flex-col gap-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className={`rounded-pill px-2.5 py-0.5 text-xs font-mono shrink-0 ${
                              isContributor
                                ? "bg-accent/20 text-secondary border border-accent/30"
                                : "bg-primary text-secondary border border-secondary/20"
                            }`}
                          >
                            {isContributor ? "Can view & add" : "View only"}
                          </span>
                          <span className="text-xs text-accent truncate">
                            {formatExpiration(inv.expires_at)}
                          </span>
                        </div>
                        <Button
                          variant="ghost"
                          size="iconSm"
                          surface="primary"
                          className="shrink-0 text-error hover:text-error"
                          aria-label="Revoke link"
                          title="Revoke link"
                          loading={deleteInvite.isPending && deleteInvite.variables === inv.id}
                          onClick={() => deleteInvite.mutate(inv.id)}
                        >
                          <Trash2 size={16} aria-hidden="true" />
                        </Button>
                      </div>
                      <CopyableValue
                        value={fullUrl}
                        copyLabel="Copy"
                        surface="primary"
                        ariaLabel="Active share link"
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex justify-end pt-2">
            <Button variant="outline" onClick={close}>
              Done
            </Button>
          </div>
        </div>
      )}
    </ModalCard>
  );
}

ShareAlbumModal.propTypes = {
  open: PropTypes.bool.isRequired,
  album: PropTypes.shape({
    home_drive_id: PropTypes.string,
    id: PropTypes.string,
    name: PropTypes.string,
  }),
  onClose: PropTypes.func.isRequired,
  overlayClassName: PropTypes.string,
};
