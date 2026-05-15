import PropTypes from "prop-types";
import { AlertTriangle } from "lucide-react";

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
        Without SMTP, email notifications, password resets, and welcome emails won&apos;t work.
      </p>
      <p className="text-primary/35 text-xs mb-8">
        You can configure this later in Settings &rarr; Notifications.
      </p>
      <div className="flex flex-col gap-3 w-full">
        <button
          type="button"
          onClick={onBack}
          className="w-full rounded-pill border border-primary/20 bg-transparent text-primary px-6 py-3 font-mono text-sm motion-safe:transition-all motion-safe:duration-200 hover:bg-primary/8"
        >
          Go back
        </button>
        <button
          type="button"
          onClick={onSkip}
          className="w-full rounded-pill border border-error/20 bg-error/8 text-error/80 px-6 py-3 font-mono text-sm motion-safe:transition-all motion-safe:duration-200 hover:bg-error/12 hover:text-error"
        >
          Skip anyway
        </button>
      </div>
    </div>
  );
}

SmtpSkipConfirmStep.propTypes = {
  onBack: PropTypes.func.isRequired,
  onSkip: PropTypes.func.isRequired,
};
