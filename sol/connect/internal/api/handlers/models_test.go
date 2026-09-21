package handlers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/models"
)

func httptestResponseRecorder(fn func(http.ResponseWriter, *http.Request), req *http.Request) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	fn(w, req)
	return w
}

func TestModelsHandlerLifecycle(t *testing.T) {
	db := database.OpenTestDB(t)
	h := NewModelsHandler(models.NewService(db))

	invalid := portalRequest(t, nil, "", http.MethodPost, "/admin/models/providers", `{}`, h.CreateProvider)
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid provider = %d", invalid.Code)
	}
	created := portalRequest(t, nil, "", http.MethodPost, "/admin/models/providers",
		`{"name":"Test AI","base_url":"https://ai.example/v1","api_key":"key","enabled":true}`, h.CreateProvider)
	if created.Code != http.StatusOK {
		t.Fatalf("create provider = %d: %s", created.Code, created.Body.String())
	}
	var providerID string
	if err := db.QueryRow(`SELECT id FROM ai_providers WHERE name = 'Test AI'`).Scan(&providerID); err != nil {
		t.Fatal(err)
	}
	listProviders := portalRequest(t, nil, "", http.MethodGet, "/admin/models/providers", "", h.ListProviders)
	if listProviders.Code != http.StatusOK || !strings.Contains(listProviders.Body.String(), "Test AI") {
		t.Fatalf("list providers = %d: %s", listProviders.Code, listProviders.Body.String())
	}

	modelBody := `{"provider_id":"` + providerID + `","model_id":"test-model","display_name":"Test Model","enabled":true}`
	modelCreated := portalRequest(t, nil, "", http.MethodPost, "/admin/models", modelBody, h.CreateModel)
	if modelCreated.Code != http.StatusOK {
		t.Fatalf("create model = %d: %s", modelCreated.Code, modelCreated.Body.String())
	}
	var modelID string
	if err := db.QueryRow(`SELECT id FROM ai_models WHERE model_id = 'test-model'`).Scan(&modelID); err != nil {
		t.Fatal(err)
	}
	listModels := portalRequest(t, nil, "", http.MethodGet, "/admin/models?role=agent", "", h.ListModels)
	if listModels.Code != http.StatusOK || !strings.Contains(listModels.Body.String(), "test-model") {
		t.Fatalf("list models = %d: %s", listModels.Code, listModels.Body.String())
	}
	fallbackReq := chiRequest(http.MethodGet, "/admin/models/fallback/agent?tier=free", nil, map[string]string{"role": "agent"})
	fallbackW := httptestResponseRecorder(h.GetFallbackChain, fallbackReq)
	if fallbackW.Code != http.StatusOK {
		t.Fatalf("fallback chain = %d: %s", fallbackW.Code, fallbackW.Body.String())
	}

	updateModelReq := chiRequest(http.MethodPut, "/admin/models/"+modelID,
		[]byte(`{"model_id":"updated-model","display_name":"Updated","role":"review","enabled":true}`),
		map[string]string{"id": modelID})
	updateModelW := httptestResponseRecorder(h.UpdateModel, updateModelReq)
	if updateModelW.Code != http.StatusOK {
		t.Fatalf("update model = %d: %s", updateModelW.Code, updateModelW.Body.String())
	}
	updateProviderReq := chiRequest(http.MethodPut, "/admin/models/providers/"+providerID,
		[]byte(`{"name":"Updated AI","base_url":"https://new.example/v1","api_key":"new","tier":"paid","enabled":true}`),
		map[string]string{"id": providerID})
	updateProviderW := httptestResponseRecorder(h.UpdateProvider, updateProviderReq)
	if updateProviderW.Code != http.StatusOK {
		t.Fatalf("update provider = %d: %s", updateProviderW.Code, updateProviderW.Body.String())
	}

	deleteModelReq := chiRequest(http.MethodDelete, "/admin/models/"+modelID, nil, map[string]string{"id": modelID})
	if w := httptestResponseRecorder(h.DeleteModel, deleteModelReq); w.Code != http.StatusOK {
		t.Fatalf("delete model = %d: %s", w.Code, w.Body.String())
	}
	deleteProviderReq := chiRequest(http.MethodDelete, "/admin/models/providers/"+providerID, nil, map[string]string{"id": providerID})
	if w := httptestResponseRecorder(h.DeleteProvider, deleteProviderReq); w.Code != http.StatusOK {
		t.Fatalf("delete provider = %d: %s", w.Code, w.Body.String())
	}
}

func TestModelsHandlerValidation(t *testing.T) {
	h := NewModelsHandler(models.NewService(database.OpenTestDB(t)))
	if w := portalRequest(t, nil, "", http.MethodPost, "/admin/models", `{}`, h.CreateModel); w.Code != http.StatusBadRequest {
		t.Fatalf("invalid model = %d", w.Code)
	}
}
