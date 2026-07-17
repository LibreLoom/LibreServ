import { useState, useEffect, useMemo } from "react";
import PropTypes from "prop-types";
import StatusRow from "../../setup/steps/StatusRow";
import Button from "../../ui/Button";

export default function SmtpTestingStep({ error, onRetry }) {
  const [showSend, setShowSend] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setShowSend(true), 1200);
    return () => clearTimeout(t);
  }, []);

  const connectDone = !error && showSend;
  const connectFailed = !!error;
  const connectSpinner = !error && !showSend;

  const sendSpinner = !error && showSend;

  const heading = useMemo(() => {
    if (error) return "Connection failed";
    if (showSend) return "Sending test email…";
    return "Testing your SMTP connection";
  }, [error, showSend]);

  const subheading = useMemo(() => {
    if (error) return "We couldn't connect with those credentials.";
    return "Verifying your SMTP connection works…";
  }, [error]);

  return (
    <div>
      <h2 className="font-mono text-3xl font-normal text-primary tracking-tight mb-2">
        {heading}
      </h2>
      <p className="text-primary/50 text-sm mb-6">
        {subheading}
      </p>
      <div className="space-y-3">
        <StatusRow
          label="Connecting to SMTP server"
          done={connectDone}
          failed={connectFailed}
          spinner={connectSpinner}
        >
          {error && (
            <p className="text-xs text-error/70 mt-0.5">{error}</p>
          )}
        </StatusRow>
        {connectDone && (
          <StatusRow
            label="Sending test email"
            done={false}
            failed={false}
            spinner={sendSpinner}
          />
        )}
      </div>
      {error && (
        <div className="mt-5">
          <Button
            variant="primary"
            onClick={onRetry}
            className="px-5 py-2.5 font-mono"
          >
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}

SmtpTestingStep.propTypes = {
  error:   PropTypes.string,
  onRetry: PropTypes.func.isRequired,
};
