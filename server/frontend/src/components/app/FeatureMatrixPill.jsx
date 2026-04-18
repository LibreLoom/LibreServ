import { memo, useState } from "react";
import { Layers, ExternalLink } from "lucide-react";
import FeatureMatrixModal from "./FeatureMatrixModal";

function FeatureMatrixPill({ appId, className = "" }) {
  const [showModal, setShowModal] = useState(false);

  return (
    <>
      <button
        onClick={() => setShowModal(true)}
        className={`w-full flex items-center justify-center gap-2 px-4 py-2 rounded-pill border-2 border-accent/30 text-accent hover:bg-accent/10 motion-safe:transition-all font-mono text-sm ${className}`}
      >
        <ExternalLink size={14} />
        View Integration
      </button>

      {showModal && (
        <FeatureMatrixModal appId={appId} onClose={() => setShowModal(false)} />
      )}
    </>
  );
}

export default memo(FeatureMatrixPill);
