import { useParams, Navigate } from "react-router-dom";
import HeaderCard from "../components/common/cards/HeaderCard";
import InstallWizard from "../components/app/wizard/InstallWizard";

export default function AppInstallPage() {
  const { appId } = useParams();

  if (!appId) {
    return <Navigate to="/apps" replace />;
  }

  return (
    <main
      className="bg-primary text-secondary px-8 pt-5 pb-32"
      aria-labelledby="install-title"
      id="main-content"
      tabIndex={-1}
    >
      <HeaderCard id="install-title" title="Install App" />
      <div className="mt-8">
        <InstallWizard appId={appId} />
      </div>
    </main>
  );
}
