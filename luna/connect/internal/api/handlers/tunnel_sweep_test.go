package handlers

import (
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
)

func TestOrphanTunnelsKeepsOwnedSiteAndFreshTunnels(t *testing.T) {
	now := time.Now()
	old := now.Add(-48 * time.Hour)
	all := []providers.TunnelInfo{
		{ID: "site", Name: "luna-connect", CreatedAt: old},
		{ID: "mine", Name: "luna-max-957885a8", CreatedAt: old},
		{ID: "orphan", Name: "luna-max", CreatedAt: old},
		{ID: "fresh", Name: "luna-new-12345678", CreatedAt: now.Add(-5 * time.Minute)},
		{ID: "other", Name: "someone-elses-tunnel", CreatedAt: old},
		{ID: "undated", Name: "luna-x", CreatedAt: time.Time{}},
	}
	got := orphanTunnels(all, map[string]bool{"mine": true}, now)
	if len(got) != 1 || got[0].ID != "orphan" {
		t.Fatalf("want only the unowned old luna-* tunnel, got %+v", got)
	}
}
