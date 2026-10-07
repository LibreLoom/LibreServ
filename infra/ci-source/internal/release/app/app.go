package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"aead.dev/minisign"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/engine"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/parts"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/publish"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/secrets"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/version"
)

func sprintf(format string, args ...any) string {
	if len(args) == 0 {
		return format
	}
	return fmt.Sprintf(format, args...)
}

// Forge defaults.
const (
	DefaultForgejoURL = "https://gt.plainskill.net"
	DefaultOwner      = "LibreLoom"
	DefaultRepoName   = "LibreServ"
)

// Config configures an App. Only Repo is required; every hook defaults to the
// real thing and exists so tests can run with fake parts and servers.
type Config struct {
	// Repo is the LibreServ checkout.
	Repo string
	// Engine runs builds (default: engine.New with Repo and CacheDir).
	Engine *engine.Engine
	// CacheDir is the host cache root (default ~/.cache/libreserv-release).
	CacheDir string
	// OutRoot is where dev builds go (default <Repo>/dist).
	OutRoot string

	// Secrets finds and proves secrets (default: a Manager over Repo, with
	// the engine's redactor, the OS keyring, and Prompter).
	Secrets *secrets.Manager
	// Prompter asks for missing secrets; nil means non-interactive.
	Prompter secrets.Prompter
	// NoKeyring never opens the OS keyring (pasted values cannot be remembered).
	NoKeyring bool

	// OnEvent receives progress events.
	OnEvent func(Event)

	// Parts returns a unit's parts (default parts.For).
	Parts func(unit string) []engine.Part
	// Units lists the units "all" builds (default parts.Units).
	Units func() []string
	// FeedSpecs returns the unit's expected release files (default: the
	// parts table in RELEASE-PLAN.md).
	FeedSpecs func(unit string) []FileSpec
	// VersionFiles maps unit -> VERSION file relative to Repo (default version.Units).
	VersionFiles map[string]string
	// DevVersion computes a dev version (default version.DevVersion).
	DevVersion func(ctx context.Context, repo, unit, ref string) (version.Version, error)

	// Signer and ForgeCreds replace the proven secrets (tests only: they
	// skip discovery and proving).
	Signer     publish.Signer
	ForgeCreds *secrets.ForgejoCreds

	// Forge settings (defaults: the real Forgejo).
	ForgejoURL string
	Owner      string
	RepoName   string
	HTTP       *http.Client

	// StateDir holds resumable cut state (default publish.DefaultStateDir).
	StateDir    string
	PollEvery   time.Duration
	PollTimeout time.Duration
	Now         func() time.Time
}

// App is the orchestration layer. Safe for concurrent use.
type App struct {
	cfg  Config
	eng  *engine.Engine
	sec  *secrets.Manager
	emit *emitter
	// stateFor records which Redactor feeds which secrets.
}

