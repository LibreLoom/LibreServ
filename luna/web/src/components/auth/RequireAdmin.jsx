import Page from "../ui/Page";
import Card from "../cards/Card";
import { useAuth } from "../../context/AuthContext";

/**
 * Household-language gate for pages only the caretaker of this Luna should use.
 */
export default function RequireAdmin({ children, title = "This page is for the person who takes care of this Luna" }) {
  const { user } = useAuth();
  if (user?.role === "admin") return children;
  return (
    <Page title={title} titleId="admin-only-title">
      <Card>
        <p className="text-primary text-sm">
          This screen changes how the whole house uses Luna. Ask the person
          who set Luna up if you need something here.
        </p>
      </Card>
    </Page>
  );
}
