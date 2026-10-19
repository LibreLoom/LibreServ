package config

import "testing"

func TestPerfResolve(t *testing.T) {
	cur := PerfLimits{Parallelism: 4}
	if got := GetPerfProfile("full").Resolve(PerfLimits{Parallelism: 4, CPUQuota: 5, MemoryLimit: 6, Nice: 7}); got != cur {
		t.Fatalf("full must clear limits, got %+v", got)
	}
	if got := PerfCustom.Resolve(cur); got != cur {
		t.Fatalf("custom must not change limits, got %+v", got)
	}
	g := GetPerfProfile("gentle").resolve(cur, 8, 32<<30)
	want := PerfLimits{Parallelism: 2, CPUQuota: 320000, MemoryLimit: 8 << 30, Nice: 19}
	if g != want {
		t.Fatalf("gentle = %+v, want %+v", g, want)
	}
	if g := GetPerfProfile("gentle").resolve(PerfLimits{Parallelism: 1}, 1, 0); g.Parallelism != 1 || g.CPUQuota != 100000 || g.MemoryLimit != 0 {
		t.Fatalf("small machine = %+v", g)
	}
	if GetPerfProfile("nope") != nil {
		t.Fatal("unknown id must be nil")
	}
}

func TestUserConfigLimits(t *testing.T) {
	l, bounded := (&UserConfig{Parallelism: 4, PerfProfile: "full"}).Limits()
	if bounded || l.CPUQuota != 0 || l.Parallelism != 4 {
		t.Fatalf("full = %+v bounded=%v", l, bounded)
	}
	l, bounded = (&UserConfig{Parallelism: 8, PerfProfile: "gentle"}).Limits()
	if !bounded || l.Parallelism != 2 || l.Nice != 19 || l.CPUQuota == 0 {
		t.Fatalf("gentle = %+v bounded=%v", l, bounded)
	}
	l, bounded = (&UserConfig{Parallelism: 8, CPUQuota: 300000, PerfProfile: "custom"}).Limits()
	if !bounded || l.Parallelism != 3 {
		t.Fatalf("custom must keep its numbers and cap jobs to whole cores, got %+v", l)
	}
	if _, bounded = (&UserConfig{PerfProfile: "typo"}).Limits(); !bounded {
		t.Fatal("unknown profile must fall back to the bounded default")
	}
	if CapJobs(0, 0) != 1 || CapJobs(4, 150000) != 1 || CapJobs(2, 0) != 2 {
		t.Fatal("CapJobs")
	}
}
