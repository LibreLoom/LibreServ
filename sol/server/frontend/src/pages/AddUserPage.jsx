import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { UserPlus, Mail } from "lucide-react";
import Page from "../components/ui/Page";
import Card from "../components/cards/Card";
import SegmentedControl from "../components/common/SegmentedControl";
import AddUserForm from "../components/common/forms/AddUserForm";
import InviteUserForm from "../components/common/forms/InviteUserForm";
import { useSettingsStatus } from "../hooks/useSettingsStatus";
import { useToast } from "../context/ToastContext";

export default function AddUserPage() {
  const navigate = useNavigate();
  const { smtpConfigured } = useSettingsStatus();
  const { addToast } = useToast();
  // "manual" = create the account here; "invite" = email an invitation link.
  const [mode, setMode] = useState("manual");

  // Clicking the disabled "Send invitation" segment explains how to enable it,
  // instead of silently doing nothing.
  const handleDisabledClick = () => {
    addToast({
      type: "info",
      message: "Invitations need email setup",
      description: "Go to Settings → External Services to enable email invitations.",
    });
  };

  return (
    <Page title="Add User" titleId="add-user-title" headerClassName="mb-6" data-slot="add-user">
      <Card className="max-w-lg mx-auto">
        {/* How to add this user: create manually, or (if email is set up) send an
            invitation so they set their own username + password. */}
        <div className="flex justify-center mb-6">
          <SegmentedControl
            value={mode}
            onChange={setMode}
            onDisabledClick={handleDisabledClick}
            options={[
              { value: "manual", label: "Create manually", icon: UserPlus },
              {
                value: "invite",
                label: "Send invitation",
                icon: Mail,
                disabled: !smtpConfigured,
                title: smtpConfigured
                  ? "Send an invitation by email"
                  : "Set up email in Settings → External Services first",
              },
            ]}
          />
        </div>

        {mode === "manual" ? (
          <AddUserForm onSuccess={() => navigate("/users")} />
        ) : (
          <InviteUserForm onSuccess={() => navigate("/users")} />
        )}

        {!smtpConfigured && (
          <p className="text-xs text-primary mt-6 text-center">
            Want to send an invitation instead? Set up email in Settings → External Services first.
          </p>
        )}
      </Card>
    </Page>
  );
}