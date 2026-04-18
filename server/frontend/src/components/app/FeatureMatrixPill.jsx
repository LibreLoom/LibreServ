import { memo } from "react";
import { Layers, Loader2 } from "lucide-react";
import CollapsibleSection from "../common/CollapsibleSection";
import FeatureMatrix from "./FeatureMatrix";
import { useCatalogFeatures } from "../../hooks/useCatalogFeatures";

function FeatureMatrixPill({ appId, className = "" }) {
  const { data: features, isLoading, error } = useCatalogFeatures(appId);

  const importantCount = features
    ? [
        features.access_model,
        features.sso,
        features.backup === "supported",
        features.custom_domains,
      ].filter(Boolean).length
    : 0;

  return (
    <div className={className}>
      <CollapsibleSection
        title={
          <span className="flex items-center gap-2">
            <Layers size={14} />
            Integration
            {importantCount > 0 && (
              <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-accent/20 text-accent text-xs font-mono font-medium">
                {importantCount}
              </span>
            )}
          </span>
        }
        defaultOpen={false}
        pill
        mono
        size="sm"
      >
        {isLoading && (
          <div className="flex items-center gap-2 py-3 text-primary/50">
            <Loader2 size={14} className="animate-spin" />
            <span className="text-xs font-mono">Loading capabilities...</span>
          </div>
        )}

        {error && (
          <div className="py-3 text-xs text-error">
            Failed to load capabilities
          </div>
        )}

        {!isLoading && !error && features && (
          <div className="pt-2">
            <FeatureMatrix features={features} compact />
          </div>
        )}
      </CollapsibleSection>
    </div>
  );
}

export default memo(FeatureMatrixPill);
