import { useState } from "react";
import PropTypes from "prop-types";
import { useMutation } from "@tanstack/react-query";
import ModalCard from "../cards/ModalCard";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import CopyableValue from "@libreloom/ui/components/ui/CopyableValue.jsx";
import Dropdown from "../common/Dropdown";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import Toggle from "@libreloom/ui/components/common/Toggle.jsx";
import { apiErrorMessage, postJson } from "../../lib/api";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { useToast } from "../../context/ToastContext.jsx";

const LINK_ERROR = "Couldn't create that link. Try again.";

const ALBUM_LINK_PERMISSIONS = [
  { value: "viewer", label: "Can view only" },
  { value: "contributor", label: "Can view and add photos" },
];

/**
 * Create one share link for an album — the nested dialog ShareAlbumModal
 * opens behind "New link", mirroring CreateShareModal for files.
 *
 * @param {{
 *   open: boolean,
 *   album?: { home_drive_id?: string, id?: string, name?: string } | null,
 *   onClose: () => void,
 *   onDone: () => void,
 *   overlayClassName?: string,
 * }} props
 */
export default function CreateAlbumLinkModal({
  open,
  album,
  onClose,
  onDone,
  overlayClassName,
}) {
  const { addToast } = useToast();
  const [role, setRole] = useState("viewer");
  const [days, setDays] = useState("30");
  const [allowUploads, setAllowUploads] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(/** @type {string|null} */ (null));

  const mutation = useMutation({
    mutationFn: (/** @type {object} */ body) =>
      postJson(
        `/api/v1/gallery/albums/${album.home_drive_id}/${album.id}/invites`,
        body,
      ),
    onMutate: () => setError(null),
    onSuccess: (data) => {
      if (!data?.url) {
        haptic("error");
        setError(LINK_ERROR);
        return;
      }
      addToast({ type: "success", message: "Link created." });
      setResult({ ...data, fullUrl: `${window.location.origin}${data.url}` });
    },
    onError: (err) => {
      haptic("error");
      setError(apiErrorMessage(err, LINK_ERROR));
    },
  });

  if (result) {
    return (
      <ModalCard open={open} title="Link ready" onClose={onDone} overlayClassName={overlayClassName}>
        {({ close }) => (
          <>
            <CopyableValue
              value={result.fullUrl}
              copyLabel="Copy"
              ariaLabel="Album share link"
            />
            <div className="mt-4 flex gap-3">
              <Button variant="outline" onClick={close}>Done</Button>
            </div>
          </>
        )}
      </ModalCard>
    );
  }

  return (
    <ModalCard open={open} title="New link" onClose={onClose} overlayClassName={overlayClassName}>
      {({ close }) => (
        <div className="space-y-3">
          {error && <PageNotice variant="error">{error}</PageNotice>}
          <Dropdown
            options={ALBUM_LINK_PERMISSIONS}
            value={role}
            onChange={(next) => {
              setRole(next);
              if (next !== "contributor") setAllowUploads(false);
            }}
            fullWidth
            bg="primary"
            aria-label="What people with this link can do"
          />
          <p className="text-primary text-xs">
            <span className="text-primary font-semibold">Can view only</span>{" "}
            opens the album.{" "}
            <span className="text-primary font-semibold">Can view and add photos</span>{" "}
            lets people add their own.
          </p>
          {role === "contributor" && (
            <Toggle
              checked={allowUploads}
              onChange={setAllowUploads}
              label="Allow uploads"
              description="People with this link can add photos to a shared folder on this album."
              surface="secondary"
            />
          )}
          <Dropdown
            options={[
              { value: "7", label: "Expires in 7 days" },
              { value: "30", label: "Expires in 30 days" },
              { value: "90", label: "Expires in 90 days" },
              { value: "365", label: "Expires in a year" },
            ]}
            value={days}
            onChange={setDays}
            fullWidth
            bg="primary"
          />
          <div className="flex gap-3">
            <Button
              variant="primary"
              fullWidth
              loading={mutation.isPending}
              onClick={() =>
                mutation.mutate({
                  role,
                  expires_in_days: Number(days),
                  ...(role === "contributor" ? { allow_uploads: allowUploads } : {}),
                })
              }
            >
              Create link
            </Button>
            <Button variant="outline" onClick={close} disabled={mutation.isPending}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </ModalCard>
  );
}

CreateAlbumLinkModal.propTypes = {
  open: PropTypes.bool.isRequired,
  album: PropTypes.shape({
    home_drive_id: PropTypes.string,
    id: PropTypes.string,
    name: PropTypes.string,
  }),
  onClose: PropTypes.func.isRequired,
  onDone: PropTypes.func.isRequired,
  overlayClassName: PropTypes.string,
};
