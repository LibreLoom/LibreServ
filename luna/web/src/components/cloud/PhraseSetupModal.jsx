import PropTypes from "prop-types";
import { useQueryClient } from "@tanstack/react-query";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { useAuth } from "../../context/AuthContext";
import { PHRASE_QUERY_KEY } from "../../lib/cloudPhrase";
import PhraseStep from "../setup/PhraseStep.jsx";

/**
 * Makes a recovery phrase in a dialog, wherever one turns out to be needed: the Settings card
 * when none is saved yet, and "Back up to the cloud" the first time. Nothing blocks the app on
 * this — a phrase only opens cloud backups, so it is asked for at the moment one is started.
 *
 * `overlayClassName` lets a caller open this above its own dialog (ProtectSheet does).
 */
export default function PhraseSetupModal({
  open = true,
  onClose,
  onSaved = null,
  overlayClassName = "",
}) {
  const { refresh } = useAuth();
  const queryClient = useQueryClient();
  const { addToast } = useToast();

  async function saved() {
    addToast({ type: "success", message: "Recovery phrase saved." });
    queryClient.invalidateQueries({ queryKey: PHRASE_QUERY_KEY });
    await refresh();
    onSaved?.();
    onClose();
  }

  return (
    <ModalCard
      open={open}
      title="Set up your recovery phrase"
      onClose={onClose}
      size="md"
      overlayClassName={overlayClassName}
    >
      <PhraseStep
        onSaved={saved}
        saveLabel="Save recovery phrase"
        titles={{ show: "", confirm: "Confirm your recovery phrase" }}
      />
    </ModalCard>
  );
}

PhraseSetupModal.propTypes = {
  open: PropTypes.bool,
  onClose: PropTypes.func.isRequired,
  onSaved: PropTypes.func,
  overlayClassName: PropTypes.string,
};
