import { cn } from "@/lib/utils";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { UserPlus, Mail } from "lucide-react";
import Page from "../components/ui/Page";
import Card from "../components/cards/Card";
import AddUserForm from "../components/common/forms/AddUserForm";
import InviteUserForm from "../components/common/forms/InviteUserForm";
import { useSettingsStatus } from "../hooks/useSettingsStatus";

export default function AddUserPage() {
  const navigate = useNavigate();
  const { smtpConfigured } = useSettingsStatus();
  // "manual" = create the account here; "invite" = email an invitation link.
  const [mode, setMode] = useState("manual");

  const tabClass = (active) => cn(
    "flex items-center gap-2 px-4 py-2 rounded-pill text-sm motion-safe:transition-all",
    active
      ? "bg-accent text-primary font-medium"
      : "text-secondary/80 hover:text-secondary",
  );

  return (
    <Page title="Add User" titleId="add-user-title" headerClassName="mb-6" data-slot="add-user">
      <Card className="max-w-lg mx-auto">
        {/* How to add this user: create manually, or (if email is set up) send an
            invitation so they set their own username + password. */}
        <div className="flex gap-2 mb-6 p-1 bg-primary/10 rounded-pill w-fit mx-auto">
          <button
            type="button"
            onClick={() => setMode("manual")}
            className={tabClass(mode === "manual")}
          >
            <UserPlus size={14} /> Create manually
          </button>
          <button
            type="button"
            onClick={() => smtpConfigured && setMode("invite")}
            disabled={!smtpConfigured}
            className={cn(tabClass(mode === "invite"), "disabled:opacity-40 disabled:cursor-not-allowed")}
            title={smtpConfigured ? "Send an invitation by email" : "Set up email in Settings first"}
          >
            <Mail size={14} /> Send invitation
          </button>
        </div>

        {mode === "manual" ? (
          <AddUserForm onSuccess={() => navigate("/users")} />
        ) : (
          <InviteUserForm onSuccess={() => navigate("/users")} />
        )}

        {!smtpConfigured && (
          <p className="text-xs text-secondary/50 mt-6 text-center">
            Want to send an invitation instead? Set up email in Settings → Email first.
          </p>
        )}
      </Card>
    </Page>
  );
}