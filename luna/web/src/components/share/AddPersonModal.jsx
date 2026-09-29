import { useState } from "react";
import PropTypes from "prop-types";
import { useMutation } from "@tanstack/react-query";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import Dropdown from "@libreloom/ui/components/common/Dropdown.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import ShakeTarget from "@libreloom/ui/components/ui/ShakeTarget.jsx";
import Toggle from "@libreloom/ui/components/common/Toggle.jsx";
import { postJson, apiErrorMessage } from "../../lib/api";
import { capsHint, joinShareCaps } from "../../lib/access.js";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";

/**
 * Give one Luna user access to a subject — the member counterpart of
 * CreateLinkModal. `people` and `options` arrive pre-filtered by the share
 * sheet (not already a member, levels the caller can grant).
 *
 * @param {{
 *   subject: { kind: string, drive_id: string, path?: string, album_id?: string },
 *   people: { id: string, username: string, display_name?: string }[],
 *   options: { value: string, label: string }[],
 *   hintFor: { album: boolean, file: boolean, form: boolean },
 *   open?: boolean,
 *   onClose: () => void,
 *   onDone: () => void,
 *   overlayClassName?: string,
 * }} props
 */
export default function AddPersonModal({
  subject,
  people,
  options,
  hintFor,
  open = true,
  onClose,
  onDone,
  overlayClassName,
}) {
  const { addToast } = useToast();
  const [personId, setPersonId] = useState("");
  const [caps, setCaps] = useState(options[0]?.value || "");
  const [shareBit, setShareBit] = useState(false);
  const [error, setError] = useState(/** @type {string|null} */ (null));

  const picked = options.some((o) => o.value === caps) ? caps : options[0]?.value || "";

  const mutation = useMutation({
    mutationFn: (/** @type {Record<string, unknown>} */ body) => postJson("/api/v1/access/members", body),
    onMutate: () => setError(null),
    onSuccess: () => {
      addToast({ type: "success", message: "Access granted." });
      onDone();
    },
    onError: (err) => {
      haptic("error");
      setError(apiErrorMessage(err, "Couldn't grant access. Try again."));
    },
  });

  return (
    <ModalCard open={open} title="Add a person" onClose={onClose} overlayClassName={overlayClassName}>
      {({ close }) => (
        <div className="space-y-3">
          {error && <PageNotice variant="error">{error}</PageNotice>}
          <ShakeTarget shake={error}>
            <Dropdown
              options={people.map((u) => ({ value: u.id, label: u.display_name || u.username }))}
              value={personId}
              onChange={setPersonId}
              placeholder="Pick someone"
              fullWidth
              bg="primary"
              aria-label="Person"
            />
          </ShakeTarget>
          <Dropdown
            options={options}
            value={picked}
            onChange={setCaps}
            fullWidth
            bg="primary"
            aria-label="Access level"
          />
          <p className="text-primary text-xs">{capsHint(picked, hintFor)}</p>
          <div className="rounded-large-element surface-primary p-3">
            <Toggle
              surface="primary"
              checked={shareBit}
              onChange={setShareBit}
              label="Can share"
              description="They can pass this access on and create links."
            />
          </div>
          <div className="flex gap-3">
            <Button
              variant="primary"
              fullWidth
              loading={mutation.isPending}
              disabled={!personId || !picked}
              onClick={() =>
                mutation.mutate({
                  kind: subject.kind,
                  drive_id: subject.drive_id,
                  path: subject.path || "",
                  album_id: subject.album_id || "",
                  user_id: personId,
                  caps: joinShareCaps(picked, shareBit),
                })
              }
            >
              Add
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

AddPersonModal.propTypes = {
  subject: PropTypes.shape({
    kind: PropTypes.string,
    drive_id: PropTypes.string,
    path: PropTypes.string,
    album_id: PropTypes.string,
  }).isRequired,
  people: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string.isRequired,
    username: PropTypes.string,
    display_name: PropTypes.string,
  })).isRequired,
  options: PropTypes.arrayOf(PropTypes.shape({
    value: PropTypes.string.isRequired,
    label: PropTypes.string.isRequired,
  })).isRequired,
  hintFor: PropTypes.shape({
    album: PropTypes.bool,
    file: PropTypes.bool,
    form: PropTypes.bool,
  }).isRequired,
  open: PropTypes.bool,
  onClose: PropTypes.func.isRequired,
  onDone: PropTypes.func.isRequired,
  overlayClassName: PropTypes.string,
};
