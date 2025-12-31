import { useParams } from "react-router-dom";
import Card from "../components/common/cards/Card";
import { services } from "../data/services";
import NotFoundPage from "./NotFoundPage";
import DetailedStatCard from "../components/common/cards/DetailedStatCard";

import { Server } from "lucide-react";

export default function AppDetailPage() {
  const { appName } = useParams();

  // Match the route parameter to the service list used by the cards.
  const service = services.find(
    (s) => s.name.toLowerCase() === appName.toLowerCase(),
  );

  if (!service) {
    // Unknown app slug falls back to the generic 404 page.
    return <NotFoundPage includeMain={false} />;
  }

  return (
    <main
      className="bg-primary text-secondary px-8 pt-5 pb-32"
      aria-labelledby="app-detail-title"
    >
      {/* Header */}
      <header className="px-0 mb-10">
        <Card>
          <div className="flex justify-between items-center">
            <div>
              <h1
                id="app-detail-title"
                className="text-center text-2xl font-bold"
              >
                {service.name}
              </h1>
            </div>
          </div>
        </Card>
      </header>
      <DetailedStatCard
        icon={Server}
        name={service.name}
        status={service.status}
        time={service.time}
        resources={service.resources}
      />
    </main>
  );
}
