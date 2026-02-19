import { useState, useEffect } from "react";
import { useParams, Navigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import HeaderCard from "../components/common/cards/HeaderCard";
import InstallWizard from "../components/app/wizard/InstallWizard";

export default function AppInstallPage() {
  const { appId } = useParams();
  const { request } = useAuth();
  const [app, setApp] = useState(null);

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
    <main
      className="bg-primary text-secondary px-8 pt-5 pb-32"
      aria-labelledby="install-title"
      id="main-content"
      tabIndex={-1}
    >
      <HeaderCard
        id="install-title"
        title={app ? `Install ${app.name}` : "Install App"}
      />
      <div className="mt-8">
        <InstallWizard appId={appId} />
      </div>
    </main>
  );
}
