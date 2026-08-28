import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAdminAuth } from "../context/AdminAuthContext.jsx";
import { adminApi } from "../context/AdminAuthContext.jsx";
import { useTheme } from "../context/ThemeContext.jsx";
import { Button } from "../components/ui/button.jsx";
import { Input } from "../components/ui/input.jsx";
import { Label } from "../components/ui/label.jsx";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card.jsx";
import { LogOut, Sun, Moon } from "lucide-react";

function downloadTokensFile(tokens) {
  const body = `${tokens.join("\n")}\n`;
  const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "TOKENS";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function AdminTokensPage() {
  const { account, logout } = useAdminAuth();
  const { toggle } = useTheme();
  const navigate = useNavigate();
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [bulkCount, setBulkCount] = useState("100");
  const [bulkTokens, setBulkTokens] = useState([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [singleBusy, setSingleBusy] = useState(false);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div>
            <p className="font-mono text-lg">Luna Connect Admin</p>
            {account?.email && <p className="text-xs text-muted-foreground font-mono">{account.email}</p>}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={toggle} aria-label="Toggle theme">
              <Sun className="h-4 w-4 dark:hidden" />
              <Moon className="h-4 w-4 hidden dark:block" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                await logout();
                navigate("/admin/login");
              }}
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8 animate-fade-in">
        <h1 className="font-mono text-3xl mb-2">Setup codes</h1>
        <p className="text-muted-foreground mb-8">
          Official setup codes are created here. The public OS image has no code. Factory lists go on the installer USB as a file named TOKENS.
        </p>

        <Card className="mb-6" data-testid="official-token-recovery">
          <CardHeader>
            <CardTitle>Lost booklet code</CardTitle>
            <CardDescription>
              We need a way to mint a new official booklet token for a device that no longer has the old one. For now: the owner should contact support and refer to their order id. Support then issues a replacement official token (single token below). Paste it on Luna, or put it on the installer USB: add a line to TOKENS on the LUNAASSETS partition (factory magazine), or use a one-shot setup-token file next to the ISO payload.
            </CardDescription>
          </CardHeader>
        </Card>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Single booklet code</CardTitle>
            <CardDescription>Create one long code to print in a box or give as a remint.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button
              loading={singleBusy}
              onClick={async () => {
                setError("");
                setSingleBusy(true);
                try {
                  const data = await adminApi("/admin/setup-tokens", { method: "POST", body: "{}" });
                  setToken(data.token);
                } catch (err) {
                  setError(err.message);
                } finally {
                  setSingleBusy(false);
                }
              }}
            >
              New token
            </Button>
            {token && <p className="font-mono text-xl tracking-widest break-all">{token}</p>}
          </CardContent>
        </Card>

        <Card data-testid="bulk-tokens">
          <CardHeader>
            <CardTitle>Bulk factory tokens</CardTitle>
            <CardDescription>
              Create many 6-digit uppercase hex codes for the installer USB. Download the list as TOKENS (one code per line) and put that file on the LUNAASSETS partition.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="max-w-xs">
              <Label htmlFor="bulk-count">How many</Label>
              <Input
                id="bulk-count"
                type="number"
                min={1}
                max={10000}
                value={bulkCount}
                onChange={(e) => setBulkCount(e.target.value)}
              />
            </div>
            <div className="flex flex-wrap gap-3">
              <Button
                loading={bulkBusy}
                onClick={async () => {
                  setError("");
                  setBulkBusy(true);
                  try {
                    const n = Number.parseInt(bulkCount, 10);
                    const data = await adminApi("/admin/setup-tokens/bulk", {
                      method: "POST",
                      body: JSON.stringify({ count: n }),
                    });
                    setBulkTokens(data.tokens || []);
                  } catch (err) {
                    setError(err.message);
                  } finally {
                    setBulkBusy(false);
                  }
                }}
              >
                Create list
              </Button>
              <Button
                variant="secondary"
                disabled={bulkTokens.length === 0}
                onClick={() => downloadTokensFile(bulkTokens)}
              >
                Download TOKENS
              </Button>
            </div>
            {bulkTokens.length > 0 && (
              <div className="rounded-large-element border border-border bg-background p-4">
                <p className="font-mono text-sm text-muted-foreground mb-2">
                  {bulkTokens.length} codes · file name TOKENS
                </p>
                <pre className="font-mono text-sm max-h-64 overflow-auto whitespace-pre-wrap break-all">
                  {bulkTokens.join("\n")}
                </pre>
              </div>
            )}
          </CardContent>
        </Card>

        {error && <p className="mt-4 text-sm text-error">{error}</p>}
      </main>
    </div>
  );
}
