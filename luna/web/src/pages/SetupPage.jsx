import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cable, Check, Lock, Router, Wifi } from "lucide-react";
import SetupWizard from "../components/ui/SetupWizard";
import Card from "../components/cards/Card";
import Pill from "../components/common/Pill";
import Button from "../components/ui/Button";
import TextLink from "../components/ui/TextLink";
import { getJson, postJson } from "../lib/api";
import { useAuth } from "../context/AuthContext";

const STEPS = [
  { id: "welcome", label: "Welcome" },
  { id: "connection", label: "Connection" },
  { id: "wifi", label: "Wi-Fi" },
  { id: "account", label: "Account" },
  { id: "name", label: "Name" },
  { id: "done", label: "Done" },
];

export default function SetupPage() {
  const queryClient = useQueryClient();
  const { user, login } = useAuth();
  const [stepId, setStepId] = useState("welcome");
  const [skipWifi, setSkipWifi] = useState(false);
  const [selected, setSelected] = useState(null);
  const [password, setPassword] = useState("");
  const [name, setName] = useState("Luna");
  const [accountUsername, setAccountUsername] = useState("");
  const [accountDisplayName, setAccountDisplayName] = useState("");
  const [accountPassword, setAccountPassword] = useState("");
  const [accountBusy, setAccountBusy] = useState(false);
  const [error, setError] = useState(null);

  const authStatus = useQuery({ queryKey: ["auth-status"], queryFn: () => getJson("/api/v1/auth/status") });

  const status = useQuery({
    queryKey: ["network-status"],
    queryFn: () => getJson("/api/v1/network/status"),
    refetchInterval: 3000,
  });
  const wifi = useQuery({
    queryKey: ["wifi-status"],
    queryFn: () => getJson("/api/v1/network/wifi"),
    refetchInterval: 3000,
    retry: false,
  });
  const scan = useQuery({
    queryKey: ["wifi-scan"],
    queryFn: () => getJson("/api/v1/network/wifi/scan"),
    enabled: stepId === "wifi",
    retry: false,
  });

  const connect = useMutation({
    mutationFn: () => postJson("/api/v1/network/wifi/connect", { ssid: selected, password }),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["wifi-status"] });
      queryClient.invalidateQueries({ queryKey: ["network-status"] });
    },
    onError: (err) => setError(String(err)),
  });

  const save = useMutation({
    mutationFn: async (/** @type {{ deviceName: string, done: boolean }} */ { deviceName, done }) => postJson("/api/v1/setup", { name: deviceName, setup_completed: done }),
  });

  async function createAdmin() {
    setError(null);
    setAccountBusy(true);
    try {
      await postJson("/api/v1/auth/register", {
        username: accountUsername,
        display_name: accountDisplayName || accountUsername,
        password: accountPassword,
      });
      await login(accountUsername, accountPassword);
      queryClient.invalidateQueries({ queryKey: ["auth-status"] });
      setStepId("name");
    } catch (err) {
      setError(String(err));
    } finally {
      setAccountBusy(false);
    }
  }

  const ethernet = status.data?.ethernet_connected;
  const wifiConnected = wifi.data?.connected || status.data?.wifi_connected;

  async function goNext() {
    if (stepId === "welcome") {
      setStepId("connection");
      return;
    }
    if (stepId === "connection") {
      if (ethernet && skipWifi) setStepId("account");
      else setStepId("wifi");
      return;
    }
    if (stepId === "wifi") {
      setStepId("account");
      return;
    }
    if (stepId === "account") {
      setStepId("name");
      return;
    }
    if (stepId === "name") {
      try {
        await save.mutateAsync({ deviceName: name, done: true });
        setStepId("done");
      } catch (err) {
        setError(String(err));
      }
    }
  }

  function goBack() {
    const idx = STEPS.findIndex((s) => s.id === stepId);
    if (idx > 0) setStepId(STEPS[idx - 1].id);
  }

  const nextLoading = stepId === "name" && save.isPending;
  const hasAdmin = authStatus.data?.has_admin;
  const accountReady = hasAdmin ? !!user : false;
  const nextDisabled =
    (stepId === "connection" && !ethernet && !wifiConnected) ||
    (stepId === "wifi" && !wifiConnected && !ethernet) ||
    (stepId === "account" && !hasAdmin && (accountUsername.trim().length < 3 || accountPassword.length < 8)) ||
    (stepId === "account" && hasAdmin && !accountReady) ||
    (stepId === "name" && name.trim().length === 0);

  return (
    <div className="min-h-screen bg-primary text-secondary">
      <SetupWizard
        steps={STEPS}
        currentStepId={stepId}
        onBack={stepId === "welcome" ? null : goBack}
        onNext={goNext}
        nextDisabled={nextDisabled}
        nextLoading={nextLoading}
        showBack={stepId !== "welcome" && stepId !== "done"}
        showNext={stepId !== "done"}
        nextLabel={stepId === "name" ? "Finish setup" : "Continue"}
      >
        {stepId === "welcome" && (
          <div className="space-y-5">
            <h2 className="font-mono text-xl">Luna</h2>
            <p className="text-primary text-sm">
              Your files, your drives, your house. No subscription — ever.
            </p>
            <Card noPopIn noHeightAnim>
              <p className="text-primary text-sm">You can always find Luna at:</p>
              <ul className="mt-3 space-y-2 text-xs text-primary">
                <li className="flex items-center gap-2"><Cable size={14} className="text-accent" /><span className="font-mono">luna.local</span> — most phones and computers</li>
                <li className="flex items-center gap-2"><Router size={14} className="text-accent" /><span className="font-mono">http://luna</span> — through your internet box</li>
                <li className="flex items-center gap-2"><Check size={14} className="text-accent" /><span className="font-mono">http://169.254.42.42</span> — cable straight from a computer, always works</li>
              </ul>
            </Card>
          </div>
        )}

        {stepId === "connection" && (
          <div className="space-y-5">
            <h2 className="font-mono text-xl">How is Luna connected?</h2>
            {ethernet ? (
              <Pill variant="success">Connected by cable</Pill>
            ) : (
              <Pill variant="warning">Not connected by cable</Pill>
            )}
            <p className="text-primary text-sm">
              {ethernet
                ? "Luna is on your network. You can also connect it to Wi-Fi so you can move it anywhere."
                : "Luna needs a connection to your home network. Let's connect it to Wi-Fi."}
            </p>
            {ethernet && (
              <div className="flex flex-wrap gap-3">
                <Button variant="secondary" onClick={() => { setSkipWifi(false); setStepId("wifi"); }}>
                  <Wifi size={14} /> Also connect to Wi-Fi
                </Button>
                <Button variant="outline" onClick={() => { setSkipWifi(true); setStepId("name"); }}>
                  Continue with cable
                </Button>
              </div>
            )}
            {!ethernet && <p className="text-accent text-xs">Plug in the network cable if you have one — Luna will notice.</p>}
          </div>
        )}

        {stepId === "wifi" && (
          <div className="space-y-5">
            <h2 className="font-mono text-xl">Choose your Wi-Fi</h2>
            {wifiConnected ? (
              <Pill variant="success">Connected to {wifi.data?.ssid || "Wi-Fi"}</Pill>
            ) : (
              <p className="text-primary text-sm">
                Pick your home network, then enter its password. That password is
                the one on the sticker of your internet box.
              </p>
            )}
            <div className="grid gap-2">
              {(scan.data || []).map((net) => (
                <button
                  key={net.ssid}
                  type="button"
                  onClick={() => { setSelected(net.ssid); setError(null); }}
                  className={`flex items-center justify-between rounded-large-element border-2 p-4 text-left motion-safe:transition-all ${
                    selected === net.ssid ? "border-accent bg-secondary/10" : "border-secondary/30"
                  }`}
                >
                  <span className="flex items-center gap-2 text-primary text-sm">
                    <Wifi size={16} className="text-accent" />
                    {net.ssid}
                  </span>
                  <span className="flex items-center gap-2 text-primary text-xs">
                    {net.encrypted && <Lock size={12} />}
                    {net.signal >= -50 ? "Strong" : net.signal >= -70 ? "Good" : "Weak"}
                  </span>
                </button>
              ))}
            </div>
            {scan.isError && <p className="text-primary text-sm">Wi-Fi isn't available on this Luna. Use the cable instead.</p>}
            {selected && !wifiConnected && (
              <div className="space-y-3">
                <input
                  type="password"
                  className="w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                  placeholder="Wi-Fi password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <Button variant="secondary" fullWidth loading={connect.isPending} onClick={() => connect.mutate()}>
                  Connect to {selected}
                </Button>
              </div>
            )}
            {error && <p className="text-error text-xs">{error}</p>}
          </div>
        )}

        {stepId === "account" && (
          <div className="space-y-5">
            <h2 className="font-mono text-xl">Create your admin account</h2>
            {!hasAdmin ? (
              <>
                <p className="text-primary text-sm">
                  This account protects every file on Luna. You can add people
                  for the rest of your household later.
                </p>
                <label className="block">
                  <span className="text-primary text-xs">Your name</span>
                  <input className="mt-2 w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                    value={accountDisplayName} onChange={(e) => setAccountDisplayName(e.target.value)} />
                </label>
                <label className="block">
                  <span className="text-primary text-xs">Username</span>
                  <input className="mt-2 w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                    value={accountUsername} autoComplete="username" onChange={(e) => setAccountUsername(e.target.value)} />
                </label>
                <label className="block">
                  <span className="text-primary text-xs">Password (8+ characters)</span>
                  <input type="password" className="mt-2 w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                    value={accountPassword} autoComplete="new-password" onChange={(e) => setAccountPassword(e.target.value)} />
                </label>
                {error && <p className="text-error text-xs">{error}</p>}
                <Button variant="secondary" fullWidth loading={accountBusy} onClick={createAdmin}>
                  Create account and continue
                </Button>
              </>
            ) : user ? (
              <p className="text-primary text-sm">
                Signed in as <span className="font-mono">{user.username}</span>. This account manages Luna.
              </p>
            ) : (
              <p className="text-primary text-sm">
                This Luna already has an account. <TextLink to="/login" state={{ from: "/setup" }}>Sign in</TextLink> to continue setup.
              </p>
            )}
          </div>
        )}

        {stepId === "name" && (
          <div className="space-y-5">
            <h2 className="font-mono text-xl">Name your Luna</h2>
            <p className="text-primary text-sm">
              This is the name you'll see when you open Luna. If you ever have
              two, each gets its own name.
            </p>
            <input
              className="w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
            />
            {error && <p className="text-error text-xs">{error}</p>}
          </div>
        )}

        {stepId === "done" && (
          <div className="space-y-5 text-center">
            <h2 className="font-mono text-xl">{name || "Luna"} is ready</h2>
            <p className="text-primary text-sm">Now plug in a USB drive. Luna will notice and won't touch a thing until you say so.</p>
            <div className="flex justify-center gap-3">
              <TextLink to="/drives" className="inline-flex items-center gap-2 rounded-pill bg-secondary text-primary px-5 py-2.5 text-sm">
                Go to drives
              </TextLink>
            </div>
          </div>
        )}
      </SetupWizard>
    </div>
  );
}
