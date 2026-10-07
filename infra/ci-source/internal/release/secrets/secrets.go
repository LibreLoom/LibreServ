// Package secrets finds, pairs and proves the secrets a release needs: the
// two minisign signing keys, the Forgejo token and the Android keystore.
//
// Secrets are identified by their contents, never by file name or place.
// Every candidate is gathered and tested; the ones that prove themselves are
// used and rejected candidates stay visible with the reason (see Status).
// Secret values are registered with a Redactor as soon as they are loaded and
// never written to disk (only the Store and the user's own files hold them).
package secrets

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// ID names one secret the release tool needs.
type ID string

const (
	LibreServSigning ID = "libreserv-signing" // keys/libreserv.minisign.pub
	LunaSigning      ID = "lsluna-signing"    // keys/lsluna.minisign.pub
	ForgejoToken     ID = "forgejo-token"
	AndroidKeystore  ID = "android-keystore"
)

// AllIDs lists every secret in display order.
func AllIDs() []ID {
	return []ID{LibreServSigning, LunaSigning, ForgejoToken, AndroidKeystore}
}

// State is the outcome for one secret.
type State string

const (
	Proven   State = "proven"   // found and proved; usable
	Failed   State = "failed"   // candidates exist but none proved itself
	Missing  State = "missing"  // nothing found
	Conflict State = "conflict" // two different valid candidates; user must Choose
)

// Outcome is the result for one candidate.
type Outcome string

const (
	Used     Outcome = "used"     // proved and selected
	Valid    Outcome = "valid"    // proved, but another candidate is used (same key) or conflicts
	Rejected Outcome = "rejected" // tested and wrong
	Unusable Outcome = "unusable" // could not be tested (no password, forge unreachable, ...)
)

// Candidate is one place a secret might live, and what happened to it.
type Candidate struct {
	Where   string // "file ~/.minisign/lsluna.key", "env FORGEJO_TOKEN", "fj CLI login", ...
	Ref     string // short stable id for Choose (never reveals the value)
	Detail  string // key ID, user name, fingerprint, ...
	Outcome Outcome
	Reason  string // why rejected / unusable
}

// Status is the report for one secret.
type Status struct {
	ID         ID
	Label      string
	State      State
	Summary    string // one plain sentence
	Candidates []Candidate
}

// Redactor receives every secret value we load so output filters can hide it.
type Redactor interface{ Add(secret string) }

// Question is asked through a Prompter when a secret cannot be discovered.
type Question struct {
	Slot   string // store slot the answer belongs to
	Label  string // short, plain: "Password for ~/.minisign/lsluna.key"
	Hint   string // where the value comes from
	Secret bool   // hide typed characters
}

// Answer is the user's reply.
type Answer struct {
	Value    string
	Remember bool // store in the keyring / encrypted file
	Skip     bool // user declined
}

// Prompter asks the user inline (TUI) or on the terminal (CLI). A nil
// Prompter means non-interactive: missing secrets are reported, never asked.
type Prompter interface {
	Ask(ctx context.Context, q Question) (Answer, error)
}

// Runner runs an external command (git credential fill, NAME_CMD, pass-cli).
type Runner func(ctx context.Context, stdin string, env []string, name string, args ...string) ([]byte, error)

// Options configures a Manager. Only RepoRoot is required.
type Options struct {
	RepoRoot  string // checkout holding keys/*.minisign.pub
	Home      string // default os.UserHomeDir
	ConfigDir string // default ~/.config/libreserv-release
	CacheDir  string // default ~/.cache/libreserv-release
	Getenv    func(string) string
	Store     Store // nil: pasted values cannot be remembered
	Prompter  Prompter
	Redactor  Redactor
	HTTP      *http.Client
	Run       Runner

	ForgejoURL string // default https://gt.plainskill.net
	Repo       string // default LibreLoom/LibreServ

	// Sources are extra value sources (Proton Pass). Disabled ones are skipped.
	Sources []ValueSource

	NoHomeScan  bool          // never scan the home folder
	ForceScan   bool          // always scan, even when everything proved already
	ScanTimeout time.Duration // default 8s
	ScanDepth   int           // default 5
}

// Manager discovers and proves secrets. Safe for concurrent use; resolves are
// serialised (minisign password tries use up to 1 GB of memory each).
type Manager struct {
	opt Options

	mu            sync.Mutex
	memo          map[ID]*resolved
	asked         map[string]Answer // prompts already answered this session
	envMemo       map[string][]found
	session       map[string][]string // values typed this session and not remembered
	protonSv      *Proton
	forceScanOnce bool
}

