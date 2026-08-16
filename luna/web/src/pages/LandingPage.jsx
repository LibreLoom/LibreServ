import { HardDrive, ShieldCheck, Wifi } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import Page from "../components/ui/Page";
import TextLink from "../components/ui/TextLink";
import Card from "../components/cards/Card";
import Pill from "../components/common/Pill";
import Button from "../components/ui/Button";
import { getHealth } from "../lib/api";

function HealthPill({ data, isError }) {
  if (isError) return <Pill variant="error">Luna is not responding</Pill>;
  if (!data) return <Pill variant="warning">Checking…</Pill>;
  return <Pill variant="success">Luna is ready</Pill>;
}

export default function LandingPage() {
  const health = useQuery({ queryKey: ["health"], queryFn: getHealth, retry: 1 });

  return (
    <Page
      title="Luna"
      titleId="luna-title"
      rightContent={<HealthPill data={health.data} isError={health.isError} />}
      bottomContent={
        <p className="text-secondary text-sm mt-2">
          Your files, your drives, your house. No subscription — ever.
        </p>
      }
    >
      <div className="grid gap-5 md:grid-cols-3">
        <Card icon={HardDrive} title="Drives">
          <p className="text-primary text-sm">
            Plug in a USB drive and Luna will notice. Nothing changes on the
            drive until you say so.
          </p>
        </Card>
        <Card icon={ShieldCheck} title="Yours">
          <p className="text-primary text-sm">
            Luna never formats, never renames, and never writes to a drive
            without your approval.
          </p>
        </Card>
        <Card icon={Wifi} title="Anywhere, free">
          <p className="text-primary text-sm">
            Luna works at home. Remote access stays off until you turn it on —
            and it&apos;s free forever.
          </p>
        </Card>
      </div>

      <div className="mt-8 flex flex-wrap gap-4">
        <div className="flex flex-wrap gap-3">
          <TextLink to="/setup" className="inline-flex items-center justify-center gap-2 rounded-pill font-medium bg-secondary text-primary px-4 py-2 text-sm hover:bg-primary hover:text-secondary hover:ring-2 hover:ring-secondary motion-safe:transition-all">
            Set up Luna
          </TextLink>
          <TextLink to="/drives" className="inline-flex items-center justify-center gap-2 rounded-pill font-medium border-2 border-secondary text-secondary px-4 py-2 text-sm hover:bg-secondary hover:text-primary motion-safe:transition-all">
            Look at drives
          </TextLink>
        </div>
        <Button variant="outline" surface="primary" disabled>
          Setup will guide you here
        </Button>
      </div>
    </Page>
  );
}
