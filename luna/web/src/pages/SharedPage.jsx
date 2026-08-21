import { useQuery } from "@tanstack/react-query";
import { FolderOpen } from "lucide-react";
import Page from "../components/ui/Page";
import Card from "../components/cards/Card";
import Pill from "../components/common/Pill";
import EmptyState from "../components/common/EmptyState";
import TextLink from "../components/ui/TextLink";
import { getJson } from "../lib/api";

export default function SharedPage() {
  const access = useQuery({ queryKey: ["my-access"], queryFn: () => getJson("/api/v1/me/access") });

  return (
    <Page title="Shared with me" titleId="shared-title">
      <div className="grid gap-4 md:grid-cols-2">
        {(access.data || []).map((grant) => (
          <Card key={grant.id} icon={FolderOpen} title={grant.drive_label}>
            <p className="text-primary font-mono text-sm">
              {grant.path || "Whole drive"}
            </p>
            <div className="mt-3 flex items-center justify-between gap-3">
              <Pill variant={grant.permission === "write" ? "success" : "info"}>
                {grant.permission === "write" ? "Can add and change" : "Can look"}
              </Pill>
              <TextLink surface="secondary" to={`/drives/${grant.drive_id}?path=${encodeURIComponent(grant.path)}`}>Open</TextLink>
            </div>
          </Card>
        ))}
      </div>
      {!access.isLoading && (access.data || []).length === 0 && (
        <EmptyState
          icon={FolderOpen}
          title="Nothing shared yet"
        description="When the person who takes care of this Luna shares a folder with you in People, it will show up here. Ask them if you expected to see something."
        />
      )}
    </Page>
  );
}
