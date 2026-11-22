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
	"errors"
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
	SolSigning      ID = "sol-signing"  // keys/sol.minisign.pub
	LunaSigning     ID = "luna-signing" // keys/luna.minisign.pub
	ForgejoToken    ID = "forgejo-token"
	AndroidKeystore ID = "android-keystore"
)

// AllIDs lists every secret in display order.
func AllIDs() []ID {
	return []ID{SolSigning, LunaSigning, ForgejoToken, AndroidKeystore}
}

// State is the outcome for one secret.
type State string

const (
	Proven   State = "proven"   // found and proved; usable
	Failed   State = "failed"   // candidates exist but none proved itself
	Missing  State = "missing"  // nothing found
	Conflict State = "conflict" // two different valid candidates; user must Choose
	// Locked: an encrypted key or keystore was found and is not opened yet. It
	// opens with the release passphrase when a cut is about to sign (Unlock).
	Locked State = "locked"
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
	Where   string // "file ~/.minisign/luna.key", "env FORGEJO_TOKEN", "fj CLI login", ...
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
	// NeedsPassword is set (with State Locked, or Failed after a passphrase
	// was typed) when the only thing missing is a passphrase: the file or
	// keystore was found and has not been opened.
	NeedsPassword bool
}

// Redactor receives every secret value we load so output filters can hide it.
type Redactor interface{ Add(secret string) }

// Question is asked through a Prompter when a secret cannot be discovered.
type Question struct {
	Slot   string // store slot the answer belongs to
	Key    string // what is being asked about (a file path); a skipped answer is remembered per Slot and Key
	Label  string // short, plain: "Password for ~/.minisign/luna.key"
	Hint   string // where the value comes from
	Secret bool   // hide typed characters
}

// Answer is the user's reply.
type Answer struct {
	Value string
	// Bytes may carry a secret reply instead of Value (the terminal prompter
	// does this for the release passphrase), so no string copy of it exists.
	// The manager owns and wipes it.
	Bytes    []byte
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
	skipped       map[string]bool   // prompts the user skipped; kept until an explicit re-prove
	envMemo       map[string][]found
	session       map[string][]string // values typed this session and not remembered
	protonSv      *Proton
	srcNotes      []Candidate // lookup failures seen while resolving one secret
	forceScanOnce bool

	// passes are the passphrases typed this run (the release passphrase
	// first, then any typed for one key). Never stored, never logged, never
	// given to the Redactor (which would keep a copy); zeroed by Wipe.
	passes []passphrase
	// unlocking is set while Unlock runs: only then is a passphrase asked.
	unlocking bool
}

// passphrase is one typed passphrase and what it was typed for.
type passphrase struct {
	Where string // "release passphrase", "passphrase typed for ~/.minisign/luna.key"
	Value []byte
}

// maxPassphraseTries bounds how often one key's own passphrase is asked.
const maxPassphraseTries = 3

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
	m := &Manager{opt: o, memo: map[ID]*resolved{}, asked: map[string]Answer{}, skipped: map[string]bool{}, envMemo: map[string][]found{}, session: map[string][]string{}}
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

// Refresh forgets what was learned and answered this session (a skipped
// question is asked again by the next lookup). Nothing is proven here.
func (m *Manager) Refresh() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.invalidateLocked(false)
}

// Reprove drops what was learned this session and proves again from scratch.
// The pairing cache is kept (it is re-checked against the file hash anyway);
// pass full=true to also clear it and rescan the home folder.
func (m *Manager) Reprove(ctx context.Context, id ID, full bool) Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.invalidateLocked(full)
	m.skipped = map[string]bool{} // proving again on purpose: ask again
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
	if IsOldPasswordSlot(slot) || slot == ReleasePassphraseSlot {
		return ErrPasswordNotSaved
	}
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
	// Old marks a password an earlier version remembered: never used, only
	// listed so it can be forgotten.
	Old bool
}

// Slots lists the remember-able values and whether each is set. Passwords an
// earlier version remembered are listed too (Set, Old), only so they can be
// forgotten; their values are never read.
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
	for _, slot := range m.OldPasswords() {
		out = append(out, SlotInfo{Slot: slot, Label: "Old saved password, no longer used (forget it)", Set: true, Old: true})
	}
	return out
}

