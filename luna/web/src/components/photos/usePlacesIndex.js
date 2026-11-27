import { useEffect, useMemo, useState } from "react";
import { buildPlacesIndex, clusterToPlace } from "./placesIndex.js";

const WORKER_THRESHOLD = 1500;

/** @param {Array<any>} markers */
export function usePlacesIndex(markers) {
  const useWorker = typeof Worker === "function" && markers.length >= WORKER_THRESHOLD;
  const [active, setActive] = useState(null);
  const [failed, setFailed] = useState(null);
  useEffect(() => {
    if (!useWorker) return undefined;
    let worker;
    let serial = 0;
    let closed = false;
    const pending = new Map();
    const close = () => {
      if (closed) return;
      closed = true;
      worker?.terminate();
      for (const { reject } of pending.values()) reject(new Error("Places index closed"));
      pending.clear();
    };
    const fail = () => {
      if (closed) return;
      close();
      setFailed(markers);
    };
    function request(operation, ...args) {
      return new Promise((resolve, reject) => {
        if (closed) {
          reject(new Error("Places index closed"));
          return;
        }
        const id = ++serial;
        pending.set(id, { resolve, reject });
        try {
          worker.postMessage({ id, operation, args });
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });
    }
    try {
      worker = new Worker(new URL("./placesIndex.worker.js", import.meta.url), { type: "module" });
      worker.onerror = fail;
      worker.onmessage = ({ data }) => {
        if (data.id === 0) {
          if (data.error) fail();
          else if (!closed) setActive({
            markers,
            index: {
              clusters: (bbox, zoom) => request("clusters", bbox, zoom),
              place: (cluster) => request("place", cluster),
              expansionZoom: (id) => request("expansionZoom", id),
            },
          });
          return;
        }
        const response = pending.get(data.id);
        if (!response) return;
        pending.delete(data.id);
        if (data.error) response.reject(new Error(data.error));
        else response.resolve(data.value);
      };
      worker.postMessage({ id: 0, operation: "build", args: [markers] });
    } catch {
      queueMicrotask(fail);
      return close;
    }
    return close;
  }, [markers, useWorker]);

  return useMemo(() => {
    if (useWorker && failed !== markers) return active?.markers === markers ? active.index : null;
    const index = buildPlacesIndex(markers);
    return {
      clusters: (bbox, zoom) => index.getClusters(bbox, zoom),
      place: (cluster) => clusterToPlace(cluster, index),
      expansionZoom: (id) => index.getClusterExpansionZoom(id),
    };
  }, [active, failed, markers, useWorker]);
}
