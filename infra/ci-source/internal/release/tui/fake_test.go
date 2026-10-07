package tui

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/app"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/engine"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/publish"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/secrets"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/version"
)

func init() { lipgloss.SetColorProfile(termenv.Ascii) }

const secretValue = "hunter2-very-secret"

type fakeStore struct {
	mode     secrets.StoreMode
	saved    secrets.StoreMode
	unlocked bool
	exists   bool
	pass     string
	switched []secrets.StoreMode
	sysOK    bool
}

func (f *fakeStore) Mode() secrets.StoreMode  { return f.mode }
func (f *fakeStore) Saved() secrets.StoreMode { return f.saved }
func (f *fakeStore) SystemAvailable() (bool, error) {
	if f.sysOK {
		return true, nil
	}
	return false, errors.New("none")
}
func (f *fakeStore) VaultExists() bool { return f.exists }
func (f *fakeStore) VaultDir() string  { return "~/.config/libreserv-release/keyring" }
func (f *fakeStore) Unlocked() bool    { return f.mode == secrets.ModeSystem || f.unlocked }
func (f *fakeStore) NeedsUnlock() bool { return f.mode == secrets.ModeVault && !f.unlocked }
func (f *fakeStore) Unlock(p string) error {
	if f.exists && p != f.pass {
		return secrets.ErrWrongPassphrase
	}
	f.pass, f.exists, f.unlocked = p, true, true
	return nil
}
func (f *fakeStore) Lock() { f.unlocked = false }
func (f *fakeStore) Backend() string {
	return map[bool]string{true: "file", false: "secret-service"}[f.mode == secrets.ModeVault]
}
func (f *fakeStore) SwitchTo(m secrets.StoreMode, p string) (int, error) {
	if (m == secrets.ModeVault || f.mode == secrets.ModeVault) && !f.unlocked {
		if err := f.Unlock(p); err != nil {
			return 0, err
		}
	}
	f.mode, f.saved = m, m
	f.switched = append(f.switched, m)
	return 3, nil
}
func (f *fakeStore) ChangePassphrase(o, n string) error {
	if o != f.pass {
		return secrets.ErrWrongPassphrase
	}
	f.pass = n
	return nil
}

type fakeSecrets struct {
	mu     sync.Mutex
	status map[secrets.ID]secrets.Status
	values []string // slots set
	paths  []string
	proton secrets.ProtonConfig
}

func (f *fakeSecrets) List(context.Context) []secrets.Status {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []secrets.Status
	for _, id := range secrets.AllIDs() {
		out = append(out, f.status[id])
	}
	return out
}
func (f *fakeSecrets) Status(_ context.Context, id secrets.ID) secrets.Status {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.status[id]
}
func (f *fakeSecrets) Reprove(_ context.Context, id secrets.ID, _ bool) secrets.Status {
	return f.Status(context.Background(), id)
}
func (f *fakeSecrets) Refresh()                        {}
func (f *fakeSecrets) AddPath(p string) error          { f.paths = append(f.paths, p); return nil }
func (f *fakeSecrets) RemovePath(p string) error       { return nil }
func (f *fakeSecrets) Paths() []string                 { return f.paths }
func (f *fakeSecrets) Choose(secrets.ID, string) error { return nil }
func (f *fakeSecrets) SetValueOpt(slot, v string, remember bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.values = append(f.values, fmt.Sprintf("%s remember=%v len=%d", slot, remember, len(v)))
	// A password for the Luna key proves it.
	if slot == secrets.SlotPassword(secrets.LunaSigning) {
		f.status[secrets.LunaSigning] = secrets.Status{ID: secrets.LunaSigning, Label: "Luna release signing key", State: secrets.Proven, Summary: "Signs as key 4C1F."}
	}
	return nil
}
func (f *fakeSecrets) PasteKey(id secrets.ID, t string, r bool) (int, error) { return len(t), nil }
func (f *fakeSecrets) PasteKeystore(t string, r bool) (int, error)           { return len(t), nil }
func (f *fakeSecrets) Forget(string) error                                   { return nil }
func (f *fakeSecrets) Slots() []secrets.SlotInfo {
	return []secrets.SlotInfo{{Slot: secrets.SlotForgejoToken, Label: "Forgejo token", Set: true}}
}
func (f *fakeSecrets) ProtonConfig() secrets.ProtonConfig      { return f.proton }
func (f *fakeSecrets) SetProton(pc secrets.ProtonConfig) error { f.proton = pc; return nil }

type fakeBackend struct {
	sec   *fakeSecrets
	store *fakeStore
	br    *Bridge
	// built records requests.
	builds []app.BuildRequest
	cuts   []app.CutRequest
	// preflightAsk makes Preflight ask a question first.
	preflightAsk bool
}

