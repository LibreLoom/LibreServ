package secrets

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeForge accepts tokens by name: ok-* push, ro-* read only, else 401.
func fakeForge(t *testing.T) *httptest.Server {
	t.Helper()
	pkgs := map[string]bool{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tok := strings.TrimPrefix(r.Header.Get("Authorization"), "token ")
		if !strings.HasPrefix(tok, "ok-") && !strings.HasPrefix(tok, "ro-") {
			w.WriteHeader(401)
			return
		}
		switch {
		case r.URL.Path == "/api/v1/user":
			_ = json.NewEncoder(w).Encode(map[string]any{"login": "user-" + tok})
		case r.URL.Path == "/api/v1/repos/LibreLoom/LibreServ":
			_ = json.NewEncoder(w).Encode(map[string]any{"permissions": map[string]bool{"push": strings.HasPrefix(tok, "ok-"), "pull": true}})
		case strings.HasPrefix(r.URL.Path, "/api/packages/LibreLoom/generic/release-probe/"):
			switch r.Method {
			case http.MethodPut:
				pkgs[r.URL.Path] = true
				w.WriteHeader(201)
			case http.MethodDelete:
				w.WriteHeader(204)
			}
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestForgejoSourcesAndProof(t *testing.T) {
	srv := fakeForge(t)
	e := newTestEnv(t)
	host := "127.0.0.1"
	// fj keys.json
	e.write(filepath.Join(e.home, ".local/share/forgejo-cli/keys.json"),
		`{"hosts":{"`+host+`":{"type":"Application","token":"ok-fj"}},"aliases":{},"default_ssh":[]}`)
	// netrc with a user password (rejected), env with a read-only token.
	e.write(filepath.Join(e.home, ".netrc"), "machine "+host+" login bob password hunter2\n")
	e.env["FORGEJO_TOKEN"] = "ro-env"
	e.run = func(_ context.Context, stdin string, _ []string, name string, args ...string) ([]byte, error) {
		if name == "git" && strings.Contains(stdin, "host="+host) {
			return []byte("username=u\npassword=ok-fj\n"), nil // same token as fj: deduplicated
		}
		return nil, os.ErrNotExist
	}
	m := e.manager(func(o *Options) { o.ForgejoURL = srv.URL })
	c, st := m.Forgejo(context.Background())
	if st.State != Proven || c == nil || c.Token != "ok-fj" || c.User != "user-ok-fj" {
		t.Fatalf("%+v", st)
	}
	if len(st.Candidates) != 3 {
		t.Fatalf("want 3 distinct candidates, got %+v", st.Candidates)
	}
	var reasons []string
	for _, cd := range st.Candidates {
		reasons = append(reasons, cd.Reason)
		if strings.Contains(cd.Where, "fj CLI login") && !strings.Contains(cd.Where, "git credential") {
			t.Errorf("git credential duplicate not merged: %s", cd.Where)
		}
	}
	joined := strings.Join(reasons, "|")
	if !strings.Contains(joined, "401") || !strings.Contains(joined, "only read") {
		t.Fatalf("reasons: %v", reasons)
	}
	for _, v := range []string{"ok-fj", "ro-env", "hunter2"} {
		if !e.red.has(v) {
			t.Errorf("%s not redacted", v)
		}
	}
	if err := m.ProbeUpload(context.Background(), c); err != nil {
		t.Fatal(err)
	}
	ro := *c
	ro.BaseURL = srv.URL
	ro.Token = "bad"
	if err := m.ProbeUpload(context.Background(), &ro); err == nil {
		t.Fatal("probe with bad token should fail")
	}
}

func TestForgejoConflictAndChoose(t *testing.T) {
	srv := fakeForge(t)
	e := newTestEnv(t)
	e.env["FORGEJO_TOKEN"] = "ok-a"
	e.env["FORGEJO_TOKEN_B64"] = "b2stYg==" // ok-b
	m := e.manager(func(o *Options) { o.ForgejoURL = srv.URL })
	ctx := context.Background()
	st := m.Status(ctx, ForgejoToken)
	if st.State != Conflict {
		t.Fatalf("%+v", st)
	}
	if err := m.Choose(ForgejoToken, st.Candidates[1].Ref); err != nil {
		t.Fatal(err)
	}
	c, st := m.Forgejo(ctx)
	if st.State != Proven || c.Token != "ok-b" {
		t.Fatalf("%+v", st)
	}
}

func TestForgejoMissingPromptAndUnreachable(t *testing.T) {
	srv := fakeForge(t)
	e := newTestEnv(t)
	m := e.manager(func(o *Options) { o.ForgejoURL = srv.URL })
	if st := m.Status(context.Background(), ForgejoToken); st.State != Missing {
		t.Fatalf("%+v", st)
	}
	e.pr = &fakePrompter{answers: map[string]Answer{SlotForgejoToken: {Value: "ok-typed", Remember: true}}}
	m = e.manager(func(o *Options) { o.ForgejoURL = srv.URL })
	if st := m.Status(context.Background(), ForgejoToken); st.State != Proven {
		t.Fatalf("%+v", st)
	}
	if v, _ := m.opt.Store.Get(SlotForgejoToken); v != "ok-typed" {
		t.Fatal("not remembered")
	}
	// Remembered value is found without a prompt next time.
	e.pr = nil
	m2 := e.manager(func(o *Options) { o.ForgejoURL = srv.URL; o.Store = m.opt.Store })
	if st := m2.Status(context.Background(), ForgejoToken); st.State != Proven {
		t.Fatalf("%+v", st)
	}
	srv.Close()
	m3 := e.manager(func(o *Options) { o.ForgejoURL = srv.URL; o.Store = m.opt.Store })
	st := m3.Status(context.Background(), ForgejoToken)
	if st.State != Failed || st.Candidates[0].Outcome != Unusable {
		t.Fatalf("%+v", st)
	}
}

func TestTeaAndNetrcParsing(t *testing.T) {
	d := t.TempDir()
	p := filepath.Join(d, "config.yml")
	os.WriteFile(p, []byte("logins:\n    - name: a\n      url: https://other.example\n      token: nope\n    - name: gt\n      url: https://gt.plainskill.net\n      token: tea-token\n      default: true\n"), 0o600)
	got := readTeaConfig(p, "gt.plainskill.net")
	if len(got) != 1 || got[0] != "tea-token" {
		t.Fatalf("%v", got)
	}
}
