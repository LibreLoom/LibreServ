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

/**
 * Luna setup readiness details: online with Connect, tunnel provisioned,
 * and whether Luna's public HTTPS address responds.
 *
 * @param {(path: string, opts?: object) => Promise<any>} api
 * @param {string} deviceId
 * @returns {Promise<{ online: boolean, has_tunnel: boolean, reachable: boolean, hostname: string, ready: boolean }>}
 */
export async function fetchDeviceSetupReadiness(api, deviceId) {
  if (!deviceId) {
    return {
      online: false,
      has_tunnel: false,
      reachable: false,
      hostname: "",
      ready: false,
    };
  }
  const res = await api(
    `/api/v1/account/devices/${encodeURIComponent(deviceId)}/setup-readiness`,
  );
  return {
    online: Boolean(res?.online),
    has_tunnel: Boolean(res?.has_tunnel),
    reachable: Boolean(res?.reachable),
    hostname: res?.hostname || "",
    ready: Boolean(res?.ready),
  };
}

/**
 * Luna is ready for the "Complete setup on Luna" step: online with Connect,
 * tunnel provisioned, and the public HTTPS address responds.
 *
 * @param {(path: string, opts?: object) => Promise<any>} api
 * @param {string} deviceId
 * @returns {Promise<boolean>}
 */
export async function fetchDeviceSetupReady(api, deviceId) {
  const readiness = await fetchDeviceSetupReadiness(api, deviceId);
  return readiness.ready;
}