// New fills in defaults.
func New(cfg Config) (*App, error) {
	if cfg.Repo == "" {
		return nil, errors.New("app: no repository root")
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Parts == nil {
		cfg.Parts = parts.For
	}
	if cfg.Units == nil {
		cfg.Units = parts.Units
	}
	if cfg.FeedSpecs == nil {
		cfg.FeedSpecs = DefaultFileSpecs
	}
	if cfg.VersionFiles == nil {
		cfg.VersionFiles = version.Units
	}
	if cfg.DevVersion == nil {
		cfg.DevVersion = version.DevVersion
	}
	if cfg.ForgejoURL == "" {
		cfg.ForgejoURL = DefaultForgejoURL
	}
	if cfg.Owner == "" {
		cfg.Owner = DefaultOwner
	}
	if cfg.RepoName == "" {
		cfg.RepoName = DefaultRepoName
	}
	if cfg.HTTP == nil {
		cfg.HTTP = &http.Client{Timeout: 5 * time.Minute}
	}
	if cfg.OutRoot == "" {
		cfg.OutRoot = filepath.Join(cfg.Repo, "dist")
	}
	eng := cfg.Engine
	if eng == nil {
		var err error
		eng, err = engine.New(engine.Config{Repo: cfg.Repo, CacheDir: cfg.CacheDir})
		if err != nil {
			return nil, err
		}
	}
	cfg.CacheDir = eng.CacheDir()
	a := &App{cfg: cfg, eng: eng, emit: &emitter{fn: cfg.OnEvent, now: cfg.Now}}
	a.sec = cfg.Secrets
	if a.sec == nil {
		o := secrets.Options{
			RepoRoot: cfg.Repo,
			Prompter: cfg.Prompter,
			Redactor: redactAdapter{eng.Redactor},
			CacheDir: cfg.CacheDir,
		}
		if !cfg.NoKeyring {
			o.Store = newLazyStore(cfg.Prompter)
		}
		a.sec = secrets.New(o)
	}
	return a, nil
}

// Engine returns the build engine.
func (a *App) Engine() *engine.Engine { return a.eng }

// Secrets returns the secrets manager.
func (a *App) Secrets() *secrets.Manager { return a.sec }

// Repo is the checkout root.
func (a *App) Repo() string { return a.cfg.Repo }

// OutRoot is the dev build root (dist/).
func (a *App) OutRoot() string { return a.cfg.OutRoot }

// Units lists every unit that has parts, sorted.
func (a *App) Units() []string { return a.cfg.Units() }

// Redact scrubs known secret values from a string (for printing errors).
func (a *App) Redact(s string) string { return a.eng.Redactor.Redact(s) }

// redactAdapter lets the engine's variadic Redactor satisfy secrets.Redactor.
type redactAdapter struct{ r *engine.Redactor }

func (a redactAdapter) Add(s string) { a.r.Add(s) }

// lazyStore opens the OS keyring on first use, so commands that never need
// it (and machines with a locked or missing keyring) don't pay for it. When
// it cannot open, every slot reads as unset and writes fail with the reason.
type lazyStore struct {
	prompter secrets.Prompter
	once     sync.Once
	store    secrets.Store
	err      error
}

func newLazyStore(p secrets.Prompter) *lazyStore { return &lazyStore{prompter: p} }

// keyringTimeout bounds every keyring call: a locked keyring waiting on an
// unlock dialog must not hang the tool.
const keyringTimeout = 15 * time.Second

func (l *lazyStore) open() (secrets.Store, error) {
	l.once.Do(func() {
		cfg := secrets.KeyringConfig{}
		if l.prompter != nil {
			cfg.Passphrase = func(prompt string) (string, error) {
				a, err := l.prompter.Ask(context.Background(), secrets.Question{
					Slot: "keyring-passphrase", Label: "Passphrase for the encrypted keyring file", Hint: prompt, Secret: true})
				if err != nil {
					return "", err
				}
				if a.Skip || a.Value == "" {
					return "", errors.New("no passphrase given")
				}
				return a.Value, nil
			}
		}
		type opened struct {
			s   secrets.Store
			err error
		}
		ch := make(chan opened, 1)
		go func() {
			s, err := secrets.NewKeyringStore(cfg)
			ch <- opened{s, err}
		}()
		select {
		case o := <-ch:
			l.store, l.err = o.s, o.err
		case <-time.After(keyringTimeout):
			l.err = errors.New("the keyring did not answer in time (is it locked?)")
		}
	})
	return l.store, l.err
}

// bounded runs f, giving up after keyringTimeout.
func bounded[T any](f func() (T, error)) (T, error) {
	type r struct {
		v   T
		err error
	}
	ch := make(chan r, 1)
	go func() { v, err := f(); ch <- r{v, err} }()
	select {
	case x := <-ch:
		return x.v, x.err
	case <-time.After(keyringTimeout):
		var zero T
		return zero, errors.New("the keyring did not answer in time (is it locked?)")
	}
}

func (l *lazyStore) Get(slot string) (string, error) {
	s, err := l.open()
	if err != nil {
		return "", secrets.ErrNotFound
	}
	v, err := bounded(func() (string, error) { return s.Get(slot) })
	if err != nil && !errors.Is(err, secrets.ErrNotFound) {
		return "", secrets.ErrNotFound
	}
	return v, err
}
func (l *lazyStore) Set(slot, value string) error {
	s, err := l.open()
	if err != nil {
		return err
	}
	_, err = bounded(func() (struct{}, error) { return struct{}{}, s.Set(slot, value) })
	return err
}
func (l *lazyStore) Remove(slot string) error {
	s, err := l.open()
	if err != nil {
		return nil
	}
	_, err = bounded(func() (struct{}, error) { return struct{}{}, s.Remove(slot) })
	return err
}
func (l *lazyStore) Keys() ([]string, error) {
	s, err := l.open()
	if err != nil {
		return nil, err
	}
	return bounded(func() ([]string, error) { return s.Keys() })
}
func (l *lazyStore) Backend() string {
	s, err := l.open()
	if err != nil {
		return "none"
	}
	return s.Backend()
}

// ---- helpers shared by build, cut, verify

// signingID is the signing key a unit's releases use.
func signingID(unit string) secrets.ID {
	if unit == "sol" || unit == "sol-connect" {
		return secrets.LibreServSigning
	}
	return secrets.LunaSigning
}

// PublicKeyFile is the keys/ file whose key pins a unit's signatures.
func PublicKeyFile(unit string) string {
	if signingID(unit) == secrets.LibreServSigning {
		return "libreserv.minisign.pub"
	}
	return "lsluna.minisign.pub"
}

// PublicKey reads the pinned public key of a unit from keys/.
func (a *App) PublicKey(unit string) (minisign.PublicKey, error) {
	p := filepath.Join(a.cfg.Repo, "keys", PublicKeyFile(unit))
	b, err := os.ReadFile(p)
	if err != nil {
		return minisign.PublicKey{}, err
	}
	var pub minisign.PublicKey
	// keys/*.pub files are minisign public key files: comment line + key.
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	if err := pub.UnmarshalText([]byte(strings.TrimSpace(lines[len(lines)-1]))); err != nil {
		return minisign.PublicKey{}, fmt.Errorf("%s: %w", p, err)
	}
	return pub, nil
}

// secretSigner adapts a proven secrets.Signer to publish.Signer.
type secretSigner struct{ s *secrets.Signer }

func (s secretSigner) Sign(msg []byte, comment string) ([]byte, error) {
	return s.s.SignWithComment(msg, comment)
}

func (a *App) unitKnown(unit string) error {
	for _, u := range a.cfg.Units() {
		if u == unit {
			return nil
		}
	}
	return fmt.Errorf("unknown unit %q (have %s)", unit, strings.Join(a.cfg.Units(), ", "))
}

func (a *App) feedURL(unit, channel string) string {
	return fmt.Sprintf("%s/%s/%s/raw/branch/feeds/%s/%s.json", strings.TrimRight(a.cfg.ForgejoURL, "/"),
		a.cfg.Owner, a.cfg.RepoName, unit, channel)
}

// FeedURL is where receivers read a unit's feed on the forge.
func (a *App) FeedURL(unit, channel string) string { return a.feedURL(unit, channel) }

func (a *App) registry(c *secrets.ForgejoCreds) (*publish.Registry, *publish.Forgejo) {
	tok := publish.StaticToken(c.Token)
	return &publish.Registry{BaseURL: a.cfg.ForgejoURL, Owner: a.cfg.Owner, Token: tok, HTTP: a.cfg.HTTP, Retries: 3, Backoff: 5 * time.Second},
		&publish.Forgejo{BaseURL: a.cfg.ForgejoURL, Owner: a.cfg.Owner, Repo: a.cfg.RepoName, Token: tok, HTTP: a.cfg.HTTP}
}
