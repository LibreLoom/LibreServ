import { useState, useEffect } from "react";
import { useParams, Navigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import Page from "../components/ui/Page";
import InstallWizard from "../components/app/wizard/InstallWizard";

export default function AppInstallPage() {
  const { appId } = useParams();
  const [searchParams] = useSearchParams();
  const { request } = useAuth();
  const [app, setApp] = useState(null);
  const initialInstanceId = searchParams.get("instance") || undefined;

  useEffect(() => {
    if (!appId) return;
    const fetchApp = async () => {
      try {
        const res = await request(`/catalog/${appId}`);
        const data = await res.json();
        setApp(data);
      } catch (err) {
        console.error("Failed to fetch app details:", err);
      }
    };
    fetchApp();
  }, [appId, request]);

  if (!appId) {
    return <Navigate to="/apps" replace />;
  }

  return (
    <Page data-slot="app-install-page" title={app ? `Install ${app.name}` : "Install App"} titleId="install-title" headerClassName="">
      <div className="mt-8">
        <InstallWizard appId={appId} initialInstanceId={initialInstanceId} />
      </div>
    </Page>
  );
}
