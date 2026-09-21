package network

import (
	"context"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/handlers/testutil"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/jobqueue"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/network"
)

func TestNetworkHandlersCoverage(t *testing.T) {
	f := testutil.NewFixture(t)
	h := NewNetworkHandlers(f.Caddy, f.Manager)
	if h.WithACME(nil) != h {
		t.Fatal("WithACME should return receiver")
	}

	for _, tc := range []struct {
		name, method, target, body string
		params                     map[string]string
		fn                         http.HandlerFunc
		want                       int
	}{
		{"status", http.MethodGet, "/network/status", "", nil, h.GetCaddyStatus, 200},
		{"list", http.MethodGet, "/network/routes", "", nil, h.ListRoutes, 200},
		{"get missing", http.MethodGet, "/network/routes/x", "", nil, h.GetRoute, 400},
		{"get unknown", http.MethodGet, "/network/routes/x", "", map[string]string{"routeID": "x"}, h.GetRoute, 404},
		{"check bad", http.MethodPost, "/network/routes/check", "{", nil, h.CheckRouteAvailability, 400},
		{"check empty", http.MethodPost, "/network/routes/check", `{}`, nil, h.CheckRouteAvailability, 400},
		{"check", http.MethodPost, "/network/routes/check", `{"subdomain":"free"}`, nil, h.CheckRouteAvailability, 200},
		{"create bad", http.MethodPost, "/network/routes", "{", nil, h.CreateRoute, 400},
		{"create empty", http.MethodPost, "/network/routes", `{}`, nil, h.CreateRoute, 400},
		{"create no backend", http.MethodPost, "/network/routes", `{"subdomain":"demo"}`, nil, h.CreateRoute, 400},
		{"update missing", http.MethodPut, "/network/routes/x", `{}`, nil, h.UpdateRoute, 400},
		{"delete missing", http.MethodDelete, "/network/routes/x", "", nil, h.DeleteRoute, 400},
		{"caddyfile", http.MethodGet, "/network/caddyfile", "", nil, h.GetCaddyfile, 200},
		{"test bad", http.MethodPost, "/network/test", "{", nil, h.TestBackend, 400},
		{"test empty", http.MethodPost, "/network/test", `{}`, nil, h.TestBackend, 400},
		{"test unreachable", http.MethodPost, "/network/test", `{"backend":"127.0.0.1:1"}`, nil, h.TestBackend, 200},
		{"forwarding", http.MethodGet, "/network/forwarding", "", nil, h.GetPortForwardingStatus, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := testutil.CallHandler(t, tc.method, tc.target, tc.body, tc.params, tc.fn)
			if rec.Code != tc.want {
				t.Fatalf("got %d want %d: %s", rec.Code, tc.want, rec.Body.String())
			}
		})
	}

	rec := testutil.CallHandler(t, http.MethodPost, "/network/routes", `{"subdomain":"demo","backend":"http://127.0.0.1:19091","app_id":"installed"}`, nil, h.CreateRoute)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create route: %d %s", rec.Code, rec.Body.String())
	}
	var route network.Route
	if err := testutil.JSONDecode(rec.Body.Bytes(), &route); err != nil {
		t.Fatal(err)
	}

	rec = testutil.CallHandler(t, http.MethodGet, "/network/routes/"+route.ID, "", map[string]string{"routeID": route.ID}, h.GetRoute)
	if rec.Code != http.StatusOK {
		t.Fatalf("get route: %d", rec.Code)
	}
	rec = testutil.CallHandler(t, http.MethodPost, "/network/routes", `{"subdomain":"demo","backend":"http://127.0.0.1:19091"}`, nil, h.CreateRoute)
	if rec.Code != http.StatusConflict {
		t.Fatalf("duplicate route: %d", rec.Code)
	}
	rec = testutil.CallHandler(t, http.MethodPut, "/network/routes/"+route.ID, "{", map[string]string{"routeID": route.ID}, h.UpdateRoute)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bad update: %d", rec.Code)
	}
	rec = testutil.CallHandler(t, http.MethodPut, "/network/routes/"+route.ID, `{"backend":"http://127.0.0.1:19092","enabled":true}`, map[string]string{"routeID": route.ID}, h.UpdateRoute)
	if rec.Code != http.StatusOK {
		t.Fatalf("update route: %d %s", rec.Code, rec.Body.String())
	}
	rec = testutil.CallHandler(t, http.MethodDelete, "/network/routes/"+route.ID, "", map[string]string{"routeID": route.ID}, h.DeleteRoute)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete route: %d %s", rec.Code, rec.Body.String())
	}

	nilHandler := NewNetworkHandlers(nil, nil)
	rec = testutil.CallHandler(t, http.MethodPost, "/network/disconnect", "", nil, nilHandler.DisconnectDomain)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("nil disconnect: %d", rec.Code)
	}
	rec = testutil.CallHandler(t, http.MethodPost, "/network/disconnect", "", nil, h.DisconnectDomain)
	if rec.Code != http.StatusOK {
		t.Fatalf("disconnect: %d %s", rec.Code, rec.Body.String())
	}
}

