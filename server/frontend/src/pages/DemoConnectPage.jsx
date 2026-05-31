import { useState } from "react";
import Button from "../components/ui/Button.jsx";
import { Mail, Globe, Database, Waypoints, ShieldCheck, Sparkles } from "lucide-react";

import ConnectStatusCard from "../components/connect/ConnectStatusCard.jsx";
import EmailServiceModal from "../components/connect/EmailServiceModal.jsx";
import DomainServiceModal from "../components/connect/DomainServiceModal.jsx";
import BackupServiceModal from "../components/connect/BackupServiceModal.jsx";
import TunnelServiceModal from "../components/connect/TunnelServiceModal.jsx";
import SSLServiceModal from "../components/connect/SSLServiceModal.jsx";
import AIServiceModal from "../components/connect/AIServiceModal.jsx";
import RecoveryKeyCard from "../components/connect/RecoveryKeyCard.jsx";
import ExternalServicesCategory from "../components/connect/ExternalServicesCategory.jsx";

const MOCK_FREE_STATUS = {
  connected: false,
  plan: null,
  services: {
    smtp: { state: "disabled", label: "Email / SMTP" },
    domain: { state: "disabled", label: "Domain & DNS" },
    backup: { state: "disabled", label: "Cloud Backup Storage" },
    tunnel: { state: "disabled", label: "Tunnel" },
    acme: { state: "disabled", label: "SSL Certificates" },
    ai: { state: "disabled", label: "AI Assistant" },
  },
};

const MOCK_CONNECTED_FREE_STATUS = {
  connected: true,
  plan: { id: "free", name: "Connect Free" },
  token_hint: "free_...",
  services: {
    smtp: { state: "connected", label: "Email / SMTP", details: { domain: "free.connect.serv.libreloom.org", limit: "30/day" } },
    domain: { state: "connected", label: "Domain & DNS", details: { domain: "demo.free.connect.serv.libreloom.org" } },
    backup: { state: "disabled", label: "Cloud Backup Storage" },
    tunnel: { state: "connected", label: "Tunnel", details: { speed: "1 Mbps", transfer: "1 GB/mo" } },
    acme: { state: "connected", label: "SSL Certificates" },
    ai: { state: "connected", label: "AI Assistant", details: { model: "free router", privacy: "not guaranteed" } },
  },
};

const MOCK_CONNECTED_ONE_STATUS = {
  connected: true,
  plan: { id: "one", name: "Connect One" },
  token_hint: "one_...",
  services: {
    smtp: { state: "connected", label: "Email / SMTP", details: { domain: "demo.servers.libreloom.org" } },
    domain: { state: "connected", label: "Domain & DNS", details: { domain: "demo.servers.libreloom.org" } },
    backup: { state: "connected", label: "Cloud Backup Storage", details: { storage: "S3", limit: "unlimited" } },
    tunnel: { state: "connected", label: "Tunnel", details: { speed: "Full" } },
    acme: { state: "connected", label: "SSL Certificates" },
    ai: { state: "connected", label: "AI Assistant" },
  },
};

const MOCK_REPOS = [
  {
    id: "repo-1",
    name: "My S3 Bucket",
    repo_type: "s3",
    repo_path: "s3:https://s3.amazonaws.com/my-backups",
  },
  {
    id: "repo-2",
    name: "Backblaze B2",
    repo_type: "b2",
    repo_path: "b2:my-bucket:libreserv-backups",
  },
];

const MOCK_RECOVERY_REPO = {
  id: "repo-system",
  repo_type: "s3",
  repo_path: "s3:https://s3.libreloom.org/libreserv-backup/demo-server",
  password: "libreserv-restic-hmac-8a7f3c2b1e4d5f6a7b8c9d0e1f2a3b4c5d6e7f8a",
};

function Section({ title, children }) {
  return (
    <section className="space-y-3 mb-8">
      <h3 className="font-mono text-secondary text-sm border-b border-secondary/10 pb-2">{title}</h3>
      {children}
    </section>
  );
}

function DemoGroup({ label, children }) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-mono text-accent">{label}</p>
      {children}
    </div>
  );
}

