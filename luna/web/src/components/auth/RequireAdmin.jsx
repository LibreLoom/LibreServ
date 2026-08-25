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
          This screen changes how everyone uses Luna. Ask an admin if you need something here.
        </p>
      </Card>
    </Page>
  );
}
