import { cn } from "@/lib/utils";
import { memo } from "react";
import { AlertTriangle, Info, HardDrive, Cpu, MemoryStick } from "lucide-react";
import Card from "../../cards/Card";
import AppIcon from "../../common/AppIcon";
import Button from "../../ui/Button";


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

/** @param {{ icon: any, label: any, value: any, warning?: any }} _ */
function RequirementBadge({ icon: Icon, label, value, warning }) {
  return (
    <div
      className={cn("flex items-center gap-2 px-3 py-2 rounded-large-element", warning ? "bg-warning/20 text-primary border border-warning/30" : "bg-primary/10 text-primary")}
    >
      <Icon size={16} aria-hidden="true" />
      <span className="text-xs font-mono">{label}:</span>
      <span className="text-xs font-mono font-medium">{value}</span>
    </div>
  );
}

/** @param {{ info: any }} _ */
function FeatureWarning({ info }) {
  if (!info) return null;

  const Icon = info.icon;
  const bgColor =
    info.variant === "warning" ? "bg-warning/20 border-warning/30" : "bg-primary/10 border-primary/20";

  return (
    <div
      className={cn("flex items-start gap-3 p-4 rounded-large-element border", bgColor)}
      role="note"
    >
      <Icon
        size={20}
        className={info.variant === "warning" ? "text-primary" : "text-primary"}
        aria-hidden="true"
      />
      <div>
        <p className="font-mono text-sm font-medium text-primary">
          {info.label}
        </p>
        <p className="text-sm text-primary mt-1">{info.message}</p>
      </div>
    </div>
  );
}

/** @param {{ app: any, features?: any, onContinue: any, onBack: any }} _ */
function OverviewStep({ app, features, onContinue, onBack }) {
  const accessInfo = ACCESS_MODEL_INFO[features?.access_model] || ACCESS_MODEL_INFO.integrated_users;
  const requirements = app?.requirements || {};

  return (
    <div className="space-y-6">
      <div className="text-center space-y-4">
        {app?.id && (
          <Card surface="secondary" className="inline-flex items-center justify-center w-20 h-20 p-2">
            <AppIcon appId={app.id} size={64} className="text-primary" />
          </Card>
        )}
        <h2 className="font-mono text-2xl font-normal text-primary">
          Install {app?.name || "App"}
        </h2>
        <p className="text-primary max-w-md mx-auto">
          {app?.description || "Set up this application on your LibreServ device."}
        </p>
      </div>

      {features && features.access_model && (
        <div className="max-w-md mx-auto">
          <FeatureWarning info={accessInfo} />
        </div>
      )}

      {(requirements.min_ram || requirements.min_cpu || requirements.min_disk) && (
        <div className="space-y-2">
          <p className="text-xs font-mono text-primary text-center uppercase tracking-wide">
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
        <Button
          type="button"
          variant="outline"
          surface="secondary"
          onClick={onBack}
          className="px-6"
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="primary"
          onClick={onContinue}
          className="px-6"
        >
          Continue
        </Button>
      </div>
    </div>
  );
}

export default memo(OverviewStep);
