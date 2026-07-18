package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/providers"
)

func TestAdminProvidersCRUD(t *testing.T) {
	db := database.OpenTestDB(t)
	svc := providers.NewService(db)
	h := NewProvidersHandler(svc)

	// Create
	body, _ := json.Marshal(map[string]any{
		"service": "backup",
		"name":    "B2",
		"credentials": map[string]string{
			"account_id":      "acc123",
			"application_key": "key456",
		},
		"settings": map[string]string{
			"bucket_prefix": "libreserv-backup",
		},
		"enabled": true,
	})
	req := httptest.NewRequest(http.MethodPost, "/api/admin/providers", bytes.NewReader(body))
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

	// List
	req = httptest.NewRequest(http.MethodGet, "/api/admin/providers", nil)
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

	// Update
	body, _ = json.Marshal(map[string]any{
		"service": "backup",
		"name":    "B2 Updated",
		"credentials": map[string]string{
			"account_id": "acc789",
		},
		"settings": map[string]string{},
		"enabled":  false,
	})
	req = chiRequest(http.MethodPut, "/api/admin/providers/"+id, body, map[string]string{"id": id})
	w = httptest.NewRecorder()
	h.UpdateProvider(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("update status=%d: %s", w.Code, w.Body.String())
	}

	// Delete
	req = chiRequest(http.MethodDelete, "/api/admin/providers/"+id, nil, map[string]string{"id": id})
	w = httptest.NewRecorder()
	h.DeleteProvider(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("delete status=%d: %s", w.Code, w.Body.String())
	}

	// List should be empty now
	req = httptest.NewRequest(http.MethodGet, "/api/admin/providers", nil)
	w = httptest.NewRecorder()
	h.ListProviders(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("list after delete status=%d: %s", w.Code, w.Body.String())
	}
	var finalListResp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &finalListResp); err != nil {
		t.Fatalf("decode list after delete: %v", err)
	}
	finalProviders, ok := finalListResp["providers"].([]any)
	if !ok {
		t.Fatalf("expected providers array, got %v (body: %s)", finalListResp["providers"], w.Body.String())
	}
	if len(finalProviders) != 0 {
		t.Fatalf("list after delete count=%d, want 0", len(finalProviders))
	}
}
