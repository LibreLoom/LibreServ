import { HardDrive, ShieldCheck, Wifi } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import Page from "../components/ui/Page";
import TextLink from "../components/ui/TextLink";
import Card from "../components/cards/Card";
import Pill from "../components/common/Pill";
import { useAuth } from "../context/AuthContext";
import { getHealth } from "../lib/api";

function HealthPill({ data, isError }) {
  if (isError) return <Pill variant="error">Luna is not responding</Pill>;
  if (!data) return <Pill variant="warning">Checking…</Pill>;
  return <Pill variant="success">Luna is ready</Pill>;
}

export default function LandingPage() {
  const health = useQuery({ queryKey: ["health"], queryFn: getHealth, retry: 1 });
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

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

      <div className="mt-8 flex flex-wrap gap-3">
        {isAdmin && (
          <TextLink to="/settings/remote" className="inline-flex items-center justify-center gap-2 rounded-pill font-medium border-2 border-secondary text-secondary px-4 py-2 text-sm hover:bg-secondary hover:text-primary motion-safe:transition-all">
            Remote access
          </TextLink>
        )}
        {isAdmin && (
          <TextLink to="/settings/users" className="inline-flex items-center justify-center gap-2 rounded-pill font-medium border-2 border-secondary text-secondary px-4 py-2 text-sm hover:bg-secondary hover:text-primary motion-safe:transition-all">
            People
          </TextLink>
        )}
        <TextLink to="/settings/shares" className="inline-flex items-center justify-center gap-2 rounded-pill font-medium border-2 border-secondary text-secondary px-4 py-2 text-sm hover:bg-secondary hover:text-primary motion-safe:transition-all">
          Links
        </TextLink>
        {isAdmin && (
          <TextLink to="/settings/protect" className="inline-flex items-center justify-center gap-2 rounded-pill font-medium border-2 border-secondary text-secondary px-4 py-2 text-sm hover:bg-secondary hover:text-primary motion-safe:transition-all">
            Protect a folder
          </TextLink>
        )}
        <TextLink to="/shared" className="inline-flex items-center justify-center gap-2 rounded-pill font-medium border-2 border-secondary text-secondary px-4 py-2 text-sm hover:bg-secondary hover:text-primary motion-safe:transition-all">
          Shared with me
        </TextLink>
        <TextLink to="/gallery" className="inline-flex items-center justify-center gap-2 rounded-pill font-medium border-2 border-secondary text-secondary px-4 py-2 text-sm hover:bg-secondary hover:text-primary motion-safe:transition-all">
          Photos
        </TextLink>
        <TextLink to="/drives" className="inline-flex items-center justify-center gap-2 rounded-pill font-medium border-2 border-secondary text-secondary px-4 py-2 text-sm hover:bg-secondary hover:text-primary motion-safe:transition-all">
          Look at drives
        </TextLink>
      </div>
    </Page>
  );
}
