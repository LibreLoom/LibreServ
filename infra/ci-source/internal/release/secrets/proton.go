package secrets

import (
	"context"
	"fmt"
	"strings"
	"sync"
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

// Proton is the Proton Pass ValueSource. Sign-in and lookups are remembered
// for the life of this value; the Manager makes a new one whenever settings
// change or the user asks to rescan.
type Proton struct {
	cfg ProtonConfig
	run Runner

	mu       sync.Mutex
	signed   bool
	signedAt error
	checked  bool
	cache    map[string]protonResult
}

type protonResult struct {
	vals []string
	err  error
}

// ProtonCheck is the outcome of testing one reference. Err is empty when the
// reference gave a value.
type ProtonCheck struct {
	Slot string
	Ref  string
	Err  string
}

// IsPassRef reports whether s looks like a Proton Pass reference.
func IsPassRef(s string) bool {
	rest, ok := strings.CutPrefix(s, "pass://")
	return ok && strings.Count(strings.Trim(rest, "/"), "/") >= 2
}

// validate rejects settings that cannot work: unknown slots and anything that
// is not a pass:// reference (a pasted password must never be saved here).
func (c ProtonConfig) validate() error {
	for slot, ref := range c.Refs {
		if !validSlot(slot) {
			return fmt.Errorf("proton pass: %q is not a value this tool can look up", slot)
		}
		if !IsPassRef(ref) {
			return fmt.Errorf("proton pass: the reference for %s must look like pass://Vault/Item/field", slot)
		}
	}
	return nil
}

func NewProton(cfg ProtonConfig, run Runner) *Proton { return &Proton{cfg: cfg, run: run} }

func (p *Proton) Name() string { return "Proton Pass" }
func (p *Proton) Enabled() bool {
	return p != nil && p.cfg.Enabled && len(p.cfg.Refs) > 0 && p.run != nil
}

func (p *Proton) Lookup(ctx context.Context, slot string) ([]string, error) {
	if _, ok := p.cfg.Refs[slot]; !ok {
		return nil, nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if r, ok := p.cache[slot]; !ok {
		p.warm(ctx)
	} else {
		return r.vals, r.err
	}
	r := p.cache[slot]
	return r.vals, r.err
}

// Check tests every configured reference now, ignoring what was remembered.
func (p *Proton) Check(ctx context.Context) []ProtonCheck {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.checked, p.cache = false, nil
	p.warm(ctx)
	var out []ProtonCheck
	for _, sl := range allSlots() {
		ref, ok := p.cfg.Refs[sl.Slot]
		if !ok {
			continue
		}
		c := ProtonCheck{Slot: sl.Slot, Ref: ref}
		r := p.cache[sl.Slot]
		switch {
		case r.err != nil:
			c.Err = r.err.Error()
		case len(r.vals) == 0:
			c.Err = "the item has no value in that field"
		}
		out = append(out, c)
	}
	return out
}

// warm looks up every configured reference at once (each CLI call takes a few
// seconds, so one by one a release check crawls) and fills the cache. The
// caller holds p.mu.
func (p *Proton) warm(ctx context.Context) {
	if p.cache == nil {
		p.cache = map[string]protonResult{}
	}
	if err := p.signIn(ctx); err != nil {
		for slot := range p.cfg.Refs {
			p.cache[slot] = protonResult{err: err}
		}
		return
	}
	var wg sync.WaitGroup
	var rmu sync.Mutex
	for slot := range p.cfg.Refs {
		if _, done := p.cache[slot]; done {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			vals, err := p.fetch(ctx, slot)
			rmu.Lock()
			p.cache[slot] = protonResult{vals, err}
			rmu.Unlock()
		}()
	}
	wg.Wait()
}

// signIn checks once whether the CLI is signed in. The caller holds p.mu.
func (p *Proton) signIn(ctx context.Context) error {
	if !p.checked {
		cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		_, err := p.run(cctx, "", nil, p.bin(), "info")
		p.checked, p.signed, p.signedAt = true, err == nil, err
	}
	if !p.signed {
		return fmt.Errorf("proton pass: not signed in (run pass-cli login): %w", p.signedAt)
	}
	return nil
}

func (p *Proton) bin() string {
	if p.cfg.Binary == "" {
		return "pass-cli"
	}
	return p.cfg.Binary
}

// fetch reads one reference. Sign-in was checked by warm; it takes no lock.
func (p *Proton) fetch(ctx context.Context, slot string) ([]string, error) {
	ref := p.cfg.Refs[slot]
	if !IsPassRef(ref) {
		// Never hand a pasted password to the CLI or echo it in an error.
		return nil, fmt.Errorf("proton pass: the reference for %s must look like pass://Vault/Item/field", slot)
	}
	cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	out, err := p.run(cctx, "", nil, p.bin(), "item", "view", ref)
	if err != nil {
		return nil, fmt.Errorf("proton pass: %w", err)
	}
	v := strings.TrimRight(string(out), "\r\n")
	if v == "" {
		return nil, nil
	}
	return []string{v}, nil
}