// OldPasswords lists the signing-key passwords an earlier version of this
// tool remembered and that are still in the store. Only the slot names are
// read, never the values.
func (m *Manager) OldPasswords() []string {
	if m.opt.Store == nil {
		return nil
	}
	keys, err := m.opt.Store.Keys()
	if err != nil {
		return nil
	}
	var out []string
	for _, k := range keys {
		if IsOldPasswordSlot(k) {
			out = append(out, k)
		}
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

// Unlock opens the given signing keys and keystore for a cut that is about
// to sign. It asks for the release passphrase once (through the Prompter, in
// the terminal, never remembered) and tries it on every candidate; a key it
// does not open is asked about by name. Without a Prompter it fails: there is
// no non-interactive way to give a signing passphrase. Call Wipe when signing
// is done.
func (m *Manager) Unlock(ctx context.Context, ids ...ID) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.unlocking = true
	defer func() { m.unlocking = false }()
	// Unlocking on purpose asks again, even after an earlier skip.
	for k := range m.skipped {
		if strings.HasPrefix(k, ReleasePassphraseSlot+"\x00") {
			delete(m.skipped, k)
		}
	}
	var problems []string
	for _, id := range ids {
		if r, ok := m.memo[id]; ok && r.status.State != Proven {
			delete(m.memo, id)
		}
		r := m.resolveLocked(ctx, id)
		if r.status.State == Proven {
			continue
		}
		if m.opt.Prompter == nil && r.status.State == Locked {
			return errors.New("signing needs the release passphrase, and it can only be typed in a terminal. Run ./release in a terminal")
		}
		problems = append(problems, r.status.Label+": "+r.status.Summary)
	}
	if len(problems) > 0 {
		return errors.New(strings.Join(problems, "; "))
	}
	return nil
}

// Wipe zeroes every passphrase typed this run and the opened signing keys and
// keystore passwords, and forgets them: the next cut asks again. Go may still
// hold short-lived copies (the strings the decryption libraries take, values a
// prompter read); this wipes everything the manager owns.
func (m *Manager) Wipe() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, p := range m.passes {
		wipeBytes(p.Value)
	}
	m.passes = nil
	for _, id := range []ID{SolSigning, LunaSigning, AndroidKeystore} {
		r, ok := m.memo[id]
		if !ok {
			continue
		}
		switch v := r.value.(type) {
		case *Signer:
			v.wipe()
		case *Keystore:
			v.Wipe()
		}
		delete(m.memo, id)
	}
}

func wipeBytes(b []byte) {
	for i := range b {
		b[i] = 0
	}
}

// askReleasePassphrase asks for the release passphrase unless one was typed
// already this run. It reports whether there is one now.
func (m *Manager) askReleasePassphrase(ctx context.Context) bool {
	for _, p := range m.passes {
		if p.Where == "release passphrase" {
			return true
		}
	}
	return m.askPassphrase(ctx, "release", "release passphrase", "Release passphrase",
		"The one passphrase that opens the release signing keys and the Android keystore. It is never saved.")
}

// askKeyPassphrase asks for the passphrase of one key the release passphrase
// did not open. It reports whether one was typed.
func (m *Manager) askKeyPassphrase(ctx context.Context, key, label, hint string) bool {
	return m.askPassphrase(ctx, key, "passphrase typed for "+m.tilde(key), label, hint)
}

func (m *Manager) askPassphrase(ctx context.Context, key, where, label, hint string) bool {
	if !m.unlocking || m.opt.Prompter == nil {
		return false
	}
	skipKey := ReleasePassphraseSlot + "\x00" + key
	if m.skipped[skipKey] {
		return false
	}
	a, err := m.opt.Prompter.Ask(ctx, Question{Slot: ReleasePassphraseSlot, Key: key, Label: label, Hint: hint, Secret: true})
	pw := a.Bytes
	if pw == nil && a.Value != "" {
		pw = []byte(a.Value)
	}
	if err != nil || a.Skip || len(pw) == 0 {
		wipeBytes(pw)
		if err == nil {
			m.skipped[skipKey] = true
		}
		return false
	}
	m.passes = append(m.passes, passphrase{Where: where, Value: pw})
	return true
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
	m.srcNotes = nil
	defer func() { m.attachSourceNotes(id) }()
	switch id {
	case SolSigning, LunaSigning:
		m.resolveSigning(ctx, id)
	case ForgejoToken:
		m.memo[id] = m.resolveForgejo(ctx)
	case AndroidKeystore:
		m.memo[id] = m.resolveAndroid(ctx)
	default:
		m.memo[id] = &resolved{status: Status{ID: id, Label: string(id), State: Missing, Summary: "Unknown secret."}}
	}
	return m.memo[id]
}

// attachSourceNotes lists value sources that failed while resolving id (for
// example Proton Pass signed out), so a "not found" says why. Proven secrets
// are left alone.
func (m *Manager) attachSourceNotes(id ID) {
	r := m.memo[id]
	if r == nil || r.status.State == Proven || len(m.srcNotes) == 0 {
		return
	}
	seen := map[string]bool{}
	for _, c := range r.status.Candidates {
		seen[c.Where] = true
	}
	for _, c := range m.srcNotes {
		if !seen[c.Where] {
			seen[c.Where] = true
			r.status.Candidates = append(r.status.Candidates, c)
		}
	}
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
	key := q.Slot + "\x00" + coalesce(q.Key, q.Label)
	if a, ok := m.asked[key]; ok {
		return a.Value
	}
	if m.skipped[key] {
		return ""
	}
	a, err := m.opt.Prompter.Ask(ctx, q)
	if err != nil || a.Skip || a.Value == "" {
		m.asked[key] = Answer{}
		if err == nil {
			m.skipped[key] = true
		}
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