func newFake(br *Bridge) *fakeBackend {
	f := &fakeBackend{br: br, store: &fakeStore{mode: secrets.ModeSystem, sysOK: true}}
	f.sec = &fakeSecrets{status: map[secrets.ID]secrets.Status{
		secrets.LibreServSigning: {ID: secrets.LibreServSigning, Label: "LibreServ release signing key", State: secrets.Proven, Summary: "Signs as key AB12.",
			Candidates: []secrets.Candidate{{Where: "file ~/.minisign/libreserv.key", Outcome: secrets.Used, Detail: "key ID matches"}}},
		secrets.LunaSigning: {ID: secrets.LunaSigning, Label: "Luna release signing key", State: secrets.Failed, Summary: "Found signing key files, but no known password opens them.",
			Candidates: []secrets.Candidate{{Where: "file ~/.minisign/lsluna.key", Outcome: secrets.Unusable, Reason: "none of the 3 known passwords opens it"},
				{Where: "file ~/backup/old-luna.key", Outcome: secrets.Rejected, Reason: "key ID 4C1F matches no public key"}}},
		secrets.ForgejoToken: {ID: secrets.ForgejoToken, Label: "Forgejo token", State: secrets.Proven, Summary: "fj CLI login, user plainskill",
			Candidates: []secrets.Candidate{{Where: "fj CLI login", Outcome: secrets.Used}}},
		secrets.AndroidKeystore: {ID: secrets.AndroidKeystore, Label: "Android release keystore", State: secrets.Missing, Summary: "No keystore found."},
	}}
	return f
}

