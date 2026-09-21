package handlers

import "testing"

func TestResolveOnboardingSkipsCodeWhenBound(t *testing.T) {
	dev := BoundDevice{ID: "dev_1", HasBound: true}
	path, step := ResolveOnboarding("official", "code", dev)
	if path != "official" || step != "domain" {
		t.Fatalf("bound without name: got %s/%s", path, step)
	}

	dev.Subdomain = "kitchen"
	dev.Hostname = "kitchen.luna.servers.libreloom.org"
	path, step = ResolveOnboarding("official", "code", dev)
	if step != "backup" {
		t.Fatalf("bound with name: got %s", step)
	}

	path, step = ResolveOnboarding("diy", "diy-code", dev)
	if path != "diy" || step != "backup" {
		t.Fatalf("diy bound: got %s/%s", path, step)
	}
}

func TestResolveOnboardingNeedsCodeWhenUnbound(t *testing.T) {
	path, step := ResolveOnboarding("official", "domain", BoundDevice{})
	if path != "official" || step != "code" {
		t.Fatalf("unbound at domain: got %s/%s", path, step)
	}

	path, step = ResolveOnboarding("diy", "backup", BoundDevice{})
	if path != "diy" || step != "diy-code" {
		t.Fatalf("unbound at backup: got %s/%s", path, step)
	}
}

func TestResolveOnboardingPreservesDone(t *testing.T) {
	_, step := ResolveOnboarding("official", "done", BoundDevice{HasBound: true, ID: "dev_1"})
	if step != "done" {
		t.Fatalf("done: got %s", step)
	}
}
