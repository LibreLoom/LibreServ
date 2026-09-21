package monitoring

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	rt "gt.plainskill.net/LibreLoom/LibreServ/internal/runtime"
)

func TestHTTPCheck_Run_Healthy(t *testing.T) {
	var gotMethod, gotHeader string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotHeader = r.Header.Get("X-Token")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	check := NewHTTPCheck(HTTPCheckConfig{
		URL:     srv.URL,
		Headers: map[string]string{"X-Token": "secret"},
	}, time.Second)

	res := check.Run(context.Background())
	if res.Status != HealthStatusHealthy {
		t.Fatalf("status = %q, want healthy (%s)", res.Status, res.Message)
	}
	if res.CheckType != "http" {
		t.Errorf("check type = %q, want http", res.CheckType)
	}
	if gotMethod != http.MethodGet {
		t.Errorf("request method = %q, want GET (the default)", gotMethod)
	}
	if gotHeader != "secret" {
		t.Errorf("X-Token header = %q, want secret", gotHeader)
	}
}

func TestHTTPCheck_Run_ExpectedStatusMismatch(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	check := NewHTTPCheck(HTTPCheckConfig{URL: srv.URL}, time.Second)
	res := check.Run(context.Background())

	if res.Status != HealthStatusUnhealthy {
		t.Fatalf("status = %q, want unhealthy", res.Status)
	}
	if !strings.Contains(res.Message, "500") {
		t.Errorf("message = %q, want it to mention the received status", res.Message)
	}
}

func TestHTTPCheck_Run_CustomMethodAndExpectedStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodHead {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	check := NewHTTPCheck(HTTPCheckConfig{
		URL:            srv.URL,
		Method:         http.MethodHead,
		ExpectedStatus: http.StatusNoContent,
	}, time.Second)

	res := check.Run(context.Background())
	if res.Status != HealthStatusHealthy {
		t.Fatalf("status = %q, want healthy (%s)", res.Status, res.Message)
	}
}

func TestHTTPCheck_Run_UnreachableURL(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := srv.URL
	srv.Close()

	check := NewHTTPCheck(HTTPCheckConfig{URL: url}, 500*time.Millisecond)
	res := check.Run(context.Background())

	if res.Status != HealthStatusUnhealthy {
		t.Fatalf("status = %q, want unhealthy", res.Status)
	}
}

func TestHTTPCheck_Run_InvalidURL(t *testing.T) {
	check := NewHTTPCheck(HTTPCheckConfig{URL: "http://\x7f"}, time.Second)
	res := check.Run(context.Background())

	if res.Status != HealthStatusUnhealthy {
		t.Fatalf("status = %q, want unhealthy", res.Status)
	}
	if !strings.Contains(res.Message, "Failed to create request") {
		t.Errorf("message = %q, want a request-construction failure", res.Message)
	}
}

func TestTCPCheck_Run(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	host, portStr, err := net.SplitHostPort(ln.Addr().String())
	if err != nil {
		t.Fatalf("split addr: %v", err)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		t.Fatalf("parse port: %v", err)
	}

	check := NewTCPCheck(TCPCheckConfig{Host: host, Port: port}, time.Second)
	res := check.Run(context.Background())
	if res.Status != HealthStatusHealthy {
		t.Fatalf("status = %q, want healthy (%s)", res.Status, res.Message)
	}
	if res.CheckType != "tcp" {
		t.Errorf("check type = %q, want tcp", res.CheckType)
	}

	ln.Close()
	res = check.Run(context.Background())
	if res.Status != HealthStatusUnhealthy {
		t.Fatalf("status after listener close = %q, want unhealthy", res.Status)
	}
}

// staticCheck is a Check whose result is fixed, for exercising CompositeCheck aggregation.
type staticCheck struct {
	kind   string
	status HealthStatus
}

func (s staticCheck) Type() string { return s.kind }

func (s staticCheck) Run(context.Context) CheckResult {
	return CheckResult{Status: s.status, CheckType: s.kind, Message: string(s.status)}
}

