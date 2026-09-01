package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
)

func providersChiRequest(method, path string, body []byte, urlParams map[string]string) *http.Request {
	var req *http.Request
	if body != nil {
		req = httptest.NewRequest(method, path, bytes.NewReader(body))
	} else {
		req = httptest.NewRequest(method, path, nil)
	}
	rctx := chi.NewRouteContext()
	for k, v := range urlParams {
		rctx.URLParams.Add(k, v)
	}
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
}

func TestAdminProvidersCRUD(t *testing.T) {
	d := testDeps(t)
	h := NewProvidersHandler(d.DB)

	body, _ := json.Marshal(map[string]any{
		"service": "backup",
		"name":    "B2",
		"credentials": map[string]string{
			"account_id":      "acc123",
			"application_key": "key456secret",
		},
		"settings": map[string]string{
			"bucket_prefix": "luna-backup",
		},
		"enabled": true,
	})
	req := httptest.NewRequest(http.MethodPost, "/admin/providers", bytes.NewReader(body))
	w := httptest.NewRecorder()
	h.CreateProvider(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("create status=%d: %s", w.Code, w.Body.String())
	}
	var created map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode create: %v", err)
	}
	id := created["id"].(string)
	creds := created["credentials"].(map[string]any)
	if creds["application_key"] == "key456secret" {
		t.Fatal("create must not echo full application_key")
	}
	has := created["has_credentials"].(map[string]any)
	if has["application_key"] != true {
		t.Fatalf("has_credentials: %+v", has)
	}

	req = httptest.NewRequest(http.MethodGet, "/admin/providers", nil)
	w = httptest.NewRecorder()
	h.ListProviders(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("list status=%d: %s", w.Code, w.Body.String())
	}
	var listResp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &listResp); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	list := listResp["providers"].([]any)
	if len(list) != 1 {
		t.Fatalf("list count=%d, want 1", len(list))
	}
	cfgStatus := listResp["config_status"].(map[string]any)
	backupStatus := cfgStatus["backup"].(map[string]any)
	if backupStatus["configured"] != true {
		t.Fatalf("backup status %+v", backupStatus)
	}
	cfStatus := cfgStatus["cloudflare"].(map[string]any)
	if cfStatus["configured"] != false {
		t.Fatalf("cloudflare status %+v", cfStatus)
	}

	body, _ = json.Marshal(map[string]any{
		"service": "backup",
		"name":    "B2 Updated",
		"credentials": map[string]string{
			"account_id":      "acc789",
			"application_key": "",
		},
		"settings": map[string]string{"bucket_prefix": "luna-backup"},
		"enabled":  false,
	})
	req = providersChiRequest(http.MethodPut, "/admin/providers/"+id, body, map[string]string{"id": id})
	w = httptest.NewRecorder()
	h.UpdateProvider(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("update status=%d: %s", w.Code, w.Body.String())
	}

	svc := providers.NewService(d.DB)
	got, err := svc.Get(id)
	if err != nil || got == nil {
		t.Fatalf("get after update: %v %#v", err, got)
	}
	if got.Credential("application_key", "") != "key456secret" {
		t.Fatalf("expected preserved secret, got %q", got.Credential("application_key", ""))
	}
	if got.Credential("account_id", "") != "acc789" {
		t.Fatalf("account_id=%q", got.Credential("account_id", ""))
	}
	if got.Enabled {
		t.Fatal("expected disabled")
	}

	req = providersChiRequest(http.MethodDelete, "/admin/providers/"+id, nil, map[string]string{"id": id})
	w = httptest.NewRecorder()
	h.DeleteProvider(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("delete status=%d: %s", w.Code, w.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/admin/providers", nil)
	w = httptest.NewRecorder()
	h.ListProviders(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("list after delete status=%d: %s", w.Code, w.Body.String())
	}
	_ = json.Unmarshal(w.Body.Bytes(), &listResp)
	finalProviders, ok := listResp["providers"].([]any)
	if !ok {
		t.Fatalf("expected providers array, got %v", listResp["providers"])
	}
	if len(finalProviders) != 0 {
		t.Fatalf("list after delete count=%d, want 0", len(finalProviders))
	}
}

func TestAdminProvidersStripeOverlay(t *testing.T) {
	d := testDeps(t)
	prev := config.C.Stripe
	t.Cleanup(func() {
		config.C.Stripe = prev
		providers.CaptureStripeBase()
	})
	config.C.Stripe = config.StripeConfig{Enabled: false, SecretKey: "sk_yaml", PublishableKey: "pk_yaml"}
	providers.CaptureStripeBase()

	h := NewProvidersHandler(d.DB)
	body, _ := json.Marshal(map[string]any{
		"service": "stripe",
		"name":    "Stripe",
		"credentials": map[string]string{
			"secret_key":     "sk_live_from_admin",
			"webhook_secret": "whsec_from_admin",
		},
		"settings": map[string]string{
			"publishable_key":         "pk_from_admin",
			"price_id":                "price_admin",
			"meter_event_name":        "luna_backup_gb",
			"egress_price_id":         "price_egress_admin",
			"egress_meter_event_name": "luna_backup_egress_gb",
		},
		"enabled": true,
	})
	req := httptest.NewRequest(http.MethodPost, "/admin/providers", bytes.NewReader(body))
	w := httptest.NewRecorder()
	h.CreateProvider(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("create status=%d: %s", w.Code, w.Body.String())
	}
	if config.C.Stripe.SecretKey != "sk_live_from_admin" {
		t.Fatalf("secret_key=%q", config.C.Stripe.SecretKey)
	}
	if config.C.Stripe.MeterEventName != "luna_backup_gb" {
		t.Fatalf("meter_event_name=%q", config.C.Stripe.MeterEventName)
	}
	if config.C.Stripe.EgressMeterEventName != "luna_backup_egress_gb" {
		t.Fatalf("egress_meter=%q", config.C.Stripe.EgressMeterEventName)
	}
	if !config.C.Stripe.Enabled {
		t.Fatal("expected stripe enabled")
	}

	var created map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &created)
	id := created["id"].(string)

	req = providersChiRequest(http.MethodDelete, "/admin/providers/"+id, nil, map[string]string{"id": id})
	w = httptest.NewRecorder()
	h.DeleteProvider(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("delete status=%d: %s", w.Code, w.Body.String())
	}
	if config.C.Stripe.SecretKey != "sk_yaml" {
		t.Fatalf("after delete expected yaml secret, got %q", config.C.Stripe.SecretKey)
	}
}
