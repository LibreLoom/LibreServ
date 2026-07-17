const SERVICE_PLAN_AVAILABILITY = {
  smtp: { free: true, one: true, lite: true },
  domain: { free: true, one: true, lite: true },
  backup: { free: false, one: true, lite: true },
  tunnel: { free: true, one: true, lite: true },
  ai: { free: true, one: true, lite: true },
};

export function isServiceAvailableOnPlan(serviceId, planId) {
  const availability = SERVICE_PLAN_AVAILABILITY[serviceId];
  if (!availability) return true;
  return availability[planId] !== false;
}

export function getConnectWarning(serviceId, connectStatus) {
  if (!connectStatus?.connected) {
    return { show: true, label: "Connect not connected", type: "warning" };
  }
  const planId = connectStatus?.plan?.id;
  if (planId && !isServiceAvailableOnPlan(serviceId, planId)) {
    const planName = connectStatus?.plan?.name || "your plan";
    return { show: true, label: `Not available on ${planName}`, type: "warning" };
  }
  return { show: false, label: "", type: "" };
}
