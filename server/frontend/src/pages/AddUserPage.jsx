import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { UserPlus, Mail } from "lucide-react";
import Page from "../components/ui/Page";
import Card from "../components/cards/Card";
import Button from "../components/ui/Button";
import AddUserForm from "../components/common/forms/AddUserForm";
import InviteUserForm from "../components/common/forms/InviteUserForm";
import { useSettingsStatus } from "../hooks/useSettingsStatus";

export default function AddUserPage() {
  const navigate = useNavigate();
  const { smtpConfigured } = useSettingsStatus();
  // "manual" = create the account here; "invite" = email an invitation link.
  const [mode, setMode] = useState("manual");

  return (
    <Page title="Add User" titleId="add-user-title" headerClassName="mb-6" data-slot="add-user">
      <Card className="max-w-lg mx-auto">
        {/* How to add this user: create manually, or (if email is set up) send an
            invitation so they set their own username + password. */}
        <div className="flex gap-2 mb-6 p-1 bg-primary/10 rounded-pill w-fit mx-auto">
          <Button
            variant={mode === "manual" ? "accent" : "ghost"}
            surface="primary"
            active={mode === "manual"}
            onClick={() => setMode("manual")}
          >
            <UserPlus size={14} /> Create manually
          </Button>
          <Button
            variant={mode === "invite" ? "accent" : "ghost"}
            surface="primary"
            active={mode === "invite"}
            onClick={() => smtpConfigured && setMode("invite")}
            disabled={!smtpConfigured}
            title={smtpConfigured ? "Send an invitation by email" : "Set up email in Settings first"}
          >
            <Mail size={14} /> Send invitation
          </Button>
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