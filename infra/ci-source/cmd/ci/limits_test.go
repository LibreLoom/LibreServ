package main

import "testing"

func TestLimitFlagsNeedSession(t *testing.T) {
	for name, call := range map[string]func() error{
		"perf":     func() error { _, _, err := resolveLimits(false, "gentle", 0, "", 4, false); return err },
		"cpus":     func() error { _, _, err := resolveLimits(false, "", 2, "", 4, false); return err },
		"memory":   func() error { _, _, err := resolveLimits(false, "", 0, "4G", 4, false); return err },
		"parallel": func() error { _, _, err := resolveLimits(false, "", 0, "", 2, true); return err },
	} {
		if call() == nil {
			t.Errorf("-%s without -session should be refused", name)
		}
	}
}

func TestSessionLimitsAreNotUniversal(t *testing.T) {
	l, universal, err := resolveLimits(true, "gentle", 0, "", 4, false)
	if err != nil || universal || l.Parallelism != 2 || l.CPUQuota == 0 {
		t.Fatalf("got %+v universal=%v err=%v", l, universal, err)
	}
	l, universal, err = resolveLimits(true, "", 0, "", 4, false)
	if err != nil || universal || l.CPUQuota != 0 || l.MemoryLimit != 0 {
		t.Fatalf("session with no limits should be unbounded, got %+v", l)
	}
}