export default function DemoConnectPage() {
  const [demoState, setDemoState] = useState("free");
  const [modalToShow, setModalToShow] = useState(null);

  const currentStatus =
    demoState === "disconnected"
      ? MOCK_FREE_STATUS
      : demoState === "free"
        ? MOCK_CONNECTED_FREE_STATUS
        : MOCK_CONNECTED_ONE_STATUS;

  return (
    <div className="min-h-screen bg-primary p-6 md:p-8 max-w-3xl mx-auto space-y-8">
      <div className="space-y-2">
        <h1 className="text-2xl text-secondary font-bold">LibreServ Connect — Component Demo</h1>
        <p className="text-sm text-accent">
          This page showcases all Connect components with mock data for visual verification.
          Toggle states below to see different configurations.
        </p>
      </div>

      <Section title="State Switcher">
        <div className="flex gap-2 flex-wrap">
          {[
            { id: "disconnected", label: "Disconnected" },
            { id: "free", label: "Connect Free" },
            { id: "one", label: "Connect One (with BYO backup)" },
          ].map((s) => (
            <Button
              key={s.id}
              variant={demoState === s.id ? "default" : "outline"}
              onClick={() => setDemoState(s.id)}
            >
              {s.label}
            </Button>
          ))}
        </div>
      </Section>

      <Section title="ConnectStatusCard — Master Card (disconnected state)">
        <DemoGroup label="Disconnected — shows connect button">
          <ConnectStatusCard
            connected={false}
            plan={null}
            tokenHint={null}
            services={MOCK_FREE_STATUS.services}
            onActivate={(token) => alert(`Activating with token: ${token}`)}
            onDeactivate={() => alert("Deactivating")}
            onOpenPlanPage={() => window.open("https://connect.serv.libreloom.org", "_blank")}
            loading={false}
          />
        </DemoGroup>
      </Section>

      <Section title="ConnectStatusCard — Connected State">
        <DemoGroup label={`Connected — ${currentStatus.plan?.name} plan`}>
          <ConnectStatusCard
            connected={currentStatus.connected}
            plan={currentStatus.plan}
            tokenHint={currentStatus.token_hint}
            services={currentStatus.services}
            onActivate={(token) => alert(`Activating with token: ${token}`)}
            onDeactivate={() => alert("Deactivating")}
            onOpenPlanPage={() => window.open("https://connect.serv.libreloom.org", "_blank")}
            loading={false}
          />
        </DemoGroup>
      </Section>

      <Section title="Service Modals">
        <p className="text-sm text-accent mb-4">
          Click a button below to open the corresponding service configuration modal.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <Button variant="outline" onClick={() => setModalToShow("smtp")}>
            <Mail size={16} /> Email
          </Button>
          <Button variant="outline" onClick={() => setModalToShow("domain")}>
            <Globe size={16} /> Domain
          </Button>
          <Button variant="outline" onClick={() => setModalToShow("backup")}>
            <Database size={16} /> Backup
          </Button>
          <Button variant="outline" onClick={() => setModalToShow("tunnel")}>
            <Waypoints size={16} /> Tunnel
          </Button>
          <Button variant="outline" onClick={() => setModalToShow("ssl")}>
            <ShieldCheck size={16} /> SSL
          </Button>
          <Button variant="outline" onClick={() => setModalToShow("ai")}>
            <Sparkles size={16} /> AI
          </Button>
        </div>

        <EmailServiceModal
          open={modalToShow === "smtp"}
          onClose={() => setModalToShow(null)}
          service={{ state: "connected" }}
        />
        <DomainServiceModal
          open={modalToShow === "domain"}
          onClose={() => setModalToShow(null)}
          service={{ state: "connected" }}
        />
        <BackupServiceModal
          open={modalToShow === "backup"}
          onClose={() => setModalToShow(null)}
          service={{ state: "connected" }}
          repos={MOCK_REPOS}
        />
        <TunnelServiceModal
          open={modalToShow === "tunnel"}
          onClose={() => setModalToShow(null)}
          service={{ state: "connected" }}
        />
        <SSLServiceModal
          open={modalToShow === "ssl"}
          onClose={() => setModalToShow(null)}
          service={{ state: "connected" }}
        />
        <AIServiceModal
          open={modalToShow === "ai"}
          onClose={() => setModalToShow(null)}
          service={{ state: "connected" }}
        />
      </Section>

      <Section title="RecoveryKeyCard — Encryption Key Export">
        <RecoveryKeyCard repo={MOCK_RECOVERY_REPO} />
      </Section>

      <Section title="ExternalServicesCategory — Full Layout">
        <p className="text-sm text-accent mb-2">
          This is the complete External Services settings category as it would appear in the
          settings page, with mock data showing the Connect Free plan.
        </p>
        <ExternalServicesCategory
          connectStatus={currentStatus}
          services={currentStatus.services}
          repos={MOCK_REPOS}
          onActivateConnect={(token) => alert(`Activating with: ${token}`)}
          onDeactivateConnect={() => alert("Deactivating")}
          onOpenPlanPage={() => window.open("https://connect.serv.libreloom.org", "_blank")}
        />
      </Section>
    </div>
  );
}
