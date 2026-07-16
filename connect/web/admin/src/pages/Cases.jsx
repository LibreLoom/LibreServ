import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client.js";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card.jsx";
import { Button } from "../components/ui/button.jsx";
import { Input } from "../components/ui/input.jsx";
import { StatusBadge } from "../components/ui/badge.jsx";
import { Layout } from "../components/Layout.jsx";

export default function Cases() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ["cases"], queryFn: api.listCases });
  const [selectedId, setSelectedId] = useState(null);
  const [message, setMessage] = useState("");

  const { data: caseDetail } = useQuery({
    queryKey: ["case", selectedId],
    queryFn: () => api.getCase(selectedId),
    enabled: !!selectedId,
  });

  const msgMut = useMutation({
    mutationFn: /** @param {{id: string, text: string}} vars */ (vars) => api.addCaseMessage(vars.id, vars.text),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["case", selectedId] }); setMessage(""); },
  });

  return (
    <Layout>
      <h2 className="font-mono text-2xl font-bold mb-6">Support Cases</h2>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          {(data?.cases || []).map((c) => (
            <Card
              key={c.id}
              className={`cursor-pointer transition-all hover:scale-[1.01] ${selectedId === c.id ? "ring-2 ring-ring" : ""}`}
              onClick={() => setSelectedId(c.id)}
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-mono text-sm font-bold">{c.summary}</p>
                  <p className="text-sm text-muted-foreground">{c.device_id}</p>
                </div>
                <StatusBadge status={c.status} />
              </div>
            </Card>
          ))}
          {(!data?.cases || data.cases.length === 0) && (
            <Card><p className="text-muted-foreground text-center">No support cases.</p></Card>
          )}
        </div>

        {selectedId && caseDetail && (
          <Card className="animate-fade-in">
            <CardHeader><CardTitle>{caseDetail.summary}</CardTitle></CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground mb-4">Device: {caseDetail.device_id}</p>

              <div className="space-y-2 mb-4 max-h-64 overflow-y-auto">
                {(caseDetail.messages || []).map((msg, i) => (
                  <div key={i} className="rounded-pill bg-secondary px-4 py-2 text-sm">
                    <span className="font-mono text-muted-foreground">{msg.author}:</span> {msg.text}
                  </div>
                ))}
                {(!caseDetail.messages || caseDetail.messages.length === 0) && (
                  <p className="text-muted-foreground text-sm">No messages yet.</p>
                )}
              </div>

              <div className="flex gap-2">
                <Input
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Type a reply..."
                  onKeyDown={(e) => { if (e.key === "Enter" && message.trim()) msgMut.mutate({ id: selectedId, text: message }); }}
                />
                <Button
                  loading={msgMut.isPending}
                  onClick={() => msgMut.mutate({ id: selectedId, text: message })}
                  disabled={!message.trim()}
                >
                  Send
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </Layout>
  );
}
