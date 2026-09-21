export function getConnectWarning(serviceId, connectStatus) {
  if (!connectStatus?.connected) {
    return { show: true, label: "Connect not connected", type: "warning" };
  }
  const svc = connectStatus?.services?.[serviceId];
  if (svc?.state === "unavailable") {
    const planName = connectStatus?.plan?.name || "your plan";
    return { show: true, label: `Not available on ${planName}`, type: "warning" };
  }
  return { show: false, label: "", type: "" };
}
