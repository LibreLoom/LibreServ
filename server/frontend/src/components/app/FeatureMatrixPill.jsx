import { memo, useState } from "react";
import { ExternalLink } from "lucide-react";
import Button from "../ui/Button";
import FeatureMatrixModal from "./FeatureMatrixModal";

function FeatureMatrixPill({ appId, className = "" }) {
  const [showModal, setShowModal] = useState(false);

  return (
    <>
      <Button
        variant="outline"
        surface="secondary"
        fullWidth
        onClick={() => setShowModal(true)}
        className={className}
      >
        <ExternalLink size={14} />
        View Integration
      </Button>

      {showModal && (
        <FeatureMatrixModal appId={appId} onClose={() => setShowModal(false)} />
      )}
    </>
  );
}

export default memo(FeatureMatrixPill);