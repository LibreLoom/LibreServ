import { useQuery } from "@tanstack/react-query";
import PropTypes from "prop-types";
import { ArrowRight, Cable, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { getJson } from "../../lib/api";
import Button from "../ui/Button";
import Pill from "../common/Pill";
import { TermHint } from "../ui/Tooltip";

function BoardRow({ ok, okText, offText }) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 p-3.5 rounded-large-element border",
        "motion-safe:transition-colors motion-safe:duration-300",
        ok ? "bg-success/20 border-success/30" : "bg-primary/10 border-primary/15"
      )}
    >
      <span className="flex items-center gap-2.5 min-w-0">
        <Cable
          size={16}
          className={cn("shrink-0", ok ? "text-success" : "text-primary")}
        />
        <span className="font-mono text-sm text-primary">Cable</span>
      </span>
      <Pill variant={ok ? "success" : "muted"} className="shrink-0">
        {ok ? <Check size={12} /> : <X size={12} />}
        <span>{ok ? okText : offText}</span>
      </Pill>
    </div>
  );
}
BoardRow.propTypes = {
  ok: PropTypes.bool.isRequired,
  okText: PropTypes.string.isRequired,
  offText: PropTypes.string.isRequired,
};

export default function NetworkStep({ name, onContinue }) {
  const netStatus = useQuery({
    queryKey: ["network-status"],
    queryFn: () => getJson("/api/v1/network/status"),
    refetchInterval: 3000,
    retry: false,
  });
  const ethernet = Boolean(netStatus.data?.ethernet_connected);
  const ipv4 = (netStatus.data?.ipv4 || []).filter(Boolean);
  const online = ethernet && (netStatus.data?.has_default_route || ipv4.length > 0);
  const waitingLease = ethernet && !online;

  return (
    <div className="flex flex-col items-center text-center py-2" data-slot="setup-network-step">
      <Cable size={40} className="text-accent mx-auto mb-4" />
      <h1 className="font-mono text-3xl font-normal text-primary tracking-tight mb-3">
        Plug in the cable
      </h1>
      <p className="text-primary text-sm leading-relaxed max-w-md mb-8">
        {waitingLease
          ? "The cable is in. Waiting for an address from your router or modem."
          : online
            ? `${name} is on your home network. Stay on home Wi-Fi on your phone.`
            : (
              <>
                Plug {name} into power and into your{" "}
                <TermHint content="The box that brings internet into the house. Often labeled WAN, Internet, or LAN on the back.">
                  router
                </TermHint>
                {" "}or modem with the included{" "}
                <TermHint content="The clip-in network cable in the box. Same shape as a phone jack, but wider.">
                  RJ45
                </TermHint>
                {" "}(ethernet) cable.
              </>
            )}
      </p>

      <div className="w-full max-w-sm space-y-2 mb-8" data-slot="network-board">
        <BoardRow
          ok={ethernet}
          okText={ipv4[0] ? ipv4[0] : "Plugged in"}
          offText="Not plugged in"
        />
      </div>

      {online && (
        <div className="w-full max-w-sm">
          <Button variant="primary" fullWidth onClick={onContinue} className="group py-4 font-mono">
            Continue
            <ArrowRight className="w-4 h-4 motion-safe:transition-transform motion-safe:duration-200 group-hover:translate-x-0.5" />
          </Button>
        </div>
      )}
    </div>
  );
}

NetworkStep.propTypes = {
  name: PropTypes.string.isRequired,
  onContinue: PropTypes.func.isRequired,
};
