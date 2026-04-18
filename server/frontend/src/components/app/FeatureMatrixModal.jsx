import { memo } from "react";
import { Layers } from "lucide-react";
import ModalCard from "../cards/ModalCard";
import FeatureMatrix from "./FeatureMatrix";
import { useCatalogFeatures } from "../../hooks/useCatalogFeatures";

function FeatureMatrixModal({ appId, onClose }) {
  const { data: features, isLoading, error } = useCatalogFeatures(appId);

  return (
    <ModalCard
      title={
        <span className="flex items-center gap-2">
          <Layers size={20} />
          Integration
        </span>
      }
      onClose={onClose}
      size="lg"
    >
      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary/30 border-t-accent"></div>
        </div>
      )}

      {error && (
        <div className="text-center py-12 text-error">
          Failed to load capabilities
        </div>
      )}

      {!isLoading && !error && features && (
        <FeatureMatrix features={features} />
      )}

      {!isLoading && !error && !features && (
        <div className="text-center py-12 text-primary/50">
          No capability information available
        </div>
      )}
    </ModalCard>
  );
}

export default memo(FeatureMatrixModal);
