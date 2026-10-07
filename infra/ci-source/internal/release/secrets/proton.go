package secrets

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// ProtonConfig enables the optional Proton Pass source. It is off unless the
// user turns it on (config file secrets.json, "proton").
//
// Verified against pass-cli 2.4.2: `pass-cli info` (exit 1 when logged out),
// then `pass-cli item view "pass://<vault>/<item>/<field>"` prints the value
// with a trailing newline; stderr "Error:" means failure whatever the exit code.
type ProtonConfig struct {
	Enabled bool `json:"enabled"`
	// Refs maps a slot name (see Slot* constants) to a pass:// reference,
	// e.g. "forgejo-token": "pass://Release/Forgejo/token".
	Refs map[string]string `json:"refs,omitempty"`
	// Binary overrides the CLI name (default "pass-cli").
	Binary string `json:"binary,omitempty"`
}

// Proton is the Proton Pass ValueSource.
type Proton struct {
	cfg ProtonConfig
	run Runner
}

func NewProton(cfg ProtonConfig, run Runner) *Proton { return &Proton{cfg: cfg, run: run} }

func (p *Proton) Name() string { return "Proton Pass" }
func (p *Proton) Enabled() bool {
	return p != nil && p.cfg.Enabled && len(p.cfg.Refs) > 0 && p.run != nil
}

func (p *Proton) Lookup(ctx context.Context, slot string) ([]string, error) {
	ref, ok := p.cfg.Refs[slot]
	if !ok {
		return nil, nil
	}
	bin := p.cfg.Binary
	if bin == "" {
		bin = "pass-cli"
	}
	cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	// Check login first: exit codes of reads are unreliable.
	if _, err := p.run(cctx, "", nil, bin, "info"); err != nil {
		return nil, fmt.Errorf("proton pass: not signed in (run pass-cli login): %w", err)
	}
	out, err := p.run(cctx, "", nil, bin, "item", "view", ref)
	if err != nil {
		return nil, fmt.Errorf("proton pass: %w", err)
	}
	v := strings.TrimRight(string(out), "\r\n")
	if v == "" {
		return nil, nil
	}
	return []string{v}, nil
}
