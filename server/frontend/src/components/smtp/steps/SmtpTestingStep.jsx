import PropTypes from "prop-types";
import StatusRow from "../../setup/steps/StatusRow";

export default function SmtpTestingStep({ error, onRetry }) {
  return (
    <div>
      <h2 className="font-mono text-3xl font-normal text-primary tracking-tight mb-2">
        {error ? "Connection failed" : "Testing your SMTP connection"}
      </h2>
      <p className="text-primary/50 text-sm mb-6">
        {error ? "We couldn't connect with those credentials." : "Sending a test email to verify everything works…"}
      </p>
      <div className="space-y-3">
        <StatusRow label="Reached SMTP server" done={!error} failed={!!error} spinner={!error}>
          {error && (
            <p className="text-xs text-error/70 mt-0.5">{error}</p>
          )}
        </StatusRow>
      </div>
      {error && (
        <div className="mt-5">
          <button
            type="button"
            onClick={onRetry}
            className="rounded-pill bg-primary text-secondary px-5 py-2.5 font-mono text-sm motion-safe:transition-all motion-safe:duration-200 hover:scale-[1.02] active:scale-[0.98]"
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

SmtpTestingStep.propTypes = {
  error:   PropTypes.string,
  onRetry: PropTypes.func.isRequired,
};