func TestACMEHandlerCoverage(t *testing.T) {
	f := testutil.NewFixture(t)
	manager := network.NewACMEManager("", filepath.Join(t.TempDir(), "Caddyfile"))
	h := NewACMEHandler(f.DB, manager, nil, f.Manager)
	if h.WithJobQueue(&testutil.JobQueue{Job: &jobqueue.Job{ID: "queued", Status: jobqueue.JobStatusQueued}}) != h {
		t.Fatal("WithJobQueue should return receiver")
	}

	for _, tc := range []struct {
		name, method, target, body string
		params                     map[string]string
		fn                         http.HandlerFunc
		want                       int
	}{
		{"dns invalid", http.MethodPost, "/acme/dns", `{}`, nil, h.ProbeDNS, 400},
		{"dns localhost", http.MethodPost, "/acme/dns", `{"host":"localhost"}`, nil, h.ProbeDNS, 200},
		{"ports invalid", http.MethodPost, "/acme/ports", `{}`, nil, h.ProbePorts, 400},
		{"ports", http.MethodPost, "/acme/ports", `{"host":"127.0.0.1","ports":[1,2]}`, nil, h.ProbePorts, 200},
		{"request invalid", http.MethodPost, "/acme/request", `{}`, nil, h.RequestCert, 400},
		{"request no email", http.MethodPost, "/acme/request", `{"domain":"cert.example.test"}`, nil, h.RequestCert, 400},
		{"request queued", http.MethodPost, "/acme/request", `{"domain":"cert.example.test","email":"admin@example.test"}`, nil, h.RequestCert, 202},
		{"get missing id", http.MethodGet, "/acme/jobs/x", "", nil, h.GetJob, 400},
		{"get unknown", http.MethodGet, "/acme/jobs/x", "", map[string]string{"jobID": "x"}, h.GetJob, 404},
		{"status missing domain", http.MethodGet, "/acme/status", "", nil, h.GetStatus, 400},
		{"status unknown", http.MethodGet, "/acme/status?domain=none.example.test", "", nil, h.GetStatus, 404},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := testutil.CallHandler(t, tc.method, tc.target, tc.body, tc.params, tc.fn)
			if rec.Code != tc.want {
				t.Fatalf("got %d want %d: %s", rec.Code, tc.want, rec.Body.String())
			}
		})
	}

	job, err := network.CreateACMEJob(context.Background(), f.DB, "stored.example.test", "admin@example.test", "")
	if err != nil {
		t.Fatal(err)
	}
	rec := testutil.CallHandler(t, http.MethodGet, "/acme/jobs/"+job.ID, "", map[string]string{"jobID": job.ID}, h.GetJob)
	if rec.Code != 200 {
		t.Fatalf("get stored: %d %s", rec.Code, rec.Body.String())
	}
	rec = testutil.CallHandler(t, http.MethodGet, "/acme/status?domain=stored.example.test", "", nil, h.GetStatus)
	if rec.Code != 200 {
		t.Fatalf("stored status: %d %s", rec.Code, rec.Body.String())
	}

	nilHandler := NewACMEHandler(nil, nil, nil, nil)
	for _, fn := range []http.HandlerFunc{nilHandler.GetJob, nilHandler.GetStatus} {
		rec = testutil.CallHandler(t, http.MethodGet, "/", "", nil, fn)
		if rec.Code != 500 {
			t.Fatalf("nil database: %d", rec.Code)
		}
	}
	if _, err := nilHandler.EnqueueIssue(context.Background(), "x.test", "a@b.test"); err == nil {
		t.Fatal("expected missing manager error")
	}
	nilHandler.manager = manager
	if _, err := nilHandler.EnqueueIssue(context.Background(), "x.test", "a@b.test"); err == nil {
		t.Fatal("expected missing database error")
	}
}

