import { memo } from "react";
import { AlertTriangle, Globe, ArrowRight, Check } from "lucide-react";
import PropTypes from "prop-types";
import { useNavigate } from "react-router-dom";
import Button from "../../ui/Button";

function NoDomainWarningStep({ app, onBack, onContinue }) {
  const navigate = useNavigate();

  const handleSetupRemoteAccess = () => {
    navigate("/settings/network");
  };

  return (
    <div className="space-y-6" data-slot="no-domain-warning-step">
      <div className="text-center space-y-2">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-warning/20 mb-4">
          <AlertTriangle className="w-8 h-8 text-warning" />
        </div>
        <h2 className="font-mono text-2xl font-normal text-primary">No Remote Access</h2>
        <p className="text-primary text-sm max-w-md mx-auto">
          To install <span className="font-mono text-accent">{app?.name}</span> with remote access, you need to set up a domain and network access first.
        </p>
      </div>

      <div className="space-y-4">
        <div className="flex items-start gap-3 p-4 rounded-large-element bg-warning/10 border border-warning/30">
          <Globe className="w-5 h-5 text-warning mt-0.5 flex-shrink-0" />
          <div className="space-y-2">
            <p className="font-mono text-sm text-warning">Why is this important?</p>
            <ul className="text-xs text-warning/80 space-y-1.5 list-disc list-inside">
              <li>Without remote access, apps are only accessible from this device</li>
              <li>No HTTPS encryption (insecure for remote access)</li>
              <li>Cannot access apps from other devices on your network</li>
            </ul>
          </div>
        </div>

        <div className="flex items-start gap-3 p-4 rounded-large-element bg-success/10 border border-success/30">
          <div className="flex-shrink-0 w-5 h-5 rounded-full bg-success flex items-center justify-center mt-0.5">
            <Check size={12} className="text-primary" strokeWidth={3} />
          </div>
          <p className="text-sm text-primary">
            Setting up remote access takes just a few minutes and enables secure access to all your apps from anywhere.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-3 pt-4">
        <Button
          type="button"
          variant="primary"
          size="lg"
          fullWidth
          onClick={handleSetupRemoteAccess}
        >
          <Globe size={18} />
          Set Up Remote Access
          <ArrowRight size={18} />
        </Button>

        <div className="flex gap-3">
          <Button
            type="button"
            variant="outline"
            surface="secondary"
            onClick={onBack}
            disabled={false}
            className="flex-1 px-6"
          >
            Back
          </Button>
          <Button
            type="button"
            variant="accent"
            onClick={onContinue}
            disabled={false}
            className="flex-1 px-6"
          >
            Install Anyway (Local Only)
          </Button>
        </div>
      </div>
    </div>
  );
}

NoDomainWarningStep.propTypes = {
  app: PropTypes.object,
  onBack: PropTypes.func.isRequired,
  onContinue: PropTypes.func.isRequired,
};

export default memo(NoDomainWarningStep);
