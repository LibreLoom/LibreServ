package app

import (
	"context"
	"testing"
)

func TestOverviewAndBumpPreviews(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	rs := w.app.RepoStatus(ctx)
	if rs.Err != "" || rs.Branch != "main" || !rs.Clean || len(rs.SHA) != 7 {
		t.Fatalf("%+v", rs)
	}
	var fake *UnitStatus
	for _, u := range w.app.UnitStatuses(ctx) {
		if u.Unit == "fake" {
			u := u
			fake = &u
		}
	}
	if fake == nil || fake.Version != "0.3.0" || fake.LastTag != "" || fake.Since != 1 {
		t.Fatalf("%+v", fake)
	}
	got := map[string]BumpPreview{}
	for _, p := range w.app.BumpPreviews("fake", "stable") {
		got[p.Kind] = p
	}
	if got["patch"].Version != "0.3.1" || got["minor"].Version != "0.4.0" || got["beta"].Err == "" {
		t.Fatalf("%+v", got)
	}
	beta := map[string]BumpPreview{}
	for _, p := range w.app.BumpPreviews("fake", "beta") {
		beta[p.Kind] = p
	}
	if beta["beta"].Version != "0.3.1-beta.1" || beta["patch"].Err == "" {
		t.Fatalf("%+v", beta)
	}
	heads := w.app.FeedHeads(ctx, "fake")
	if len(heads) != 2 || heads[0].Channel != "stable" || !heads[0].Missing || !heads[1].Missing {
		t.Fatalf("%+v", heads)
	}
}

func TestAndroidVersionCodeHelper(t *testing.T) {
	if c, err := AndroidVersionCode("0.4.1-beta.2"); err != nil || c != 40102 {
		t.Fatalf("%d %v", c, err)
	}
}