func TestConnectivityAndTunnelCoverage(t *testing.T) {
	f := testutil.NewFixture(t)

	connectivity := NewConnectivityHandler(nil, f.Manager, f.Caddy)
	for _, tc := range []struct {
		resp ConnectivityResponse
		want string
	}{
		{ConnectivityResponse{Domain: DomainStatus{Configured: true, HTTPS: true}}, "active"},
		{ConnectivityResponse{Tunnel: TunnelStatusSimple{Enabled: true}}, "active"},
		{ConnectivityResponse{NATType: "cgnat"}, "blocked"},
		{ConnectivityResponse{NATType: "symmetric"}, "blocked"},
		{ConnectivityResponse{NATType: "blocked"}, "blocked"},
		{ConnectivityResponse{NATType: "open"}, "local_only"},
		{ConnectivityResponse{NATType: "unknown"}, "local_only"},
	} {
		if got := connectivity.deriveRemoteAccess(tc.resp); got != tc.want {
			t.Fatalf("derive %q: got %q want %q", tc.resp.NATType, got, tc.want)
		}
		tc.resp.RemoteAccess = tc.want
		_ = connectivity.generateSuggestions(tc.resp)
	}
	rec := testutil.CallHandler(t, http.MethodGet, "/connectivity", "", nil, connectivity.GetStatus)
	if rec.Code != 200 {
		t.Fatalf("connectivity status: %d %s", rec.Code, rec.Body.String())
	}

	tunnelService := network.NewTunnelService(network.TunnelConfig{}, t.TempDir())
	tunnel := NewTunnelHandler(tunnelService, nil, nil)
	rec = testutil.CallHandler(t, http.MethodGet, "/tunnel", "", nil, tunnel.GetStatus)
	if rec.Code != 200 {
		t.Fatalf("tunnel status: %d", rec.Code)
	}
	for _, body := range []string{"{", `{}`} {
		rec = testutil.CallHandler(t, http.MethodPost, "/tunnel/enable", body, nil, tunnel.Enable)
		if rec.Code != 400 {
			t.Fatalf("invalid tunnel %q: %d", body, rec.Code)
		}
	}
	rec = testutil.CallHandler(t, http.MethodPost, "/tunnel/disable", "", nil, tunnel.Disable)
	if rec.Code != 200 {
		t.Fatalf("disable tunnel: %d %s", rec.Code, rec.Body.String())
	}
	rec = testutil.CallHandler(t, http.MethodPost, "/tunnel/delete", "", nil, tunnel.Delete)
	if rec.Code != 200 {
		t.Fatalf("delete tunnel: %d %s", rec.Code, rec.Body.String())
	}
}

func TestDDNSAndACMEHelpersCoverage(t *testing.T) {
	f := testutil.NewFixture(t)

	ddnsService := network.NewDDNSService(f.DB, network.NewDNSProviderManager(f.DB), nil)
	ddns := NewDDNSHandler(ddnsService)
	rec := testutil.CallHandler(t, http.MethodGet, "/ddns", "", nil, ddns.GetStatus)
	if rec.Code != 200 {
		t.Fatalf("ddns status: %d", rec.Code)
	}
	for _, body := range []string{"{", `{"interval_minutes":0}`, `{"interval_minutes":61}`, `{"interval_minutes":5}`} {
		rec = testutil.CallHandler(t, http.MethodPut, "/ddns", body, nil, ddns.SetInterval)
		want := 400
		if strings.Contains(body, ":5") {
			want = 200
		}
		if rec.Code != want {
			t.Fatalf("ddns interval %q: %d", body, rec.Code)
		}
	}

	acme := NewACMEHandler(f.DB, nil, f.Caddy, f.Manager)
	acme.appBackends["mapped"] = "http://127.0.0.1:1234"
	f.Manager.RegisterNamedBackend("named", "api", "http://127.0.0.1:2345")
	for _, request := range []network.ACMERequest{
		{Backend: "http://explicit"},
		{AppID: "mapped"},
		{AppID: "named", BackendName: "api"},
		{Domain: "unknown.example.test"},
	} {
		if acme.resolveBackend(request) == "" {
			t.Fatal("ACME backend should resolve")
		}
	}
	cleanup := NewACMECleanupHandler(nil)
	rec = testutil.CallHandler(t, http.MethodDelete, "/routes/x", "", nil, cleanup.DeleteRoute)
	if rec.Code != 500 {
		t.Fatalf("nil ACME cleanup: %d", rec.Code)
	}
}