func TestCompositeCheck_Run_Aggregation(t *testing.T) {
	tests := []struct {
		name   string
		checks []Check
		want   HealthStatus
	}{
		{"no checks", nil, HealthStatusUnknown},
		{
			"all healthy",
			[]Check{staticCheck{"http", HealthStatusHealthy}, staticCheck{"tcp", HealthStatusHealthy}},
			HealthStatusHealthy,
		},
		{
			"any unhealthy wins",
			[]Check{staticCheck{"http", HealthStatusHealthy}, staticCheck{"tcp", HealthStatusUnhealthy}, staticCheck{"container", HealthStatusDegraded}},
			HealthStatusUnhealthy,
		},
		{
			"degraded without unhealthy",
			[]Check{staticCheck{"http", HealthStatusHealthy}, staticCheck{"tcp", HealthStatusDegraded}},
			HealthStatusDegraded,
		},
		{
			"unknown degrades",
			[]Check{staticCheck{"http", HealthStatusHealthy}, staticCheck{"tcp", HealthStatusUnknown}},
			HealthStatusDegraded,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			cc := NewCompositeCheck(tc.checks...)
			res := cc.Run(context.Background())
			if res.Status != tc.want {
				t.Fatalf("status = %q, want %q", res.Status, tc.want)
			}
			if cc.Type() != "composite" {
				t.Errorf("check type = %q, want composite", cc.Type())
			}
			for _, c := range tc.checks {
				if !strings.Contains(res.Message, c.Type()) {
					t.Errorf("message %q missing per-check detail for %q", res.Message, c.Type())
				}
			}
		})
	}
}

func TestContainerCheck_Run_StateMapping(t *testing.T) {
	tests := []struct {
		state       string
		healthState string
		want        HealthStatus
	}{
		{"running", "healthy", HealthStatusHealthy},
		{"running", "unhealthy", HealthStatusUnhealthy},
		{"running", "starting", HealthStatusUnknown},
		{"running", "", HealthStatusHealthy},
		{"exited", "", HealthStatusUnhealthy},
		{"dead", "", HealthStatusUnhealthy},
		{"paused", "", HealthStatusDegraded},
		{"restarting", "", HealthStatusDegraded},
		{"created", "", HealthStatusUnknown},
	}

	for _, tc := range tests {
		t.Run(tc.state+"/"+tc.healthState, func(t *testing.T) {
			fake := &fakeRuntime{
				containers: []rt.ContainerInfo{{ID: "c1", Names: []string{"/myapp_web_1"}, State: tc.state}},
				inspect: &rt.ContainerInspectResult{
					ID:    "c1",
					State: rt.ContainerState{HealthState: tc.healthState},
				},
			}

			res := NewContainerCheck(ContainerCheckConfig{ContainerName: "myapp"}, fake).Run(context.Background())
			if res.Status != tc.want {
				t.Fatalf("status = %q, want %q (%s)", res.Status, tc.want, res.Message)
			}
		})
	}
}

func TestContainerCheck_Run_ContainerMissing(t *testing.T) {
	fake := &fakeRuntime{containers: []rt.ContainerInfo{{ID: "c1", Names: []string{"/other"}, State: "running"}}}

	res := NewContainerCheck(ContainerCheckConfig{ContainerName: "myapp"}, fake).Run(context.Background())
	if res.Status != HealthStatusUnhealthy {
		t.Fatalf("status = %q, want unhealthy", res.Status)
	}
	if !strings.Contains(res.Message, "myapp") {
		t.Errorf("message = %q, want it to name the missing container", res.Message)
	}
}

func TestContainerCheck_Run_ListError(t *testing.T) {
	fake := &fakeRuntime{listErr: context.DeadlineExceeded}

	res := NewContainerCheck(ContainerCheckConfig{ContainerName: "myapp"}, fake).Run(context.Background())
	if res.Status != HealthStatusUnknown {
		t.Fatalf("status = %q, want unknown", res.Status)
	}
}

func TestContainerCheck_Run_InspectErrorStillHealthyWhenRunning(t *testing.T) {
	fake := &fakeRuntime{
		containers: []rt.ContainerInfo{{ID: "c1", Names: []string{"/myapp"}, State: "running"}},
		inspectErr: context.DeadlineExceeded,
	}

	res := NewContainerCheck(ContainerCheckConfig{ContainerName: "myapp"}, fake).Run(context.Background())
	if res.Status != HealthStatusHealthy {
		t.Fatalf("status = %q, want healthy (%s)", res.Status, res.Message)
	}
}

