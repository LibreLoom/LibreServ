import Page from "@libreloom/ui/components/ui/Page.jsx";
import Card from "@libreloom/ui/components/cards/Card.jsx";
import { useAuth } from "../../context/AuthContext";

/**
 * Gate for pages only an admin should use.
 */
export default function RequireAdmin({ children, title = "This page is only for Admins" }) {
  const { user } = useAuth();
  if (user?.role === "admin") return children;
  return (
    <Page title={title} titleId="admin-only-title">
      <Card>
        <p className="text-primary text-sm">
          This page is only for Admins. Members can only edit their own user settings.
        </p>
      </Card>
    </Page>
  );
}