type resolved struct {
	status Status
	value  any
}

// New builds a Manager, filling defaults.
func New(o Options) *Manager {
	if o.Home == "" {
		o.Home, _ = os.UserHomeDir()
	}
	if o.ConfigDir == "" {
		o.ConfigDir = filepath.Join(o.Home, ".config", "libreserv-release")
	}
	if o.CacheDir == "" {
		o.CacheDir = filepath.Join(o.Home, ".cache", "libreserv-release")
	}
	if o.Getenv == nil {
		o.Getenv = os.Getenv
	}
	if o.HTTP == nil {
		o.HTTP = &http.Client{Timeout: 20 * time.Second}
	}
	if o.Run == nil {
		o.Run = runCommand
	}
	if o.ForgejoURL == "" {
		o.ForgejoURL = "https://gt.plainskill.net"
	}
	o.ForgejoURL = strings.TrimRight(o.ForgejoURL, "/")
	if o.Repo == "" {
		o.Repo = "LibreLoom/LibreServ"
	}
	if o.ScanTimeout == 0 {
		o.ScanTimeout = 8 * time.Second
	}
	if o.ScanDepth == 0 {
		o.ScanDepth = 5
	}
	m := &Manager{opt: o, memo: map[ID]*resolved{}, asked: map[string]Answer{}, envMemo: map[string][]found{}, session: map[string][]string{}}
	m.protonSv = NewProton(m.loadConfig().Proton, o.Run)
	return m
}

func runCommand(ctx context.Context, stdin string, env []string, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = append(os.Environ(), env...)
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err == nil {
		// Some CLIs (pass-cli) exit 0 on failures: stderr "Error:" is a failure.
		for _, l := range strings.Split(stderr.String(), "\n") {
			if strings.HasPrefix(strings.TrimSpace(l), "Error:") {
				return nil, fmt.Errorf("%s: %s", name, strings.TrimSpace(l))
			}
		}
	}
	return out, err
}

// ---- public API ----

// List resolves and proves every secret. Results are memoised until Reprove,
// AddPath, SetValue, Forget or Choose changes something.
func (m *Manager) List(ctx context.Context) []Status {
	var out []Status
	for _, id := range AllIDs() {
		out = append(out, m.Status(ctx, id))
	}
	return out
}

// Status resolves and proves one secret.
func (m *Manager) Status(ctx context.Context, id ID) Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.resolveLocked(ctx, id).status
}

// Reprove drops what was learned this session and proves again from scratch.
// The pairing cache is kept (it is re-checked against the file hash anyway);
// pass full=true to also clear it and rescan the home folder.
func (m *Manager) Reprove(ctx context.Context, id ID, full bool) Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.invalidateLocked(full)
	return m.resolveLocked(ctx, id).status
}

// AddPath remembers a file or folder to search for keys and keystores.
func (m *Manager) AddPath(path string) error {
	p := m.expand(path)
	if _, err := os.Stat(p); err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	c := m.loadConfig()
	for _, x := range c.Paths {
		if x == p {
			return nil
		}
	}
	c.Paths = append(c.Paths, p)
	m.invalidateLocked(false)
	return m.saveConfig(c)
}

// RemovePath forgets a user-added path.
func (m *Manager) RemovePath(path string) error {
	p := m.expand(path)
	m.mu.Lock()
	defer m.mu.Unlock()
	c := m.loadConfig()
	out := c.Paths[:0]
	for _, x := range c.Paths {
		if x != p {
			out = append(out, x)
		}
	}
	c.Paths = out
	m.invalidateLocked(false)
	return m.saveConfig(c)
}

// Paths lists the user-added files and folders.
func (m *Manager) Paths() []string { return m.loadConfig().Paths }

// Choose settles a Conflict by picking one candidate (Candidate.Ref).
func (m *Manager) Choose(id ID, ref string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	c := m.loadConfig()
	if c.Choices == nil {
		c.Choices = map[ID]string{}
	}
	if ref == "" {
		delete(c.Choices, id)
	} else {
		c.Choices[id] = ref
	}
	m.invalidateLocked(false)
	return m.saveConfig(c)
}

// PinAndroidCert pins the SHA-256 fingerprint the keystore certificate must
// have (hex, colons and case ignored). Empty clears the pin.
func (m *Manager) PinAndroidCert(fp string) error {
	fp = normFingerprint(fp)
	m.mu.Lock()
	defer m.mu.Unlock()
	c := m.loadConfig()
	c.AndroidCertSHA256 = fp
	m.invalidateLocked(false)
	return m.saveConfig(c)
}