func TestPickContainer_EmptyQuery(t *testing.T) {
	containers := []rt.ContainerInfo{{ID: "a", State: "running", Names: []string{"/whatever"}}}
	if got := pickContainer(containers, ""); got != nil {
		t.Fatalf("pickContainer with empty query = %#v, want nil", got)
	}
}

func TestPickContainer_Preference(t *testing.T) {
	tests := []struct {
		name       string
		containers []rt.ContainerInfo
		want       string
	}{
		{
			"running label match wins over running name match",
			[]rt.ContainerInfo{
				{ID: "byname", State: "running", Names: []string{"/myapp_web_1"}},
				{ID: "bylabel", State: "running", Labels: map[string]string{"libreserv.app": "myapp"}},
			},
			"bylabel",
		},
		{
			"running name match wins over stopped label match",
			[]rt.ContainerInfo{
				{ID: "byname", State: "running", Names: []string{"/myapp_web_1"}},
				{ID: "bylabel", State: "exited", Labels: map[string]string{"libreserv.app": "myapp"}},
			},
			"byname",
		},
		{
			"stopped label match wins over stopped name match",
			[]rt.ContainerInfo{
				{ID: "byname", State: "exited", Names: []string{"/myapp_web_1"}},
				{ID: "bylabel", State: "exited", Labels: map[string]string{"libreserv.app": "myapp"}},
			},
			"bylabel",
		},
		{
			"no match",
			[]rt.ContainerInfo{{ID: "other", State: "running", Names: []string{"/other"}}},
			"",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := pickContainer(tc.containers, "myapp")
			if tc.want == "" {
				if got != nil {
					t.Fatalf("pickContainer = %#v, want nil", got)
				}
				return
			}
			if got == nil || got.ID != tc.want {
				t.Fatalf("pickContainer = %#v, want %q", got, tc.want)
			}
		})
	}
}

func TestMatchesContainerByLabels(t *testing.T) {
	tests := []struct {
		name  string
		cont  rt.ContainerInfo
		query string
		want  bool
	}{
		{"nil labels", rt.ContainerInfo{}, "myapp", false},
		{"empty query", rt.ContainerInfo{Labels: map[string]string{"libreserv.app": "myapp"}}, "", false},
		{"compose service", rt.ContainerInfo{Labels: map[string]string{"com.docker.compose.service": "myapp"}}, "myapp", true},
		{"libreserv app", rt.ContainerInfo{Labels: map[string]string{"libreserv.app": "myapp"}}, "myapp", true},
		{"unrelated label", rt.ContainerInfo{Labels: map[string]string{"libreserv.app": "other"}}, "myapp", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := matchesContainerByLabels(tc.cont, tc.query); got != tc.want {
				t.Errorf("matchesContainerByLabels = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestMatchesContainerByName(t *testing.T) {
	tests := []struct {
		name  string
		cont  rt.ContainerInfo
		query string
		want  bool
	}{
		{"empty query", rt.ContainerInfo{Names: []string{"/myapp"}}, "", false},
		{"exact after slash trim", rt.ContainerInfo{Names: []string{"/myapp"}}, "myapp", true},
		{"substring", rt.ContainerInfo{Names: []string{"/stack-myapp-1"}}, "myapp", true},
		{"no names", rt.ContainerInfo{}, "myapp", false},
		{"no match", rt.ContainerInfo{Names: []string{"/other"}}, "myapp", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := matchesContainerByName(tc.cont, tc.query); got != tc.want {
				t.Errorf("matchesContainerByName = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestMatchesApp(t *testing.T) {
	tests := []struct {
		name  string
		cont  rt.ContainerInfo
		appID string
		want  bool
	}{
		{"compose project label", rt.ContainerInfo{Labels: map[string]string{"com.docker.compose.project": "myapp"}}, "myapp", true},
		{"name prefix", rt.ContainerInfo{Names: []string{"/myapp_db_1"}}, "myapp", true},
		{"name shorter than app id", rt.ContainerInfo{Names: []string{"/my"}}, "myapp", false},
		{"suffix does not match", rt.ContainerInfo{Names: []string{"/other-myapp"}}, "myapp", false},
		{"label for another app", rt.ContainerInfo{Labels: map[string]string{"com.docker.compose.project": "other"}}, "myapp", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := matchesApp(tc.cont, tc.appID); got != tc.want {
				t.Errorf("matchesApp = %v, want %v", got, tc.want)
			}
		})
	}
}
