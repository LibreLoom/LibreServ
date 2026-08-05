package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestBuildFRPExport(t *testing.T) {
	cfg := buildFRPExport(exportRequest{
		Server: "relay.example.com:7000",
		Token:  "secret",
		Ports:  []int{25565, 8080},
	})
	for _, want := range []string{
		`serverAddr = "relay.example.com:7000"`,
		`auth.token = "secret"`,
		`name = "libreserv-25565"`,
		`localPort = 25565`,
		`remotePort = 8080`,
	} {
		if !strings.Contains(cfg, want) {
			t.Errorf("frp export missing %q\n%s", want, cfg)
		}
	}
}

func TestBuildWireGuardExport(t *testing.T) {
	cfg := buildWireGuardExport(exportRequest{Ports: []int{25565}})
	if !strings.Contains(cfg, "[Interface]") || !strings.Contains(cfg, "[Peer]") {
		t.Errorf("wg export malformed:\n%s", cfg)
	}
	if !strings.Contains(cfg, "Forwarded ports: 25565") {
		t.Errorf("wg export missing forwarded ports:\n%s", cfg)
	}
}

func TestExportConfigHandler(t *testing.T) {
	h := NewMappingHandler(nil)

	t.Run("frp export returns config", func(t *testing.T) {
		body, _ := json.Marshal(exportRequest{Type: "frp", Server: "relay.example.com:7000", Ports: []int{25565}})
		req := httptest.NewRequest(http.MethodPost, "/api/v1/network/export/config", bytes.NewReader(body))
		w := httptest.NewRecorder()
		h.ExportConfig(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", w.Code)
		}
		var resp map[string]string
		if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if resp["type"] != "frp" || !strings.Contains(resp["config"], "serverAddr") {
			t.Errorf("resp = %+v", resp)
		}
	})

	t.Run("frp export requires server", func(t *testing.T) {
		body, _ := json.Marshal(exportRequest{Type: "frp"})
		req := httptest.NewRequest(http.MethodPost, "/api/v1/network/export/config", bytes.NewReader(body))
		w := httptest.NewRecorder()
		h.ExportConfig(w, req)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", w.Code)
		}
	})

	t.Run("unknown type rejected", func(t *testing.T) {
		body, _ := json.Marshal(exportRequest{Type: "tailscale"})
		req := httptest.NewRequest(http.MethodPost, "/api/v1/network/export/config", bytes.NewReader(body))
		w := httptest.NewRecorder()
		h.ExportConfig(w, req)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", w.Code)
		}
	})
}

func TestCreateMappingValidation(t *testing.T) {
	h := NewMappingHandler(nil)

	tests := []struct {
		name string
		body string
		want int
	}{
		{"port out of range", `{"protocol":"tcp","external_port":0,"internal_port":8080}`, http.StatusBadRequest},
		{"bad protocol", `{"protocol":"sctp","external_port":8080,"internal_port":8080}`, http.StatusBadRequest},
		{"valid payload accepted (router present → 201, else 503)", `{"protocol":"tcp","external_port":8080,"internal_port":8080}`, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/v1/network/mappings", bytes.NewReader([]byte(tt.body)))
			w := httptest.NewRecorder()
			h.CreateMapping(w, req)
			if tt.want != 0 && w.Code != tt.want {
				t.Errorf("status = %d, want %d (body=%s)", w.Code, tt.want, w.Body.String())
			}
			// Environment-dependent case: 201 (router with UPnP) or 503 (none).
			if tt.want == 0 && w.Code != http.StatusCreated && w.Code != http.StatusServiceUnavailable {
				t.Errorf("status = %d, want 201 or 503 (body=%s)", w.Code, w.Body.String())
			}
		})
	}
}
