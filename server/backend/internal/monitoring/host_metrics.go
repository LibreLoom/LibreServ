package monitoring

import (
	"bufio"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
)

const (
	baselineBytesPerSecondContainer = 1024 * 1024 // 1 MB/s ~= high container network utilization
	baselineBytesPerSecondHost      = 256 * 1024  // 256 KB/s ~= high host network utilization
)

type HostMetricsCollector struct {
	cpuMu        sync.Mutex
	lastCPUIdle  uint64
	lastCPUTotal uint64
	cpuPrimed    bool

	netMu            sync.Mutex
	lastNetBytes     uint64
	lastNetAt        time.Time
	lastHostNetBytes uint64
	lastHostNetAt    time.Time
}

func NewHostMetricsCollector() *HostMetricsCollector {
	return &HostMetricsCollector{}
}

func (h *HostMetricsCollector) HostCPU() float64 {
	total, idle, ok := readProcStatCPU()
	if !ok {
		return 0
	}

	h.cpuMu.Lock()
	defer h.cpuMu.Unlock()

	if !h.cpuPrimed {
		h.lastCPUTotal = total
		h.lastCPUIdle = idle
		h.cpuPrimed = true
		return 0
	}

	totalDelta := total - h.lastCPUTotal
	idleDelta := idle - h.lastCPUIdle
	h.lastCPUTotal = total
	h.lastCPUIdle = idle

	if totalDelta == 0 || idleDelta > totalDelta {
		return 0
	}

	activeDelta := totalDelta - idleDelta
	return clamp01(float64(activeDelta) / float64(totalDelta))
}

func (h *HostMetricsCollector) HostCPULoad() float64 {
	data, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return 0
	}
	parts := strings.Fields(string(data))
	if len(parts) == 0 {
		return 0
	}
	load1, err := strconv.ParseFloat(parts[0], 64)
	if err != nil {
		return 0
	}
	cpus := float64(runtime.NumCPU())
	if cpus <= 0 {
		return 0
	}
	return clamp01(load1 / cpus)
}

func (h *HostMetricsCollector) HostMemory() float64 {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0
	}
	defer f.Close()

	var totalKB uint64
	var availKB uint64

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		switch fields[0] {
		case "MemTotal:":
			v, err := strconv.ParseUint(fields[1], 10, 64)
			if err == nil {
				totalKB = v
			}
		case "MemAvailable:":
			v, err := strconv.ParseUint(fields[1], 10, 64)
			if err == nil {
				availKB = v
			}
		}
	}

	if totalKB == 0 {
		return 0
	}
	if availKB > totalKB {
		availKB = totalKB
	}
	usedKB := totalKB - availKB
	return clamp01(float64(usedKB) / float64(totalKB))
}

func (h *HostMetricsCollector) DiskUsage(dataPath string) (total, free uint64) {
	resolvedPath, err := resolveConfigPath(dataPath)
	if err != nil {
		resolvedPath = dataPath
	}

	tryPaths := []string{resolvedPath}
	if dataPath != "/" {
		tryPaths = append(tryPaths, "/")
	}

	for _, p := range tryPaths {
		if p == "" {
			continue
		}
		var stat syscall.Statfs_t
		if err := syscall.Statfs(p, &stat); err != nil {
			continue
		}
		total = stat.Blocks * uint64(stat.Bsize)
		free = stat.Bavail * uint64(stat.Bsize)
		return total, free
	}

	return total, free
}

func (h *HostMetricsCollector) NetworkLoad(totalBytes uint64, now time.Time) float64 {
	h.netMu.Lock()
	defer h.netMu.Unlock()

	if h.lastNetAt.IsZero() {
		h.lastNetAt = now
		h.lastNetBytes = totalBytes
		return 0
	}

	elapsed := now.Sub(h.lastNetAt).Seconds()
	if elapsed <= 0 {
		return 0
	}

	var delta uint64
	if totalBytes >= h.lastNetBytes {
		delta = totalBytes - h.lastNetBytes
	}

	h.lastNetAt = now
	h.lastNetBytes = totalBytes

	return clamp01((float64(delta) / elapsed) / baselineBytesPerSecondContainer)
}

func (h *HostMetricsCollector) HostNetworkLoad(now time.Time) float64 {
	totalBytes, ok := readProcNetDevTotal()
	if !ok {
		return 0
	}

	h.netMu.Lock()
	defer h.netMu.Unlock()

	if h.lastHostNetAt.IsZero() {
		h.lastHostNetAt = now
		h.lastHostNetBytes = totalBytes
		return 0
	}

	elapsed := now.Sub(h.lastHostNetAt).Seconds()
	if elapsed <= 0 {
		return 0
	}

	var delta uint64
	if totalBytes >= h.lastHostNetBytes {
		delta = totalBytes - h.lastHostNetBytes
	}

	h.lastHostNetAt = now
	h.lastHostNetBytes = totalBytes

	return clamp01((float64(delta) / elapsed) / baselineBytesPerSecondHost)
}

func readProcNetDevTotal() (total uint64, ok bool) {
	f, err := os.Open("/proc/net/dev")
	if err != nil {
		return 0, false
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	lineNo := 0
	for scanner.Scan() {
		lineNo++
		if lineNo <= 2 {
			continue
		}
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		parts := strings.Split(line, ":")
		if len(parts) != 2 {
			continue
		}
		iface := strings.TrimSpace(parts[0])
		if iface == "lo" {
			continue
		}
		fields := strings.Fields(parts[1])
		if len(fields) < 16 {
			continue
		}
		rx, err1 := strconv.ParseUint(fields[0], 10, 64)
		tx, err2 := strconv.ParseUint(fields[8], 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		total += rx + tx
	}

	return total, true
}

func readProcStatCPU() (total uint64, idle uint64, ok bool) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return 0, 0, false
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	if !scanner.Scan() {
		return 0, 0, false
	}
	fields := strings.Fields(scanner.Text())
	if len(fields) < 5 || fields[0] != "cpu" {
		return 0, 0, false
	}

	values := make([]uint64, 0, len(fields)-1)
	for _, raw := range fields[1:] {
		v, err := strconv.ParseUint(raw, 10, 64)
		if err != nil {
			return 0, 0, false
		}
		values = append(values, v)
		total += v
	}

	idle = values[3]
	if len(values) > 4 {
		idle += values[4]
	}
	return total, idle, true
}

func resolveConfigPath(path string) (string, error) {
	return config.ResolveConfigPath(path)
}

func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

func maxFloat(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

func normalizeUsage(usage, total uint64) float64 {
	if total == 0 {
		return 0
	}
	return clamp01(float64(usage) / float64(total))
}
