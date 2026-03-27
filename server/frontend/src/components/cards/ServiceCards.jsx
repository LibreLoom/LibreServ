import ServiceStatusCard from "./ServiceStatusCard";
import { services, getBreakdownItems } from "../../../data/services";

export default function ServiceCards() {
  // Render a card per service so the list stays data-driven.
  return services.map((service) => (
    <ServiceStatusCard
      key={service.name}
      icon={service.icon}
      name={service.name}
      status={service.status}
      time={service.time}
      resourceUsage={service.resourceUsage}
      warningMessage={service.warningMessage}
      breakdownItems={getBreakdownItems(service.resources)}
    />
  ));
}
