import PropTypes from "prop-types";

const inputClass = "w-full px-5 py-3.5 rounded-pill border border-primary/20 bg-transparent text-primary placeholder:text-primary/25 font-mono text-sm focus:outline-none focus:border-primary/50 motion-safe:transition-colors motion-safe:duration-150";

export default function DomainInputStep({ domain, onDomainChange, publicIP, onEnter }) {
  return (
    <div>
      <h2 className="font-mono text-3xl font-normal text-primary tracking-tight mb-2">
        What&rsquo;s your domain name?
      </h2>
      <p className="text-primary/50 text-sm mb-6">
        The domain you&rsquo;re managing through Cloudflare.
      </p>
      <div className="mb-5">
        {publicIP && (
          <label
            htmlFor="wiz-domain"
            className="block text-xs text-primary/50 font-mono mb-1.5"
          >
            Your server&rsquo;s address on the internet: {publicIP}
          </label>
        )}
        <input
          id="wiz-domain"
          type="text"
          value={domain}
          onChange={(e) => onDomainChange(e.target.value.toLowerCase().replace(/\s+/g, "").slice(0, 253))}
          onKeyDown={(e) => e.key === "Enter" && onEnter?.()}
          placeholder="example.com"
          maxLength={253}
          className={inputClass}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
    </div>
  );
}

DomainInputStep.propTypes = {
  domain:         PropTypes.string.isRequired,
  onDomainChange: PropTypes.func.isRequired,
  publicIP:       PropTypes.string,
  onEnter:        PropTypes.func,
};
