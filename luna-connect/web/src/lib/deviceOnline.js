/** Poll interval while waiting for Luna to come online during onboarding. */
export const DEVICE_ONLINE_POLL_MS = 5000;

/**
 * @param {(path: string, opts?: object) => Promise<any>} api
 * @param {string} [deviceId]
 * @returns {Promise<boolean>}
 */
export async function fetchDeviceOnline(api, deviceId) {
  const res = await api("/api/v1/account/devices");
  const devices = res.devices || [];
  const dev = deviceId ? devices.find((d) => d.id === deviceId) : devices[0];
  return Boolean(dev?.online);
}
