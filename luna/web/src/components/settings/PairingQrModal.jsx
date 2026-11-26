import { useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { useQuery } from "@tanstack/react-query";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import { getJson } from "../../lib/api.js";
import { encodePairing } from "../../lib/pairing.js";

/**
 * QR for the just-created access token. Black-on-white on purpose — scanners
 * need that contrast; this is a barcode, not a themed surface.
 */
export default function PairingQrModal({ open, token, onClose }) {
  const canvasRef = useRef(null);
  const connectStatus = useQuery({
    queryKey: ["connect-status"],
    queryFn: () => getJson("/api/v1/connect/status", { cache: "no-store" }),
    retry: false,
  });
  // A phone cannot use the browser's LAN origin when LAN access is blocked.
  // Encode the tunnel address instead so the scan works from anywhere.
  const lanBlocked = Boolean(
    connectStatus.data?.connect_active && !connectStatus.data?.lan_override,
  );
  const remoteHost = String(
    connectStatus.data?.hostname || connectStatus.data?.domain || "",
  ).trim();
  const browserOrigin = typeof window !== "undefined" ? window.location.origin : "";
  const url = lanBlocked && remoteHost ? `https://${remoteHost}` : browserOrigin;
  const stamp = `${open}:${token}:${url}`;
  const [failedFor, setFailedFor] = useState("");
  const failed = failedFor === stamp;

  useEffect(() => {
    if (!open || !token || !url) return undefined;
    let cancelled = false;
    import("qrcode").then((QRCode) => {
      if (cancelled || !canvasRef.current) return;
      return QRCode.toCanvas(
        canvasRef.current,
        encodePairing(url, token),
        { width: 240, margin: 2, errorCorrectionLevel: "M" },
      );
    }).catch(() => {
      if (!cancelled) setFailedFor(stamp);
    });
    return () => {
      cancelled = true;
    };
  }, [open, token, url, stamp]);

  return (
    <ModalCard
      open={open}
      title="Show as QR code"
      onClose={onClose}
      size="sm"
    >
      {({ close }) => (
        <div className="space-y-3">
          <p className="text-primary text-sm">
            On the phone, open the Luna app and tap Scan QR code. The scan
            fills in the address and access token. Then tap Sign in.
          </p>
          <div className="flex justify-center rounded-large-element surface-primary p-4">
            {failed ? (
              <p className="text-secondary text-sm">
                Could not draw the QR code. Copy the access token instead.
              </p>
            ) : (
              <canvas
                ref={canvasRef}
                width={240}
                height={240}
                className="surface-primary"
                aria-label="QR code for Luna address and access token"
              />
            )}
          </div>
          <p className="text-primary text-sm">
            This QR code holds the access token and the address you use now
            ({url ? <InlinePill>{url}</InlinePill> : "this page"}). Anyone who
            scans it can reach your files on Luna.
          </p>
          <div className="flex justify-end">
            <Button onClick={close}>Done</Button>
          </div>
        </div>
      )}
    </ModalCard>
  );
}

PairingQrModal.propTypes = {
  open: PropTypes.bool.isRequired,
  token: PropTypes.string,
  onClose: PropTypes.func.isRequired,
};
