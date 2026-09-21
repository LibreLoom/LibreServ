import { useState } from "react";
import PropTypes from "prop-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import ModalCard, { NESTED_OVERLAY_CLASS } from "@libreloom/ui/components/cards/ModalCard.jsx";
import AlbumMembersPanel from "./AlbumMembersPanel.jsx";
import CreateAlbumLinkModal from "./CreateAlbumLinkModal.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import CopyableValue from "@libreloom/ui/components/ui/CopyableValue.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import Spinner from "@libreloom/ui/components/ui/Spinner.jsx";
import { apiErrorMessage, deleteJson, getJson } from "../../lib/api";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { ICON_SIZE } from "@libreloom/ui/lib/ui-tokens.js";

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
 * Album sharing sheet — same structure as AccessSheet for files: a "Users"
 * section (people on this Luna) and a "Link" section (share links, with
 * creation pushed into a nested "New link" dialog).
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
  const { addToast } = useToast();
  const [creatingLink, setCreatingLink] = useState(false);
  const [error, setError] = useState(null);

  const invitesQueryKey = ["album-invites", album?.home_drive_id, album?.id];

  const invites = useQuery({
    queryKey: invitesQueryKey,
    queryFn: () =>
      getJson(`/api/v1/gallery/albums/${album.home_drive_id}/${album.id}/invites`),
    enabled: open && !!album?.id && !!album?.home_drive_id,
  });

  const deleteInvite = useMutation({
    /** @param {string} inviteId */
    mutationFn: (inviteId) =>
      deleteJson(
        `/api/v1/gallery/albums/${album.home_drive_id}/${album.id}/invites/${inviteId}`,
      ),
    onSuccess: () => {
      addToast({ type: "success", message: "Link removed." });
      queryClient.invalidateQueries({ queryKey: invitesQueryKey });
      queryClient.invalidateQueries({ queryKey: ["gallery-albums"] });
    },
    onError: (err) => {
      haptic("error");
      setError(apiErrorMessage(err, "Luna couldn't remove that share link. Try again."));
    },
  });

  const inviteList = invites.data || [];

  return (
    <>
      <ModalCard
        open={open}
        title="Sharing"
        onClose={() => {
          setError(null);
          onClose();
        }}
        overlayClassName={overlayClassName}
      >
        <div className="space-y-5" data-slot="share-album-modal">
          {error && <PageNotice variant="error">{error}</PageNotice>}

          {open && album?.home_drive_id && album?.id && (
            <AlbumMembersPanel
              album={{
                home_drive_id: album.home_drive_id,
                id: album.id,
                name: album.name,
              }}
            />
          )}

          <section className="space-y-2">
            <h3 className="text-primary text-sm font-semibold">Link</h3>

            {invites.isLoading ? (
              <div
                className="flex items-center justify-center gap-2 py-4 text-primary"
                role="status"
                aria-live="polite"
              >
                <p className="text-sm">Loading links…</p>
                <Spinner size="sm" decorative className="text-primary" />
              </div>
            ) : (
              inviteList.map((inv) => {
                const fullUrl = `${window.location.origin}${inv.url}`;
                return (
                  <div
                    key={inv.id}
                    className="flex items-center justify-between gap-2 rounded-large-element bg-primary text-secondary p-3"
                  >
                    <div className="min-w-0">
                      <p className="text-secondary text-xs">
                        {inv.role === "contributor" ? "Can view & add" : "Can view only"}
                        {" · "}
                        {formatExpiration(inv.expires_at)}
                      </p>
                      <CopyableValue
                        className="mt-2"
                        value={fullUrl}
                        copyLabel="Copy"
                        surface="primary"
                        ariaLabel="Share link address"
                      />
                    </div>
                    <Button
                      size="iconSm"
                      variant="danger"
                      aria-label="Remove this link"
                      loading={deleteInvite.isPending && deleteInvite.variables === inv.id}
                      onClick={() => deleteInvite.mutate(inv.id)}
                    >
                      <Trash2 size={ICON_SIZE.xs} />
                    </Button>
                  </div>
                );
              })
            )}
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                setError(null);
                setCreatingLink(true);
              }}
            >
              New link
            </Button>
          </section>
        </div>
      </ModalCard>
      {creatingLink && album && (
        <CreateAlbumLinkModal
          open
          album={album}
          overlayClassName={NESTED_OVERLAY_CLASS}
          onClose={() => setCreatingLink(false)}
          onDone={() => {
            setCreatingLink(false);
            queryClient.invalidateQueries({ queryKey: invitesQueryKey });
            queryClient.invalidateQueries({ queryKey: ["gallery-albums"] });
          }}
        />
      )}
    </>
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