// SetValue stores a pasted value in the keyring (or encrypted file). Slot is
// one of the names from Slots().
func (m *Manager) SetValue(slot, value string) error {
	if m.opt.Store == nil {
		return fmt.Errorf("no keyring available to remember %s", slot)
	}
	if !validSlot(slot) {
		return fmt.Errorf("unknown slot %q", slot)
	}
	if value == "" {
		return fmt.Errorf("empty value for %s", slot)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.redact(value)
	m.invalidateLocked(false)
	return m.opt.Store.Set(slot, value)
}

// Forget removes a remembered value.
func (m *Manager) Forget(slot string) error {
	if m.opt.Store == nil {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.invalidateLocked(false)
	return m.opt.Store.Remove(slot)
}

// SlotInfo describes one place a pasted value can be remembered.
type SlotInfo struct {
	Slot  string
	Label string
	Set   bool
}

// Slots lists the remember-able values and whether each is set.
func (m *Manager) Slots() []SlotInfo {
	var out []SlotInfo
	for _, s := range allSlots() {
		set := false
		if m.opt.Store != nil {
			_, err := m.opt.Store.Get(s.Slot)
			set = err == nil
		}
		s.Set = set
		out = append(out, s)
	}
	return out
}

// Signing returns an in-process signer for a product key, once proven.
func (m *Manager) Signing(ctx context.Context, id ID) (*Signer, Status) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.resolveLocked(ctx, id)
	s, _ := r.value.(*Signer)
	return s, r.status
}

// Forgejo returns the proven token, once proven.
func (m *Manager) Forgejo(ctx context.Context) (*ForgejoCreds, Status) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.resolveLocked(ctx, ForgejoToken)
	c, _ := r.value.(*ForgejoCreds)
	return c, r.status
}

// Android returns the proven keystore details, once proven.
func (m *Manager) Android(ctx context.Context) (*Keystore, Status) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.resolveLocked(ctx, AndroidKeystore)
	k, _ := r.value.(*Keystore)
	return k, r.status
}

// ---- internals ----

func (m *Manager) invalidateLocked(full bool) {
	m.memo = map[ID]*resolved{}
	m.envMemo = map[string][]found{}
	m.asked = map[string]Answer{}
	m.protonSv = NewProton(m.loadConfig().Proton, m.opt.Run)
	if full {
		m.cacheClear()
		m.forceScanOnce = true
	}
}

func (m *Manager) resolveLocked(ctx context.Context, id ID) *resolved {
	if r, ok := m.memo[id]; ok {
		return r
	}
	switch id {
	case LibreServSigning, LunaSigning:
		m.resolveSigning(ctx)
	case ForgejoToken:
		m.memo[id] = m.resolveForgejo(ctx)
	case AndroidKeystore:
		m.memo[id] = m.resolveAndroid(ctx)
	default:
		m.memo[id] = &resolved{status: Status{ID: id, Label: string(id), State: Missing, Summary: "Unknown secret."}}
	}
	return m.memo[id]
}

func (m *Manager) redact(vals ...string) {
	if m.opt.Redactor == nil {
		return
	}
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			m.opt.Redactor.Add(v)
		}
	}
}

func (m *Manager) expand(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") {
		p = filepath.Join(m.opt.Home, strings.TrimPrefix(p, "~"))
	}
	if !filepath.IsAbs(p) {
		if a, err := filepath.Abs(p); err == nil {
			p = a
		}
	}
	return filepath.Clean(p)
}

// tilde shortens a path for display.
func (m *Manager) tilde(p string) string {
	if m.opt.Home != "" && (p == m.opt.Home || strings.HasPrefix(p, m.opt.Home+"/")) {
		return "~" + strings.TrimPrefix(p, m.opt.Home)
	}
	return p
}

// ask prompts once per slot+label per session. Returns the value or "".
func (m *Manager) ask(ctx context.Context, q Question) string {
	if m.opt.Prompter == nil {
		return ""
	}
	key := q.Slot + "\x00" + q.Label
	if a, ok := m.asked[key]; ok {
		return a.Value
	}
	a, err := m.opt.Prompter.Ask(ctx, q)
	if err != nil || a.Skip || a.Value == "" {
		m.asked[key] = Answer{}
		return ""
	}
	m.asked[key] = a
	m.redact(a.Value)
	if validSlot(q.Slot) {
		if a.Remember && m.opt.Store != nil && m.opt.Store.Set(q.Slot, a.Value) == nil {
			// remembered
		} else {
			m.session[q.Slot] = append(m.session[q.Slot], a.Value)
		}
	}
	return a.Value
}

func refOf(value string) string { return shortHash([]byte(value)) }