func (f *fakeBackend) Units() []string { return []string{"sol", "luna", "luna-android"} }
func (f *fakeBackend) PartNames(u string) []string {
	return map[string][]string{"luna": {"web", "lunad", "rootfs"}}[u]
}
func (f *fakeBackend) RepoStatus(context.Context) app.RepoStatus {
	return app.RepoStatus{Branch: "main", SHA: "fe58182", Clean: true}
}
func (f *fakeBackend) UnitStatuses(context.Context) []app.UnitStatus {
	return []app.UnitStatus{{Unit: "sol", Version: "0.9.2", LastTag: "sol/v0.9.2", Since: 14},
		{Unit: "luna", Version: "0.4.0", LastTag: "luna/v0.4.0", Since: 31},
		{Unit: "luna-android", Version: "0.4.0", LastTag: "luna-android/v0.4.0", Since: 2}}
}
func (f *fakeBackend) FeedHeads(_ context.Context, u string) []app.FeedHead {
	now := time.Now()
	return []app.FeedHead{{Unit: u, Channel: "stable", Version: "0.4.0", Published: now.Add(-5 * 24 * time.Hour)},
		{Unit: u, Channel: "beta", Version: "0.4.1-beta.2", Published: now.Add(-2 * 24 * time.Hour)}}
}
func (f *fakeBackend) Unfinished(u string) ([]publish.State, error) {
	if u == "luna" {
		return []publish.State{{Unit: "luna", Version: "0.4.1-beta.3", Channel: "beta", Done: map[string]bool{"bump": true, "build": true, "sign": true}}}, nil
	}
	return nil, nil
}
func (f *fakeBackend) Doctor(context.Context, bool) *app.DoctorReport {
	return &app.DoctorReport{PodmanOK: true, PodmanVersion: "5.6.1", Rootless: true, FreeGB: 211, ImagesCurrent: 9, ImagesTotal: 9,
		Sections: []app.DoctorSection{{Title: "Podman", Checks: []app.DoctorCheck{{Name: "rootless", State: app.CheckOK, Detail: "podman is running rootless"}}}}}
}
func (f *fakeBackend) BumpPreviews(unit, ch string) []app.BumpPreview {
	cur, _ := version.Parse("0.4.0")
	var out []app.BumpPreview
	for _, k := range []string{"patch", "minor", "major", "beta"} {
		p := app.BumpPreview{Kind: k}
		n, err := cur.Next(k)
		switch {
		case err != nil:
			p.Err = err.Error()
		case ch == "stable" && k == "beta":
			p.Err = "stable needs a final version"
		case ch == "beta" && k != "beta":
			p.Err = "beta channel needs a beta version"
		default:
			p.Version = n.String()
			if unit == "luna-android" {
				p.VersionCode, _ = n.AndroidVersionCode()
			}
		}
		out = append(out, p)
	}
	return out
}
func (f *fakeBackend) CutVersion(r app.CutRequest) (version.Version, version.Version, error) {
	cur, _ := version.Parse("0.4.0")
	n, err := cur.Next(r.Bump)
	return cur, n, err
}
func (f *fakeBackend) DraftNotes(context.Context, string) (string, error) {
	return "- feat(luna): faster uploads\n- fix(luna): drive names\n", nil
}
func (f *fakeBackend) Preflight(ctx context.Context, r app.CutRequest) *app.PreflightReport {
	if f.preflightAsk {
		ans, _ := f.br.Ask(ctx, secrets.Question{Slot: secrets.SlotMinisignPassword, Label: "Password for ~/.minisign/lsluna.key", Secret: true})
		if !ans.Skip {
			f.sec.SetValueOpt(secrets.SlotPassword(secrets.LunaSigning), ans.Value, ans.Remember)
		}
	}
	rep := &app.PreflightReport{Unit: r.Unit, Channel: r.Channel, Current: "0.4.0", Version: "0.4.1"}
	rep.Checks = append(rep.Checks, app.Check{Name: "version", State: app.CheckOK, Detail: "0.4.1 on stable (current 0.4.0)"},
		app.Check{Name: "git", State: app.CheckOK, Detail: "main, clean, tag luna/v0.4.1 free"})
	st := f.sec.Status(ctx, secrets.LunaSigning)
	rep.Secrets = append(rep.Secrets, st)
	state := app.CheckOK
	if st.State != secrets.Proven {
		state = app.CheckFail
	}
	rep.Checks = append(rep.Checks, app.Check{Name: st.Label, State: state, Detail: st.Summary})
	return rep
}
func (f *fakeBackend) emit(ev app.Event) { f.br.OnEvent(ev) }
func (f *fakeBackend) Cut(ctx context.Context, r app.CutRequest) (*app.CutResult, error) {
	f.cuts = append(f.cuts, r)
	f.emit(app.Event{Kind: app.EventCut, Step: "bump", Phase: app.PhaseDone})
	f.emit(app.Event{Kind: app.EventPlan, Plan: []app.JobInfo{{ID: "luna/web", Title: "Web UI"}, {ID: "luna/lunad", Title: "lunad", Deps: []string{"luna/web"}}}})
	f.emit(app.Event{Kind: app.EventBuild, Build: engine.Event{Type: engine.EventStarted, Job: "luna/web", Time: time.Now()}})
	f.emit(app.Event{Kind: app.EventBuild, Build: engine.Event{Type: engine.EventLog, Job: "luna/web", Line: "vite build"}})
	f.emit(app.Event{Kind: app.EventBuild, Build: engine.Event{Type: engine.EventFinished, Job: "luna/web", Status: engine.Succeeded, Elapsed: 41 * time.Second}})
	f.emit(app.Event{Kind: app.EventCut, Step: "build", Phase: app.PhaseStart})
	if r.Version == "fail" {
		return nil, errors.New("upload: HTTP 500")
	}
	return &app.CutResult{Unit: r.Unit, Version: "0.4.1", Channel: r.Channel, Dry: r.Dry, SHA: "0123456789abcdef", Tag: "luna/v0.4.1", OutDir: "/cache/cut-dist",
		FeedURLs: []string{"https://gt.plainskill.net/LibreLoom/LibreServ/raw/branch/feeds/luna/stable.json"},
		Files:    []string{"https://gt.plainskill.net/api/packages/LibreLoom/generic/luna/0.4.1/lunad-linux-amd64-musl"}}, nil
}
func (f *fakeBackend) Build(ctx context.Context, r app.BuildRequest) (*app.BuildResult, error) {
	f.builds = append(f.builds, r)
	f.emit(app.Event{Kind: app.EventPlan, Plan: []app.JobInfo{{ID: "luna/web", Title: "Web UI"}, {ID: "luna/lunad", Title: "lunad", Deps: []string{"luna/web"}}, {ID: "luna/rootfs", Title: "Alpine rootfs"}}})
	f.emit(app.Event{Kind: app.EventBuild, Build: engine.Event{Type: engine.EventStarted, Job: "luna/web", Time: time.Now()}})
	f.emit(app.Event{Kind: app.EventBuild, Build: engine.Event{Type: engine.EventStarted, Job: "luna/rootfs", Time: time.Now()}})
	f.emit(app.Event{Kind: app.EventBuild, Build: engine.Event{Type: engine.EventLog, Job: "luna/rootfs", Line: "(212/340) Installing chrony"}})
	f.emit(app.Event{Kind: app.EventBuild, Build: engine.Event{Type: engine.EventFinished, Job: "luna/web", Status: engine.Succeeded, Elapsed: 41 * time.Second}})
	return &app.BuildResult{Commit: "fe58182", Units: []app.UnitBuild{{Unit: r.Unit, Version: "0.4.1-0.dev.31", Dir: "/repo/dist/luna/0.4.1-0.dev.31",
		Files: []app.FileOut{{Name: "a", Size: 4 << 20}, {Name: "b", Size: 27 << 20}}}}}, nil
}
func (f *fakeBackend) Verify(context.Context, string, string) ([]app.Verification, error) {
	return nil, nil
}
func (f *fakeBackend) StartDev(app.DevServeOptions) (*app.DevServer, error) {
	return nil, errors.New("not in tests")
}
func (f *fakeBackend) Redact(s string) string { return strings.ReplaceAll(s, secretValue, "***") }
func (f *fakeBackend) OutRoot() string        { return "/repo/dist" }
func (f *fakeBackend) Secrets() SecretsAPI    { return f.sec }
func (f *fakeBackend) Store() StoreAPI        { return f.store }

