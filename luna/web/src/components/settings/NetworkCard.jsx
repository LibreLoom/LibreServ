import { useQuery } from "@tanstack/react-query";
import { Cable } from "lucide-react";
import Card from "../cards/Card";
import Pill from "../common/Pill";
import { TermHint } from "../ui/Tooltip";
import { getJson } from "../../lib/api";

/**
 * Ethernet-only home network status. Luna has no Wi-Fi uplink UI —
 * batch-1 hardware ships a patch cable and no USB Wi-Fi dongle.
 */
export default function NetworkCard() {
  const netStatus = useQuery({
    queryKey: ["network-status"],
    queryFn: () => getJson("/api/v1/network/status"),
    refetchInterval: 5000,
    retry: false,
  });

  const ethernet = Boolean(netStatus.data?.ethernet_connected);
  const ipv4 = (netStatus.data?.ipv4 || []).filter(Boolean);
  const online =
    ethernet && (netStatus.data?.has_default_route || ipv4.length > 0);

  return (
    <Card icon={Cable} title="Home network">
      <p className="text-primary text-sm">
        Plug Luna into your{" "}
        <TermHint content="The box that brings internet into the house. Often labeled WAN, Internet, or LAN on the back.">
          router
        </TermHint>
        {" "}or modem with the included{" "}
        <TermHint content="The clip-in network cable in the box. Same shape as a phone jack, but wider.">
          RJ45
        </TermHint>
        {" "}(ethernet) cable. Phones and computers reach Luna on this network
        while they stay on home Wi-Fi.
      </p>
      <ul className="mt-4 space-y-2 text-sm text-primary">
        <li className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2">
            <Cable size={16} aria-hidden="true" />
            Cable
          </span>
          <Pill variant={ethernet ? "success" : "muted"}>
            {ethernet
              ? ipv4[0]
                ? ipv4[0]
                : online
                  ? "Plugged in"
                  : "Plugged in — waiting for an address"
              : "Not plugged in"}
          </Pill>
        </li>
      </ul>
      {!ethernet && (
        <p className="text-primary text-sm mt-3">
          Use the included cable. Luna does not join Wi-Fi itself.
        </p>
      )}
    </Card>
  );
}
