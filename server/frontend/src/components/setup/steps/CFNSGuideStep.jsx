import PropTypes from "prop-types";
import { ExternalLink } from "lucide-react";
import AnimatedCheckbox from "../../ui/AnimatedCheckbox";

const STEPS = [
  "Create a free account at cloudflare.com",
  "Go to Domains \u2192 Add a site \u2192 enter your domain",
  "Select the Free plan",
  "Cloudflare will give you two nameserver web addresses",
  "Go to the website where you bought your domain (your registrar) and look for a &lsquo;Nameservers&rsquo; or &lsquo;DNS&rsquo; setting",
  "Replace the existing nameservers with the Cloudflare ones",
  "Wait for activation &mdash; usually a few minutes, up to 24 hours",
];

export default function CFNSGuideStep({ confirmed, onConfirmChange }) {
  return (
    <div>
      <h2 className="font-mono text-3xl font-normal text-primary tracking-tight mb-2">
        Set up Cloudflare
      </h2>
      <p className="text-primary/50 text-sm mb-6">
        You&rsquo;ll need a free Cloudflare account. Here&rsquo;s how to get started.
      </p>
      <div className="space-y-5 mb-6">
        {STEPS.map((step, i) => (
          <div key={i} className="flex items-start gap-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-accent/15 text-accent font-mono text-xs flex items-center justify-center mt-0.5">
              {i + 1}
            </span>
            <p
              className="text-sm text-primary/70 leading-relaxed"
              dangerouslySetInnerHTML={{ __html: step }}
            />
          </div>
        ))}
      </div>
      <a
        href="https://developers.cloudflare.com/dns/nameservers/update-nameservers/"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 text-xs text-accent hover:text-primary mb-6 font-mono motion-safe:transition-colors motion-safe:duration-150"
      >
        More info <ExternalLink size={12} />
      </a>

      <AnimatedCheckbox checked={confirmed} onChange={onConfirmChange}>
        I&rsquo;ve completed these steps
      </AnimatedCheckbox>
    </div>
  );
}

CFNSGuideStep.propTypes = {
  confirmed:       PropTypes.bool.isRequired,
  onConfirmChange: PropTypes.func.isRequired,
};
