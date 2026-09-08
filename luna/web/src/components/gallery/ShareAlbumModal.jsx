import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import ModalCard from "../cards/ModalCard.jsx";
import Button from "../ui/Button.jsx";
import ModalErrorNotice from "../common/ModalErrorNotice.jsx";
import { apiErrorMessage, getJson, postJson } from "../../lib/api";

/**
 * Share an album via invite links (viewer or contributor).
 *
 * @param {{
 *   open: boolean,
 *   album?: { id: string, home_drive_id: string, name: string } | null,
 *   onClose: () => void,
 *   overlayClassName?: string,
 * }} props
 */
export default function ShareAlbumModal({ open, album, onClose, overlayClassName }) {
  const [invites, setInvites] = useState(/** @type {Array<{ id: string, role: string, url: string }>} */ ([]));
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!open || !album) return undefined;
    let cancelled = false;
    setError(null);
    (async () => {
      try {
        const list = await getJson(
          `/api/v1/gallery/albums/${album.home_drive_id}/${album.id}/invites`,
        );
        if (!cancelled) setInvites(Array.isArray(list) ? list : []);
      } catch (err) {
        if (!cancelled) setError(apiErrorMessage(err, "Luna couldn't load invite links."));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, album]);

  if (!album) return null;

  const roleLabel = (role) =>
    role === "contributor" ? "Can view & add" : "Can view";

  return (
    <ModalCard
      open={open}
      title={`Share "${album.name}"`}
      onClose={onClose}
      overlayClassName={overlayClassName}
    >
      {({ close }) => (
        <div className="space-y-4">
          <ModalErrorNotice error={error} />

          <div className="space-y-2">
            <p className="font-mono text-sm">Create a link</p>
            <Button
              variant="accent"
              loading={creating}
              onClick={async () => {
                setCreating(true);
                setError(null);
                try {
                  const invite = await postJson(
                    `/api/v1/gallery/albums/${album.home_drive_id}/${album.id}/invites`,
                    { role: "contributor" },
                  );
                  setInvites((prev) => [...prev, invite]);
                } catch (err) {
                  setError(apiErrorMessage(err, "Luna couldn't create an invite link."));
                } finally {
                  setCreating(false);
                }
              }}
            >
              Generate link
            </Button>
          </div>

          {invites.length > 0 && (
            <ul className="space-y-2">
              {invites.map((invite) => (
                <li key={invite.id} className="text-sm">
                  <span className="font-mono">{roleLabel(invite.role)}</span>
                </li>
              ))}
            </ul>
          )}

          <Button type="button" variant="outline" onClick={close}>
            Done
          </Button>
        </div>
      )}
    </ModalCard>
  );
}

ShareAlbumModal.propTypes = {
  open: PropTypes.bool,
  album: PropTypes.shape({
    id: PropTypes.string.isRequired,
    home_drive_id: PropTypes.string.isRequired,
    name: PropTypes.string.isRequired,
  }),
  onClose: PropTypes.func.isRequired,
  overlayClassName: PropTypes.string,
};
