import Page from "../ui/Page";
import Card from "../cards/Card";
import { useAuth } from "../../context/AuthContext";

/**
 * Gate for pages only an admin should use.
 */
export default function RequireAdmin({ children, title = "This page is for admins" }) {
  const { user } = useAuth();
  if (user?.role === "admin") return children;
  return (
    <Page title={title} titleId="admin-only-title">
      <Card>
        <p className="text-primary text-sm">
          This screen is for Admins. Members can use folders and albums shared with them — ask an Admin if you need something changed here.
        </p>
      </Card>
    </Page>
  );
}
