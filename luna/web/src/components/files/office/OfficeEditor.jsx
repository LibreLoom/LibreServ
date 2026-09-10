import { useEffect, useState } from "react";
import Card from "../../cards/Card.jsx";
import FallbackOfficeEditor from "./FallbackOfficeEditor.jsx";

/**
 * Office entry point. Optional EuroOffice AGPL assets may live under /eurooffice;
 * until a DocsAPI bridge ships, editing always uses the collaborative fallback
 * (same WebSocket protocol). When assets are present we show an AGPL notice.
 *
 * @param {{
 *   driveId: string,
 *   path: string,
 *   canWrite?: boolean,
 *   onSaved?: () => void,
 *   onClose?: () => void,
 * }} props
 */
export default function OfficeEditor(props) {
  const [euroNotice, setEuroNotice] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/eurooffice/web-apps/apps/api/documents/api.js", {
          method: "HEAD",
          credentials: "same-origin",
        });
        if (!cancelled) setEuroNotice(res.ok);
      } catch {
        if (!cancelled) setEuroNotice(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {euroNotice ? (
        <div className="shrink-0 px-3 pt-2">
          <Card className="!p-3" noPopIn surface="primary">
            <p className="text-sm text-secondary">
              EuroOffice files are on this Luna (AGPL). Editing still uses Luna&apos;s built-in
              collaborative text mode until the EuroOffice bridge is enabled. See{" "}
              <span className="font-mono">luna/docs/eurooffice.md</span>.
            </p>
          </Card>
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <FallbackOfficeEditor {...props} />
      </div>
    </div>
  );
}
