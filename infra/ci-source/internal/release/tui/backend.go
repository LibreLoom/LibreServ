package tui

import (
	"context"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/app"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/publish"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/secrets"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/version"
)

// Backend is the part of the orchestration layer the TUI uses. *app.App
// satisfies it through FromApp; tests use a fake.
type Backend interface {
	Units() []string
	PartNames(unit string) []string
	RepoStatus(ctx context.Context) app.RepoStatus
	UnitStatuses(ctx context.Context) []app.UnitStatus
	FeedHeads(ctx context.Context, unit string) []app.FeedHead
	Unfinished(unit string) ([]publish.State, error)
	Doctor(ctx context.Context, includeSecrets bool) *app.DoctorReport

	BumpPreviews(unit, channel string) []app.BumpPreview
	CutVersion(req app.CutRequest) (cur, next version.Version, err error)
	NotesDraft(ctx context.Context, unit string) (app.NotesDraft, error)
	Preflight(ctx context.Context, req app.CutRequest) *app.PreflightReport
	Cut(ctx context.Context, req app.CutRequest) (*app.CutResult, error)
	Build(ctx context.Context, req app.BuildRequest) (*app.BuildResult, error)
	Verify(ctx context.Context, unit, channel string) ([]app.Verification, error)
	StartDev(opt app.DevServeOptions) (*app.DevServer, error)

	Redact(s string) string
	OutRoot() string

	Secrets() SecretsAPI
	// Store is nil when remembered values are not available at all.
	Store() StoreAPI
}

// SecretsAPI is what the TUI needs from *secrets.Manager.
type SecretsAPI interface {
	List(ctx context.Context) []secrets.Status
	Status(ctx context.Context, id secrets.ID) secrets.Status
	Reprove(ctx context.Context, id secrets.ID, full bool) secrets.Status
	Refresh()
	AddPath(path string) error
	RemovePath(path string) error
	Paths() []string
	Choose(id secrets.ID, ref string) error
	SetValueOpt(slot, value string, remember bool) error
	PasteKey(id secrets.ID, text string, remember bool) (int, error)
	PasteKeystore(b64 string, remember bool) (int, error)
	Forget(slot string) error
	Slots() []secrets.SlotInfo
	ProtonConfig() secrets.ProtonConfig
	SetProton(pc secrets.ProtonConfig) error
}

// StoreAPI is what the TUI needs from *secrets.StoreManager.
type StoreAPI interface {
	Mode() secrets.StoreMode
	Saved() secrets.StoreMode
	SystemAvailable() (bool, error)
	VaultExists() bool
	VaultDir() string
	Unlocked() bool
	NeedsUnlock() bool
	Unlock(pass string) error
	Lock()
	Backend() string
	SwitchTo(mode secrets.StoreMode, vaultPass string) (int, error)
	ChangePassphrase(oldPass, newPass string) error
}

type appBackend struct{ *app.App }

// FromApp adapts the orchestration layer.
func FromApp(a *app.App) Backend { return appBackend{a} }

func (b appBackend) Secrets() SecretsAPI { return b.App.Secrets() }

func (b appBackend) Store() StoreAPI {
	if s := b.App.Store(); s != nil {
		return s
	}
	return nil
}

var _ Backend = appBackend{}
