package models

import (
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/database"
)

func TestProviderAndModelLifecycle(t *testing.T) {
	db := database.OpenTestDB(t)
	svc := NewService(db)

	provider, err := svc.CreateProvider("Example AI", "https://ai.example/v1", "secret", "paid", true)
	if err != nil {
		t.Fatalf("CreateProvider: %v", err)
	}
	gotProvider, err := svc.GetProvider(provider.ID)
	if err != nil || gotProvider == nil || gotProvider.APIKey != "secret" {
		t.Fatalf("GetProvider = %#v, %v", gotProvider, err)
	}
	if missing, err := svc.GetProvider("missing"); err != nil || missing != nil {
		t.Fatalf("missing provider = %#v, %v", missing, err)
	}
	providers, err := svc.ListProviders()
	if err != nil || len(providers) != 1 {
		t.Fatalf("ListProviders = %#v, %v", providers, err)
	}
	if err := svc.UpdateProvider(provider.ID, "Updated AI", "https://new.example/v1", "new-secret", "free", false); err != nil {
		t.Fatalf("UpdateProvider: %v", err)
	}

	model, err := svc.CreateModel(provider.ID, "example-large", "Example Large", "agent", 1.2, 3.4, 0.5, 128000, true, 2)
	if err != nil {
		t.Fatalf("CreateModel: %v", err)
	}
	review, err := svc.CreateModel(provider.ID, "example-review", "Example Review", "review", 0.2, 0.4, 0, 64000, true, 1)
	if err != nil {
		t.Fatalf("CreateModel review: %v", err)
	}
	all, err := svc.ListModels("")
	if err != nil || len(all) != 2 {
		t.Fatalf("ListModels all = %#v, %v", all, err)
	}
	agentModels, err := svc.ListModels("agent")
	if err != nil || len(agentModels) != 1 || agentModels[0].ID != model.ID {
		t.Fatalf("ListModels agent = %#v, %v", agentModels, err)
	}
	if err := svc.UpdateModel(model.ID, "example-v2", "Example V2", "agent", 2, 4, 1, 256000, true, 0); err != nil {
		t.Fatalf("UpdateModel: %v", err)
	}

	if _, err := db.Exec(
		`INSERT INTO ai_fallback_chains (role, tier, model_id, priority) VALUES ('agent', 'paid', $1, 1)`,
		model.ID); err != nil {
		t.Fatalf("insert fallback: %v", err)
	}
	chain, err := svc.GetFallbackChain("agent", "paid")
	if err != nil || len(chain) != 1 || chain[0].ModelID != "example-v2" {
		t.Fatalf("GetFallbackChain = %#v, %v", chain, err)
	}
	resolved, err := svc.ResolveModelForDevice("agent", "one")
	if err != nil || resolved.ID != model.ID {
		t.Fatalf("ResolveModelForDevice paid = %#v, %v", resolved, err)
	}
	resolved, err = svc.ResolveModelForDevice("review", "free")
	if err != nil || resolved.ID != review.ID {
		t.Fatalf("ResolveModelForDevice fallback = %#v, %v", resolved, err)
	}
	resolvedProvider, err := svc.ResolveProvider(resolved)
	if err != nil || resolvedProvider.ID != provider.ID {
		t.Fatalf("ResolveProvider = %#v, %v", resolvedProvider, err)
	}

	if err := svc.DeleteModel(review.ID); err != nil {
		t.Fatalf("DeleteModel: %v", err)
	}
	if err := svc.DeleteProvider(provider.ID); err != nil {
		t.Fatalf("DeleteProvider: %v", err)
	}
	if providers, err := svc.ListProviders(); err != nil || len(providers) != 0 {
		t.Fatalf("providers after delete = %#v, %v", providers, err)
	}
}

func TestResolveModelReportsMissingRole(t *testing.T) {
	svc := NewService(database.OpenTestDB(t))
	if model, err := svc.ResolveModelForDevice("agent", "free"); err == nil || model != nil {
		t.Fatalf("ResolveModelForDevice = %#v, %v", model, err)
	}
}
