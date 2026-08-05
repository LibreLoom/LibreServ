package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/network"
)

func TestReportHandlerGetReport(t *testing.T) {
	svc := network.NewReportService(nil, nil, nil, nil)
	svc.SetReport(&network.NetworkReport{
		Headline: "Your apps are reachable from the internet.",
	})
	h := NewReportHandler(svc)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/network/report", nil)
	w := httptest.NewRecorder()
	h.GetReport(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	var body struct {
		Headline string `json:"headline"`
	}
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Headline != "Your apps are reachable from the internet." {
		t.Errorf("headline = %q", body.Headline)
	}
}

func TestReportHandlerNoReport(t *testing.T) {
	svc := network.NewReportService(nil, nil, nil, nil)
	h := NewReportHandler(svc)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/network/report", nil)
	w := httptest.NewRecorder()
	h.GetReport(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", w.Code)
	}
}
