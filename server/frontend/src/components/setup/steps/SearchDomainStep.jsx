import PropTypes from "prop-types";
import { ExternalLink } from "lucide-react";
import Button from "../../ui/Button";
import {
  CloudflareIcon,
  PorkbunIcon,
  SpaceshipIcon,
  GlobeIcon,
} from "../icons";

const REGISTRAR_META = {
  cloudflare_reg: {
    Icon: CloudflareIcon,
    label: "Cloudflare Registrar",
    url: "https://www.cloudflare.com/products/registrar/",
  },
  porkbun: {
    Icon: PorkbunIcon,
    label: "Porkbun",
    url: "https://porkbun.com",
  },
  spaceship: {
    Icon: SpaceshipIcon,
    label: "Spaceship",
    url: "https://www.spaceship.com",
  },
};

/** @param {{ registrar: any, onContinue: any, onBack?: any }} _ */
export default function SearchDomainStep({ registrar, onContinue }) {
  const meta = REGISTRAR_META[registrar] ?? { Icon: GlobeIcon, label: registrar, url: "#" };
  const { Icon, label, url } = meta;

  return (
    <div className="flex flex-col items-center text-center py-4">
      <div className="w-14 h-14 rounded-full border border-primary/15 flex items-center justify-center mb-6">
        <Icon size={28} />
      </div>
      <h2 className="font-mono text-3xl font-normal text-primary tracking-tight mb-2">
        Buy your domain
      </h2>
      <p className="text-primary/50 text-sm leading-relaxed mb-2 max-w-sm">
        Head over to {label}, search for a domain name you like, and buy it.
      </p>

      <div className="w-full space-y-3">
        <Button asChild variant="outline" surface="secondary" fullWidth className="py-4 px-6 font-mono text-sm">
          <a href={url} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={16} />
            Open {label}
          </a>
        </Button>
        <Button
          variant="primary"
          fullWidth
          onClick={onContinue}
          className="py-4 px-6 font-mono tracking-wide"
        >
          I&rsquo;ve bought my domain!
        </Button>
      </div>
    </div>
  );
}

SearchDomainStep.propTypes = {
  registrar:  PropTypes.string.isRequired,
  onContinue: PropTypes.func.isRequired,
};
