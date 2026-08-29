import { useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import ModalCard from "../cards/ModalCard.jsx";
import Button from "../ui/Button.jsx";
import { encodePairing } from "../../lib/pairing.js";

/**
 * QR for the just-created access token. Black-on-white on purpose — scanners
 * need that contrast; this is a barcode, not a themed surface.
 */
export default function PairingQrModal({ open, token, onClose }) {
  const canvasRef = useRef(null);
  const url = typeof window !== "undefined" ? window.location.origin : "";
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
            On the phone, open Luna and tap Scan QR code. That fills the Luna
            address and the access token. Then tap Sign in.
          </p>
          <div className="flex justify-center rounded-large-element bg-primary p-4">
            {failed ? (
              <p className="text-secondary text-sm">
                Could not draw the QR code. Copy the access token instead.
              </p>
            ) : (
              <canvas
                ref={canvasRef}
                width={240}
                height={240}
                className="bg-primary"
                aria-label="QR code for Luna address and access token"
              />
            )}
          </div>
          <p className="text-primary text-sm">
            This QR includes the address you are using now ({url || "this page"})
            and the access token. Anyone who scans it can reach your files on
            Luna.
          </p>
          <div className="flex justify-end">
            <Button variant="accent" onClick={close}>Done</Button>
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
