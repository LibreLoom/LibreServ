package secrets

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const goodRef = "pass://V/I/f"

func protonRunner(calls *atomic.Int32, info error, view func(ref string) ([]byte, error)) Runner {
	return func(_ context.Context, _ string, _ []string, name string, args ...string) ([]byte, error) {
		if name != "pass-cli" {
			return nil, nil // git and friends are not under test
		}
		calls.Add(1)
		if args[0] == "info" {
			return nil, info
		}
		return view(args[2])
	}
}

func TestIsPassRef(t *testing.T) {
	for ref, want := range map[string]bool{
		goodRef:                                  true,
		"pass://Personal/Item with spaces/pass":  true,
		"pass://V/I":                             false,
		"pass://":                                false,
		"hunter2hunter2":                         false,
		"1C5T9u8EYrYbM#y%*Tb!KeDdCp9WUw2eZv$sSV": false,
		"":                                       false,
	} {
		if got := IsPassRef(ref); got != want {
			t.Errorf("IsPassRef(%q) = %v, want %v", ref, got, want)
		}
	}
}

func TestSetProtonRejectsBadSettings(t *testing.T) {
	e := newTestEnv(t)
	m := e.manager(func(o *Options) { o.ConfigDir = filepath.Join(e.home, "cfg") })
	secret := "p4ssw0rd-that-was-pasted"
	for name, refs := range map[string]map[string]string{
		"pasted value": {SlotForgejoToken: secret},
		"unknown slot": {"minisign-password:libreserv-signing": goodRef},
	} {
		err := m.SetProton(ProtonConfig{Enabled: true, Refs: refs})
		if err == nil {
			t.Fatalf("%s: accepted", name)
		}
		if strings.Contains(err.Error(), secret) {
			t.Fatalf("%s: error echoes the value: %v", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(e.home, "cfg", "secrets.json")); err == nil {
		t.Fatal("a rejected setting was saved")
	}
}

func TestProtonLookupNeverRunsOnNonReference(t *testing.T) {
	var calls atomic.Int32
	run := protonRunner(&calls, nil, func(string) ([]byte, error) { return []byte("x"), nil })
	// Hand-edited config: the value is a pasted password.
	p := NewProton(ProtonConfig{Enabled: true, Refs: map[string]string{SlotForgejoToken: "hunter2hunter2"}}, run)
	_, err := p.Lookup(context.Background(), SlotForgejoToken)
	if err == nil || strings.Contains(err.Error(), "hunter2") {
		t.Fatalf("err=%v", err)
	}
	// Reading is never attempted for it (only the sign-in check may run).
	if calls.Load() > 1 {
		t.Fatalf("ran the CLI %d times", calls.Load())
	}
}

func TestProtonSignedOut(t *testing.T) {
	var calls atomic.Int32
	run := protonRunner(&calls, errors.New("exit status 1"), func(string) ([]byte, error) {
		t.Fatal("read while signed out")
		return nil, nil
	})
	p := NewProton(ProtonConfig{Enabled: true, Refs: map[string]string{SlotForgejoToken: goodRef, SlotAndroidAlias: goodRef}}, run)
	for _, slot := range []string{SlotForgejoToken, SlotAndroidAlias} {
		if _, err := p.Lookup(context.Background(), slot); err == nil || !strings.Contains(err.Error(), "not signed in") {
			t.Fatalf("%s: %v", slot, err)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("sign-in checked %d times, want 1", calls.Load())
	}
}

func TestProtonReadFailureAndEmptyValue(t *testing.T) {
	var calls atomic.Int32
	run := protonRunner(&calls, nil, func(ref string) ([]byte, error) {
		if ref == "pass://V/Missing/f" {
			return nil, errors.New("pass-cli: Error: Could not find item")
		}
		return []byte("\n"), nil
	})
	p := NewProton(ProtonConfig{Enabled: true, Refs: map[string]string{SlotForgejoToken: "pass://V/Missing/f", SlotAndroidAlias: goodRef}}, run)
	if _, err := p.Lookup(context.Background(), SlotForgejoToken); err == nil || !strings.Contains(err.Error(), "Could not find item") {
		t.Fatalf("%v", err)
	}
	if v, err := p.Lookup(context.Background(), SlotAndroidAlias); v != nil || err != nil {
		t.Fatalf("empty value: %v %v", v, err)
	}
}

func TestProtonLookupIsRemembered(t *testing.T) {
	var calls atomic.Int32
	run := protonRunner(&calls, nil, func(string) ([]byte, error) { return []byte("pw\n"), nil })
	p := NewProton(ProtonConfig{Enabled: true, Refs: map[string]string{SlotForgejoToken: goodRef}}, run)
	for range 4 {
		if v, _ := p.Lookup(context.Background(), SlotForgejoToken); len(v) != 1 || v[0] != "pw" {
			t.Fatalf("%v", v)
		}
	}
	if calls.Load() != 2 { // one info, one item view
		t.Fatalf("ran the CLI %d times, want 2", calls.Load())
	}
	// A test run starts over so it reports what is true now.
	if res := p.Check(context.Background()); len(res) != 1 || res[0].Err != "" || calls.Load() != 4 {
		t.Fatalf("%+v calls=%d", res, calls.Load())
	}
}

func TestProtonCheckReportsEachSlot(t *testing.T) {
	var calls atomic.Int32
	run := protonRunner(&calls, nil, func(ref string) ([]byte, error) {
		if strings.Contains(ref, "Bad") {
			return nil, errors.New("Error: Could not find item")
		}
		return []byte("pw"), nil
	})
	p := NewProton(ProtonConfig{Enabled: true, Refs: map[string]string{SlotForgejoToken: goodRef, SlotAndroidAlias: "pass://V/Bad/f"}}, run)
	res := p.Check(context.Background())
	if len(res) != 2 || res[0].Slot != SlotForgejoToken || res[0].Err != "" || res[1].Slot != SlotAndroidAlias || res[1].Err == "" {
		t.Fatalf("%+v", res)
	}
}

// A failing Proton lookup must show up in the secret's status instead of
// leaving a bare "not found".
func TestProtonFailureIsShownInStatus(t *testing.T) {
	e := newTestEnv(t)
	var calls atomic.Int32
	run := protonRunner(&calls, errors.New("exit status 1"), nil)
	m := e.manager(func(o *Options) {
		o.ConfigDir = filepath.Join(e.home, "cfg")
		o.Run = run
	})
	if err := m.SetProton(ProtonConfig{Enabled: true, Refs: map[string]string{SlotForgejoToken: goodRef}}); err != nil {
		t.Fatal(err)
	}
	st := m.Status(context.Background(), ForgejoToken)
	for _, c := range st.Candidates {
		if strings.HasPrefix(c.Where, "Proton Pass") && strings.Contains(c.Reason, "not signed in") {
			return
		}
	}
	t.Fatalf("no Proton Pass note in %+v", st.Candidates)
}

// The real runner must treat "Error:" on stderr as a failure even with exit 0
// (pass-cli does this).
func TestRunCommandStderrError(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "fake-pass-cli")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\necho 'Error: Could not find vault' >&2\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	_, err := runCommand(context.Background(), "", nil, bin, "item", "view", goodRef)
	if err == nil || !strings.Contains(err.Error(), "Could not find vault") {
		t.Fatalf("%v", err)
	}
}

// All references are read at once, not one after another.
func TestProtonReadsInParallel(t *testing.T) {
	var inFlight, peak atomic.Int32
	run := func(_ context.Context, _ string, _ []string, _ string, args ...string) ([]byte, error) {
		if args[0] != "item" {
			return nil, nil
		}
		n := inFlight.Add(1)
		for {
			if old := peak.Load(); n <= old || peak.CompareAndSwap(old, n) {
				break
			}
		}
		time.Sleep(50 * time.Millisecond)
		inFlight.Add(-1)
		return []byte("pw"), nil
	}
	p := NewProton(ProtonConfig{Enabled: true, Refs: map[string]string{SlotForgejoToken: goodRef, SlotAndroidAlias: goodRef, SlotAndroidKeyPW: goodRef}}, run)
	if _, err := p.Lookup(context.Background(), SlotForgejoToken); err != nil {
		t.Fatal(err)
	}
	if peak.Load() < 2 {
		t.Fatalf("peak concurrency %d, want reads at once", peak.Load())
	}
}