// ---- harness

type harness struct {
	t   *testing.T
	m   *Model
	br  *Bridge
	be  *fakeBackend
	mu  sync.Mutex
	q   []tea.Msg
	log []string
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	br := NewBridge()
	h := &harness{t: t, br: br}
	h.be = newFake(br)
	h.m = New(h.be, br)
	br.Attach(func(m tea.Msg) { h.mu.Lock(); h.q = append(h.q, m); h.mu.Unlock() })
	h.m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	return h
}

// run executes a command and feeds what it returns back in. Ticks are skipped.
func (h *harness) run(cmd tea.Cmd) {
	if cmd == nil {
		return
	}
	done := make(chan tea.Msg, 1)
	go func() { done <- cmd() }()
	var msg tea.Msg
	select {
	case msg = <-done:
	case <-time.After(300 * time.Millisecond):
		return
	}
	h.pump()
	h.feed(msg)
}

func (h *harness) pump() {
	for {
		h.mu.Lock()
		q := h.q
		h.q = nil
		h.mu.Unlock()
		if len(q) == 0 {
			return
		}
		for _, m := range q {
			h.feed(m)
		}
	}
}

func (h *harness) feed(msg tea.Msg) {
	if msg == nil {
		return
	}
	if _, ok := msg.(tickMsg); ok {
		return
	}
	v := reflect.ValueOf(msg)
	if v.Kind() == reflect.Slice && v.Type().Elem() == reflect.TypeOf((tea.Cmd)(nil)) {
		for i := 0; i < v.Len(); i++ {
			if c, _ := v.Index(i).Interface().(tea.Cmd); c != nil {
				h.run(c)
			}
		}
		return
	}
	_, cmd := h.m.Update(msg)
	h.run(cmd)
}

func (h *harness) start() {
	h.run(h.m.Init())
	h.pump()
}

func (h *harness) key(s string) {
	h.t.Helper()
	var k tea.KeyMsg
	switch s {
	case "enter":
		k = tea.KeyMsg{Type: tea.KeyEnter}
	case "esc":
		k = tea.KeyMsg{Type: tea.KeyEsc}
	case "tab":
		k = tea.KeyMsg{Type: tea.KeyTab}
	case "up":
		k = tea.KeyMsg{Type: tea.KeyUp}
	case "down":
		k = tea.KeyMsg{Type: tea.KeyDown}
	case "left":
		k = tea.KeyMsg{Type: tea.KeyLeft}
	case "right":
		k = tea.KeyMsg{Type: tea.KeyRight}
	case "ctrl+c":
		k = tea.KeyMsg{Type: tea.KeyCtrlC}
	case "ctrl+s":
		k = tea.KeyMsg{Type: tea.KeyCtrlS}
	case "space":
		k = tea.KeyMsg{Type: tea.KeySpace, Runes: []rune{' '}}
	default:
		k = tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(s)}
	}
	h.feed(k)
}

func (h *harness) typ(s string) {
	for _, r := range s {
		h.feed(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
	}
}

func (h *harness) view() string {
	h.t.Helper()
	v := h.m.View()
	lines := strings.Split(v, "\n")
	if len(lines) > 24 {
		h.t.Fatalf("view has %d lines:\n%s", len(lines), v)
	}
	for _, l := range lines {
		if w := lipgloss.Width(l); w > 80 {
			h.t.Fatalf("line is %d wide: %q", w, l)
		}
	}
	if strings.Contains(v, secretValue) {
		h.t.Fatalf("a secret value is on screen:\n%s", v)
	}
	return v
}

func (h *harness) wantView(sub ...string) string {
	h.t.Helper()
	v := h.view()
	for _, s := range sub {
		if !strings.Contains(v, s) {
			h.t.Fatalf("view lacks %q:\n%s", s, v)
		}
	}
	return v
}

func tea_size(w, h int) tea.Msg { return tea.WindowSizeMsg{Width: w, Height: h} }
