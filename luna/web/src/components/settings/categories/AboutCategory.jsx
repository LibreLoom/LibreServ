import { Heart, Coffee } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import SettingsCard from "../SettingsCard";
import Button from "../../ui/Button";
import SystemUpdatesCard from "./SystemUpdatesCard.jsx";
import UpdateSourceCard from "./UpdateSourceCard.jsx";
import { getHealth, getJson } from "../../../lib/api";

export default function AboutCategory() {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: getHealth,
  });
  const setup = useQuery({
    queryKey: ["setup"],
    queryFn: () => getJson("/api/v1/setup"),
  });

  const deviceName = setup.data?.name || "Luna";
  const productVersion = health.data?.version;

  return (
    <div className="space-y-4" data-slot="about-category">
      <SettingsCard icon={Heart} title="Luna" padding={false} index={0}>
        <div className="px-5 py-4">
          <p className="text-sm text-accent leading-relaxed">
            Luna is your home file box — a place to keep photos, documents, and backups on your
            own hardware, without renting cloud storage by the gigabyte.
          </p>
          <dl className="mt-4 space-y-2 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-primary/10 pb-2">
              <dt className="text-accent">This Luna</dt>
              <dd className="font-mono text-primary">{deviceName}</dd>
            </div>
            {productVersion && (
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <dt className="text-accent">Software</dt>
                <dd className="font-mono text-primary">{productVersion}</dd>
              </div>
            )}
          </dl>
          <div className="mt-4 pt-4 border-t border-primary/10">
            <div className="flex items-center gap-2 text-sm text-accent">
              <Heart size={14} className="text-error" aria-hidden="true" />
              <span>Made with love for the open source community</span>
            </div>
          </div>
        </div>
      </SettingsCard>

      <SettingsCard icon={Coffee} title="Support Luna" padding={false} index={1}>
        <div className="px-5 py-4">
          <p className="text-sm text-accent leading-relaxed">
            Luna is free and open source. If it has made keeping your files at home a little easier,
            you can help keep it going with a small contribution — entirely optional, always
            appreciated.
          </p>
          <div className="mt-4">
            <Button asChild variant="primary">
              <a href="https://ko-fi.com/libreloom" target="_blank" rel="noopener noreferrer">
                <Coffee size={16} aria-hidden="true" />
                Support us on Ko-fi
              </a>
            </Button>
          </div>
        </div>
      </SettingsCard>

      <SystemUpdatesCard index={2} />

      <UpdateSourceCard index={3} />
    </div>
  );
}
