package network

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestTailscalePublicServingRequiresExplicitConfirmation(t *testing.T) {
	h := NewTailscaleHandler(nil)
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"public":true}`))
	rec := httptest.NewRecorder()
	h.Serve(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
}
