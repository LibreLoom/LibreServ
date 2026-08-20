import { HardDrive, ShieldCheck, Wifi } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import Page from "../components/ui/Page";
import Card from "../components/cards/Card";
import Pill from "../components/common/Pill";
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
        <p className="text-sm">
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
    </Page>
  );
}
