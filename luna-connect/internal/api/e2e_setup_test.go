//go:build integration

package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
)

// recordingCloud tracks Cloudflare API calls for E2E assertions.
type recordingCloud struct {
	creates    []string
	deletes    []string
	dnsUpserts []string
	dnsDeletes []string
}

func (c *recordingCloud) CreateTunnel(_, _, name string) (*providers.TunnelCredentials, error) {
	c.creates = append(c.creates, name)
	return &providers.TunnelCredentials{TunnelID: "tun-" + name, Token: "mock-token-" + name}, nil
}

func (c *recordingCloud) ConfigureIngress(_, _, _, _, _ string) error { return nil }

func (c *recordingCloud) DeleteTunnel(_, _, tunnelID string) error {
	c.deletes = append(c.deletes, tunnelID)
	return nil
}

func (c *recordingCloud) UpsertCNAME(_, _, hostname, _ string) error {
	c.dnsUpserts = append(c.dnsUpserts, hostname)
	return nil
}

func (c *recordingCloud) DeleteRecord(_, _, hostname string) error {
	c.dnsDeletes = append(c.dnsDeletes, hostname)
	return nil
}

func csrfPOST(t *testing.T, h http.Handler, path, body string, cookies ...*http.Cookie) (*httptest.ResponseRecorder, []*http.Cookie) {
	t.Helper()
	get := httptest.NewRequest(http.MethodGet, "/api/v1/config", nil)
	grec := httptest.NewRecorder()
	h.ServeHTTP(grec, get)
	var csrf string
	allCookies := grec.Result().Cookies()
	for _, c := range allCookies {
		if c.Name == "luna_connect_csrf" {
			csrf = c.Value
		}
	}
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CSRF-Token", csrf)
	for _, c := range allCookies {
		req.AddCookie(c)
	}
	for _, c := range cookies {
		req.AddCookie(c)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec, append(allCookies, rec.Result().Cookies()...)
}

func startE2EServer(t *testing.T) (http.Handler, *recordingCloud, string) {
	t.Helper()
	t.Setenv("LUNACONNECT_DEV", "1")
	config.C.Server.PublicZone = "luna.servers.libreloom.org"
	config.C.Server.BaseURL = "http://127.0.0.1:8092"
	config.C.Server.AdminToken = "e2e-admin-token"

	cloud := &recordingCloud{}
	h := testServerWithProviders(t, cloud, cloud)

	mintReq := httptest.NewRequest(http.MethodPost, "/admin/setup-tokens", nil)
	mintReq.Header.Set("Authorization", "Bearer e2e-admin-token")
	mintRec := httptest.NewRecorder()
	h.ServeHTTP(mintRec, mintReq)
	if mintRec.Code != http.StatusCreated {
		t.Fatalf("mint: %d %s", mintRec.Code, mintRec.Body.String())
	}
	var mintOut map[string]any
	_ = json.Unmarshal(mintRec.Body.Bytes(), &mintOut)
	return h, cloud, mintOut["token"].(string)
}

func wsHello(t *testing.T, srvURL, token string) *websocket.Conn {
	t.Helper()
	wsURL := "ws" + strings.TrimPrefix(srvURL, "http") + "/api/v1/setup/ws"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}
	if err := conn.WriteJSON(map[string]any{
		"type": "hello", "token": token, "local_port": 8090, "source": "anonymous",
	}); err != nil {
		t.Fatalf("ws hello: %v", err)
	}
	return conn
}

func readWSType(t *testing.T, conn *websocket.Conn, want string) map[string]any {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	var msg map[string]any
	if err := conn.ReadJSON(&msg); err != nil {
		t.Fatalf("read %s: %v", want, err)
	}
	if msg["type"] != want {
		t.Fatalf("got type %v want %s", msg["type"], want)
	}
	return msg
}

