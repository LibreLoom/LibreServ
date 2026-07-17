import PropTypes from "prop-types";
import StatusRow from "./StatusRow";
import Callout from "../../common/Callout";
import Button from "../../ui/Button";

export default function ConnectingStep({ domain, connectStatus, publicIP, applyError, onRetry, onSkip }) {
  const dnsDone        = connectStatus?.dns_records === "done";
  const certDone      = connectStatus?.certificate === "done";
  const certFail      = connectStatus?.certificate === "failed";
  const certUnavail   = connectStatus?.cert_available === false;
  const ip             = connectStatus?.public_ip ?? publicIP ?? "your IP";

  const hasIssue = applyError || certUnavail || certFail;

  return (
    <div>
      <h2 className="font-mono text-3xl font-normal text-primary tracking-tight mb-2">
        Setting up your domain
      </h2>
      <p className="text-primary/50 text-sm mb-6">
        This may take a minute or two. Please don&rsquo;t close this window.
      </p>
      <div className="space-y-3">
        <StatusRow label="Saved your provider settings" done />
        <StatusRow label="Set up your domain addresses" done={dnsDone}>
          {dnsDone && (
            <span className="block mt-1 text-xs text-primary/40 font-mono ml-1">
              &rarr; {domain} &rarr; {ip}
            </span>
          )}
        </StatusRow>
        {certUnavail ? (
          <StatusRow label="Getting your security certificate" failed>
            <p className="text-xs text-error/70 mt-0.5">
              No certificate tool available on this system.
              You can continue without HTTPS and set it up later in Settings &rarr; Network.
            </p>
          </StatusRow>
        ) : (
          <StatusRow
            label="Getting your security certificate"
            done={certDone}
            failed={certFail}
            spinner={!certDone && !certFail}
          />
        )}
      </div>
      {hasIssue && (
        <div className="mt-5 space-y-3">
          <Callout tone="error">
            {applyError ?? "Certificate issuance is not available on this system. Please ensure either the certificate tool is installed or the container engine is running."}
          </Callout>
          <div className="flex gap-3">
            {!certUnavail && (
              <Button
                variant="primary"
                onClick={onRetry}
                className="px-5 py-2.5 font-mono"
              >
                Retry
              </Button>
            )}
            <Button
              variant="outline"
              surface="secondary"
              onClick={onSkip}
              className="px-5 py-2.5 font-mono"
            >
              Continue without HTTPS
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

ConnectingStep.propTypes = {
  domain:        PropTypes.string.isRequired,
  connectStatus: PropTypes.object,
  publicIP:      PropTypes.string,
  applyError:    PropTypes.string,
  onRetry:       PropTypes.func.isRequired,
  onSkip:       PropTypes.func.isRequired,
};
