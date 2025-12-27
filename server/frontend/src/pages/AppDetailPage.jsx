import { useParams } from "react-router-dom";
import Card from "../components/common/cards/Card";
import { services } from "../data/services";
import NotFoundPage from "./NotFoundPage";
import DetailedStatCard from "../components/common/cards/DetailedStatCard";

import { Server } from "lucide-react";

export default function AppDetailPage() {
  const { appName } = useParams();

  const service = services.find(
    (s) => s.name.toLowerCase() === appName.toLowerCase(),
  );

  if (!service) {
    return <NotFoundPage />;
  }

  return (
    <main className="bg-primary text-secondary px-8 pt-5 pb-32">
      {/* Header */}
      <header className="px-0 mb-10">
        <Card>
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-center text-2xl font-bold">{service.name}</h1>
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