// TestE2EOfficialSetupFlow exercises the full official-unit path:
// admin mint → device WebSocket hello → website bind → name → Cloudflare mock → claimed.
func TestE2EOfficialSetupFlow(t *testing.T) {
	h, cloud, token := startE2EServer(t)
	srv := httptest.NewServer(h)
	defer srv.Close()

	regRec, acctCookies := csrfPOST(t, h, "/api/v1/account/register",
		`{"email":"e2e-official@test.luna","password":"password1234"}`)
	if regRec.Code != http.StatusCreated {
		t.Fatalf("register: %d %s", regRec.Code, regRec.Body.String())
	}

	bindRec, bindCookies := csrfPOST(t, h, "/api/v1/onboarding/bind",
		`{"code":"`+token+`"}`, acctCookies...)
	if bindRec.Code != http.StatusOK {
		t.Fatalf("bind: %d %s", bindRec.Code, bindRec.Body.String())
	}
	var bindBody map[string]any
	_ = json.Unmarshal(bindRec.Body.Bytes(), &bindBody)
	if bindBody["status"] != "waiting_device" {
		t.Fatalf("expected waiting_device, got %v", bindBody["status"])
	}

	conn := wsHello(t, srv.URL, token)
	defer conn.Close()
	readWSType(t, conn, "accepted")
	readWSType(t, conn, "attached")

	nameRec, _ := csrfPOST(t, h, "/api/v1/onboarding/name",
		`{"subdomain":"e2e-test"}`, append(acctCookies, bindCookies...)...)
	if nameRec.Code != http.StatusCreated {
		t.Fatalf("name: %d %s", nameRec.Code, nameRec.Body.String())
	}
	var nameBody map[string]any
	_ = json.Unmarshal(nameRec.Body.Bytes(), &nameBody)
	wantHost := "e2e-test.luna.servers.libreloom.org"
	if nameBody["hostname"] != wantHost {
		t.Fatalf("hostname: got %v want %s", nameBody["hostname"], wantHost)
	}

	claimed := readWSType(t, conn, "claimed")
	if claimed["hostname"] != wantHost || claimed["tunnel_token"] == "" || claimed["device_token"] == "" {
		t.Fatalf("claimed incomplete: %v", claimed)
	}
	if claimed["setup_secret"] != nameBody["setup_secret"] {
		t.Fatalf("setup_secret mismatch")
	}

	wantTun := "luna-e2e-test"
	if len(cloud.creates) != 1 || cloud.creates[0] != wantTun {
		t.Fatalf("tunnel creates: %v want [%s]", cloud.creates, wantTun)
	}
	if len(cloud.dnsUpserts) != 1 || cloud.dnsUpserts[0] != wantHost {
		t.Fatalf("dns upserts: %v want [%s]", cloud.dnsUpserts, wantHost)
	}
	if len(cloud.deletes) != 0 {
		t.Fatalf("unexpected rollbacks: %v", cloud.deletes)
	}

	deviceToken := claimed["device_token"].(string)
	statusReq := httptest.NewRequest(http.MethodGet, "/api/v1/status", nil)
	statusReq.Header.Set("Authorization", "Bearer "+deviceToken)
	statusRec := httptest.NewRecorder()
	h.ServeHTTP(statusRec, statusReq)
	if statusRec.Code != http.StatusOK {
		t.Fatalf("status: %d %s", statusRec.Code, statusRec.Body.String())
	}

	t.Logf("E2E official flow OK: hostname=%s tunnel=%s", wantHost, cloud.creates[0])
}

// TestE2EOSSSetupFlow exercises the self-built path.
func TestE2EOSSSetupFlow(t *testing.T) {
	h, cloud, _ := startE2EServer(t)
	srv := httptest.NewServer(h)
	defer srv.Close()

	regRec, acctCookies := csrfPOST(t, h, "/api/v1/account/register",
		`{"email":"e2e-oss@test.luna","password":"password1234"}`)
	if regRec.Code != http.StatusCreated {
		t.Fatalf("register: %d %s", regRec.Code, regRec.Body.String())
	}

	verifyRec, _ := csrfPOST(t, h, "/api/v1/account/verify-human", `{}`, acctCookies...)
	if verifyRec.Code != http.StatusOK {
		t.Fatalf("verify-human: %d %s", verifyRec.Code, verifyRec.Body.String())
	}

	mintRec, _ := csrfPOST(t, h, "/api/v1/account/oss-token", `{}`, acctCookies...)
	if mintRec.Code != http.StatusCreated {
		t.Fatalf("oss-token: %d %s", mintRec.Code, mintRec.Body.String())
	}
	var mintBody map[string]any
	_ = json.Unmarshal(mintRec.Body.Bytes(), &mintBody)
	code := mintBody["code"].(string)

	bindRec, bindCookies := csrfPOST(t, h, "/api/v1/onboarding/bind",
		`{"code":"`+code+`"}`, acctCookies...)
	if bindRec.Code != http.StatusOK {
		t.Fatalf("bind: %d %s", bindRec.Code, bindRec.Body.String())
	}

	conn := wsHello(t, srv.URL, code)
	defer conn.Close()
	readWSType(t, conn, "accepted")
	readWSType(t, conn, "attached")

	nameRec, _ := csrfPOST(t, h, "/api/v1/onboarding/name",
		`{"subdomain":"oss-e2e"}`, append(acctCookies, bindCookies...)...)
	if nameRec.Code != http.StatusCreated {
		t.Fatalf("name: %d %s", nameRec.Code, nameRec.Body.String())
	}

	claimed := readWSType(t, conn, "claimed")
	wantHost := "oss-e2e.luna.servers.libreloom.org"
	if claimed["hostname"] != wantHost {
		t.Fatalf("claimed hostname: %v", claimed["hostname"])
	}
	if len(cloud.creates) != 1 || cloud.creates[0] != "luna-oss-e2e" {
		t.Fatalf("tunnel creates: %v", cloud.creates)
	}

	t.Logf("E2E OSS flow OK: hostname=%s", wantHost)
}
