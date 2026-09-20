package monitoring

import (
	"testing"
	"time"
)

func TestClamp01(t *testing.T) {
	tests := []struct {
		in   float64
		want float64
	}{
		{-1, 0},
		{0, 0},
		{0.42, 0.42},
		{1, 1},
		{2.5, 1},
	}
	for _, tc := range tests {
		if got := clamp01(tc.in); got != tc.want {
			t.Errorf("clamp01(%v) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

func TestMaxFloat(t *testing.T) {
	if got := maxFloat(0.2, 0.8); got != 0.8 {
		t.Errorf("maxFloat(0.2, 0.8) = %v, want 0.8", got)
	}
	if got := maxFloat(0.9, 0.1); got != 0.9 {
		t.Errorf("maxFloat(0.9, 0.1) = %v, want 0.9", got)
	}
	if got := maxFloat(0.5, 0.5); got != 0.5 {
		t.Errorf("maxFloat(0.5, 0.5) = %v, want 0.5", got)
	}
}

func TestNormalizeUsage(t *testing.T) {
	tests := []struct {
		name  string
		usage uint64
		total uint64
		want  float64
	}{
		{"zero total avoids divide by zero", 100, 0, 0},
		{"half used", 512, 1024, 0.5},
		{"fully used", 1024, 1024, 1},
		{"usage above total is clamped", 2048, 1024, 1},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := normalizeUsage(tc.usage, tc.total); got != tc.want {
				t.Errorf("normalizeUsage(%d, %d) = %v, want %v", tc.usage, tc.total, got, tc.want)
			}
		})
	}
}

func TestNetworkLoad_FirstCallPrimesAndReturnsZero(t *testing.T) {
	h := NewHostMetricsCollector()
	now := time.Now()

	if got := h.NetworkLoad(1_000_000, now); got != 0 {
		t.Fatalf("first sample = %v, want 0 (collector primes on first call)", got)
	}

	// 1 MB/s equals the container baseline, so the load reads as fully saturated.
	if got := h.NetworkLoad(1_000_000+baselineBytesPerSecondContainer, now.Add(time.Second)); got != 1 {
		t.Fatalf("saturated sample = %v, want 1", got)
	}
}

func TestNetworkLoad_HalfBaseline(t *testing.T) {
	h := NewHostMetricsCollector()
	now := time.Now()
	h.NetworkLoad(0, now)

	got := h.NetworkLoad(baselineBytesPerSecondContainer/2, now.Add(time.Second))
	if got != 0.5 {
		t.Fatalf("half-baseline sample = %v, want 0.5", got)
	}
}

func TestNetworkLoad_NonAdvancingClockReturnsZero(t *testing.T) {
	h := NewHostMetricsCollector()
	now := time.Now()
	h.NetworkLoad(0, now)

	if got := h.NetworkLoad(baselineBytesPerSecondContainer, now); got != 0 {
		t.Fatalf("same-timestamp sample = %v, want 0", got)
	}
}

func TestNetworkLoad_CounterResetReturnsZero(t *testing.T) {
	h := NewHostMetricsCollector()
	now := time.Now()
	h.NetworkLoad(5_000_000, now)

	// Interface counters reset (e.g. host reboot): treat as no traffic, not a huge spike.
	if got := h.NetworkLoad(10, now.Add(time.Second)); got != 0 {
		t.Fatalf("counter-reset sample = %v, want 0", got)
	}
}

func TestHostCPU_FirstCallPrimes(t *testing.T) {
	h := NewHostMetricsCollector()
	if got := h.HostCPU(); got != 0 {
		t.Fatalf("first HostCPU sample = %v, want 0", got)
	}
	if got := h.HostCPU(); got < 0 || got > 1 {
		t.Fatalf("HostCPU = %v, want a fraction in [0,1]", got)
	}
}

func TestHostMetricsCollector_ReadsStayInRange(t *testing.T) {
	h := NewHostMetricsCollector()

	if got := h.HostCPULoad(); got < 0 || got > 1 {
		t.Errorf("HostCPULoad = %v, want a fraction in [0,1]", got)
	}
	if got := h.HostMemory(); got < 0 || got > 1 {
		t.Errorf("HostMemory = %v, want a fraction in [0,1]", got)
	}
	if got := h.HostNetworkLoad(time.Now()); got != 0 {
		t.Errorf("first HostNetworkLoad sample = %v, want 0", got)
	}
}

func TestDiskUsage_FallsBackToRootForUnknownPath(t *testing.T) {
	h := NewHostMetricsCollector()

	total, free := h.DiskUsage("/definitely/not/a/real/path")
	if total == 0 {
		t.Fatal("total = 0, want the root filesystem size from the fallback path")
	}
	if free > total {
		t.Fatalf("free (%d) > total (%d)", free, total)
	}
}
