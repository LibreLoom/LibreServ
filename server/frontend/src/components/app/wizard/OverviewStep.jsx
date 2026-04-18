import { memo } from "react";
import { AlertTriangle, Info, HardDrive, Cpu, MemoryStick } from "lucide-react";
import AppIcon from "../../common/AppIcon";
import FeatureMatrix from "../FeatureMatrix";

const ACCESS_MODEL_INFO = {
  shared_account: {
    icon: AlertTriangle,
    label: "Shared Account",
    message:
      "All users will access this app with the same login. Anyone who can open the app has full access.",
    variant: "warning",
  },
  external_auth: {
    icon: Info,
    label: "Separate Accounts",
    message:
      "This app manages its own user accounts. You'll set up users directly in the app after installation.",
    variant: "info",
  },
  public: {
    icon: Info,
    label: "Public Access",
    message:
      "This app doesn't require login. Anyone with the address can access it.",
    variant: "info",
  },
  integrated_users: {
    icon: Info,
    label: "LibreServ Accounts",
    message:
      "Users can log in with their LibreServ accounts. Each person gets their own private space.",
    variant: "info",
  },
};

function RequirementBadge({ icon: Icon, label, value, warning }) {
  return (
    <div
      className={`
        flex items-center gap-2 px-3 py-2 rounded-large-element
        ${warning ? "bg-secondary/20 text-secondary" : "bg-secondary/10 text-secondary"}
      `}
    >
      <Icon size={16} aria-hidden="true" />
      <span className="text-xs font-mono">{label}:</span>
      <span className="text-xs font-mono font-medium">{value}</span>
    </div>
  );
}

function FeatureWarning({ info }) {
  if (!info) return null;

  const Icon = info.icon;
  const bgColor =
    info.variant === "warning" ? "bg-secondary/20 border-secondary/50" : "bg-secondary/10 border-secondary/30";

  return (
    <div
      className={`flex items-start gap-3 p-4 rounded-large-element border ${bgColor}`}
      role="note"
    >
      <Icon
        size={20}
        className={info.variant === "warning" ? "text-secondary" : "text-secondary/70"}
        aria-hidden="true"
      />
      <div>
        <p className="font-mono text-sm font-medium text-secondary">
          {info.label}
        </p>
        <p className="text-sm text-secondary/70 mt-1">{info.message}</p>
      </div>
    </div>
  );
}

function OverviewStep({ app, features, onContinue, onBack }) {
  const accessInfo = ACCESS_MODEL_INFO[features?.access_model] || ACCESS_MODEL_INFO.integrated_users;
  const requirements = app?.requirements || {};

  return (
    <div className="space-y-6">
      <div className="text-center space-y-4">
        {app?.id && (
          <div className="w-16 h-16 mx-auto">
            <AppIcon appId={app.id} size={64} className="text-secondary" />
          </div>
        )}
        <h2 className="font-mono text-2xl font-normal text-secondary">
          Install {app?.name || "App"}
        </h2>
        <p className="text-secondary/70 max-w-md mx-auto">
          {app?.description || "Set up this application on your LibreServ device."}
        </p>
      </div>

      {features && features.access_model && (
        <div className="max-w-md mx-auto">
          <FeatureWarning info={accessInfo} />
        </div>
      )}

      {features && (
        <div className="max-w-2xl mx-auto">
          <div className="border-t border-secondary/20 pt-6">
            <div className="bg-secondary/80 rounded-large-element p-5">
              <FeatureMatrix features={features} />
            </div>
          </div>
        </div>
      )}

      {(requirements.min_ram || requirements.min_cpu || requirements.min_disk) && (
        <div className="space-y-2">
          <p className="text-xs font-mono text-secondary/50 text-center uppercase tracking-wide">
            Requirements
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {requirements.min_ram && (
              <RequirementBadge
                icon={MemoryStick}
                label="RAM"
                value={requirements.min_ram}
              />
            )}
            {requirements.min_cpu && (
              <RequirementBadge icon={Cpu} label="CPU" value={`${requirements.min_cpu} cores`} />
            )}
            {requirements.min_disk && (
              <RequirementBadge icon={HardDrive} label="Disk" value={requirements.min_disk} />
            )}
          </div>
        </div>
      )}

      <div className="flex justify-center gap-3 pt-4">
        <button
          type="button"
          onClick={onBack}
          className="px-6 py-2 rounded-pill border-2 border-secondary/30 text-secondary hover:bg-secondary/10 motion-safe:transition-all font-mono"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onContinue}
          className="px-6 py-2 rounded-pill bg-secondary text-primary hover:bg-secondary/90 motion-safe:transition-all font-mono"
        >
          Continue
        </button>
      </div>
    </div>
  );
}

export default memo(OverviewStep);
