package config

import (
	"bufio"
	"os"
	"runtime"
	"strconv"
	"strings"
)

// PerfProfile says how hard a run may push the machine. It is a separate axis
// from Profile (which picks the tests). The default, "full", applies no limits.
type PerfProfile struct {
	ID          string
	Name        string
	Description string
	// Parallel caps parallelism; 0 keeps the configured value.
	Parallel int
	// CPUPercent and MemPercent are shares of the machine (0 = unlimited).
	CPUPercent int
	MemPercent int
	// Nice is the host-test niceness (0 = leave alone).
	Nice int
}

// PerfLimits are the concrete numbers a PerfProfile resolves to on this machine.
type PerfLimits struct {
	Parallelism int
	CPUQuota    int64 // microseconds per 100ms period, as Docker/Podman expect
	MemoryLimit int64 // bytes
	Nice        int
}

const PerfFull = "full"

// DefaultPerfProfile applies when .ci.conf doesn't exist, so a fresh checkout
// is bounded rather than free to take the whole machine.
const DefaultPerfProfile = "gentle"

// CapJobs limits n parallel jobs to the whole cores in cpuQuota (microseconds
// per 100ms period; 0 = no CPU cap), and never below one.
func CapJobs(n int, cpuQuota int64) int {
	if cpuQuota > 0 {
		if cores := int(cpuQuota / 100000); n > cores {
			n = cores
		}
	}
	return max(n, 1)
}

var PerfCustom = &PerfProfile{ID: "custom", Name: "Custom", Description: "Use the CPU, memory and parallelism settings as set"}

var PerfProfiles = []*PerfProfile{
	{ID: PerfFull, Name: "Full", Description: "No limits"},
	{ID: "balanced", Name: "Balanced", Description: "3 at a time, up to 75% of CPU and 60% of memory, lower priority", Parallel: 3, CPUPercent: 75, MemPercent: 60, Nice: 10},
	{ID: "gentle", Name: "Gentle", Description: "1-2 at a time, up to 40% of CPU and 25% of memory, lowest priority", Parallel: 2, CPUPercent: 40, MemPercent: 25, Nice: 19},
}

func GetPerfProfile(id string) *PerfProfile {
	if id == PerfCustom.ID {
		return PerfCustom
	}
	for _, p := range PerfProfiles {
		if p.ID == id {
			return p
		}
	}
	return nil
}

// Resolve turns a preset into concrete limits for this machine. "full" clears
// every limit; "custom" returns the caller's current values unchanged.
func (p *PerfProfile) Resolve(cur PerfLimits) PerfLimits {
	return p.resolve(cur, runtime.NumCPU(), totalMemoryBytes())
}

func (p *PerfProfile) resolve(cur PerfLimits, cpus int, memBytes int64) PerfLimits {
	if p.ID == PerfFull {
		return PerfLimits{Parallelism: cur.Parallelism}
	}
	if p.CPUPercent == 0 && p.MemPercent == 0 && p.Parallel == 0 && p.Nice == 0 {
		return cur
	}
	out := cur
	if p.Parallel > 0 && (out.Parallelism == 0 || out.Parallelism > p.Parallel) {
		out.Parallelism = p.Parallel
	}
	if p.CPUPercent > 0 {
		out.CPUQuota = int64(cpus) * int64(p.CPUPercent) * 1000
		if out.CPUQuota < 100000 {
			out.CPUQuota = 100000
		}
	}
	if p.MemPercent > 0 && memBytes > 0 {
		out.MemoryLimit = memBytes * int64(p.MemPercent) / 100
	}
	out.Nice = p.Nice
	return out
}

func totalMemoryBytes() int64 {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if rest, ok := strings.CutPrefix(sc.Text(), "MemTotal:"); ok {
			fields := strings.Fields(rest)
			if len(fields) > 0 {
				if kb, err := strconv.ParseInt(fields[0], 10, 64); err == nil {
					return kb * 1024
				}
			}
		}
	}
	return 0
}
