import PropTypes from "prop-types";
import { AlertTriangle } from "lucide-react";
import Button from "../../ui/Button";

export default function SmtpSkipConfirmStep({ onBack, onSkip }) {
  return (
    <div className="flex flex-col items-center text-center py-4">
      <div className="w-14 h-14 rounded-full border border-warning/25 bg-warning/10 flex items-center justify-center mb-6">
        <AlertTriangle size={24} className="text-warning" />
      </div>
      <h2 className="font-mono text-3xl font-normal text-primary tracking-tight mb-2">
        Skip email setup?
      </h2>
      <p className="text-primary/50 text-sm leading-relaxed mb-2">
        Without an email provider, LibreServ can&apos;t deliver password resets or notifications.
      </p>
      <p className="text-primary/35 text-xs mb-8">
        You can configure this later in Settings &rarr; Notifications.
      </p>
      <div className="flex flex-col gap-3 w-full">
        <Button
          variant="outline"
          surface="secondary"
          fullWidth
          onClick={onBack}
          className="px-6 py-3 font-mono"
        >
          Go back
        </Button>
        <Button
          variant="accent"
          fullWidth
          onClick={onSkip}
          className="px-6 py-3 font-mono"
        >
          Skip anyway
        </Button>
      </div>
    </div>
  );
}

SmtpSkipConfirmStep.propTypes = {
  onBack: PropTypes.func.isRequired,
  onSkip: PropTypes.func.isRequired,
};
