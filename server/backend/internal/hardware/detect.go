package hardware

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type CPU struct {
	Model   string `json:"model"`
	Cores   int    `json:"cores"`
	Threads int    `json:"threads"`
}

type RAM struct {
	TotalGB     float64 `json:"total_gb"`
	AvailableGB float64 `json:"available_gb"`
}

type Disk struct {
	TotalGB     int64 `json:"total_gb"`
	AvailableGB int64 `json:"available_gb"`
}

type GPU struct {
	Description string `json:"description"`
}

type Network struct {
	Interfaces []string `json:"interfaces"`
}

type Virtualization struct {
	Vendor string `json:"vendor"`
	Type   string `json:"type"`
}

type OS struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	Kernel  string `json:"kernel"`
}

type HardwareInfo struct {
	CPU            CPU            `json:"cpu"`
	RAM            RAM            `json:"ram"`
	Disk           Disk           `json:"disk"`
	GPU            GPU            `json:"gpu"`
	Network        Network        `json:"network"`
	Virtualization Virtualization `json:"virtualization"`
	OS             OS             `json:"os"`
	MeetsMinimums  bool           `json:"meets_minimums"`
}

const (
	MinCPUCores = 2
	MinRAMGB    = 2
	MinDiskGB   = 16
)

func Detect() (*HardwareInfo, error) {
	info := &HardwareInfo{}

	info.CPU = detectCPU()
	info.RAM = detectRAM()
	info.Disk = detectDisk()
	info.GPU = detectGPU()
	info.Network = detectNetwork()
	info.Virtualization = detectVirt()
	info.OS = detectOS()

	info.MeetsMinimums = info.CPU.Cores >= MinCPUCores &&
		info.RAM.TotalGB >= MinRAMGB &&
		info.Disk.TotalGB >= MinDiskGB

	return info, nil
}

func detectCPU() CPU {
	cpu := CPU{
		Cores:   runtime.NumCPU(),
		Threads: runtime.NumCPU(),
	}

	if data, err := os.ReadFile("/proc/cpuinfo"); err == nil {
		scanner := bufio.NewScanner(bytes.NewReader(data))
		for scanner.Scan() {
			line := scanner.Text()
			if strings.HasPrefix(line, "model name") {
				parts := strings.SplitN(line, ":", 2)
				if len(parts) == 2 {
					cpu.Model = strings.TrimSpace(parts[1])
				}
			}
		}
	}

	if cpu.Model == "" {
		if output, err := exec.Command("lscpu", "-m").Output(); err == nil {
			lines := strings.Split(strings.TrimSpace(string(output)), "\n")
			if len(lines) > 0 {
				parts := strings.Fields(lines[0])
				if len(parts) > 1 {
					cpu.Model = strings.Join(parts[1:], " ")
				}
			}
		}
	}

	if data, err := os.ReadFile("/proc/cpuinfo"); err == nil {
		re := regexp.MustCompile(`(?m)^processor\s*:\s*(\d+)`)
		matches := re.FindAllStringSubmatch(string(data), -1)
		if len(matches) > 0 {
			lastIdx, _ := strconv.Atoi(matches[len(matches)-1][1])
			cpu.Cores = lastIdx + 1
			cpu.Threads = cpu.Cores
		}
	}

	return cpu
}

func detectRAM() RAM {
	ram := RAM{}

	if data, err := os.ReadFile("/proc/meminfo"); err == nil {
		scanner := bufio.NewScanner(bytes.NewReader(data))
		for scanner.Scan() {
			line := scanner.Text()
			if strings.HasPrefix(line, "MemTotal") {
				ram.TotalGB = parseMeminfoLine(line)
			} else if strings.HasPrefix(line, "MemAvailable") {
				ram.AvailableGB = parseMeminfoLine(line)
			}
		}
	}

	return ram
}

func parseMeminfoLine(line string) float64 {
	fields := strings.Fields(line)
	if len(fields) >= 2 {
		if val, err := strconv.ParseUint(fields[1], 10, 64); err == nil {
			return float64(val) / 1024 / 1024
		}
	}
	return 0
}

func detectDisk() Disk {
	disk := Disk{}

	stat := &syscall.Statfs_t{}
	if err := syscall.Statfs("/", stat); err == nil {
		disk.TotalGB = int64(stat.Blocks) * int64(stat.Bsize) / 1024 / 1024 / 1024
		disk.AvailableGB = int64(stat.Bavail) * int64(stat.Bsize) / 1024 / 1024 / 1024
	}

	return disk
}

func detectGPU() GPU {
	gpu := GPU{}

	if output, err := exec.Command("lspci").Output(); err == nil {
		re := regexp.MustCompile(`(?i)(?:VGA|Graphics|Display).*`)
		for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
			if re.MatchString(line) {
				gpu.Description = strings.TrimSpace(line)
				break
			}
		}
	}

	if gpu.Description == "" {
		if files, err := filepath.Glob("/sys/class/drm/card*/device/uevent"); err == nil && len(files) > 0 {
			if data, err := os.ReadFile(files[0]); err == nil {
				for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
					if strings.HasPrefix(line, "PRODUCT_NAME") {
						parts := strings.SplitN(line, "=", 2)
						if len(parts) == 2 {
							gpu.Description = strings.TrimSpace(parts[1])
							break
						}
					}
				}
			}
		}
	}

	return gpu
}

func detectNetwork() Network {
	net := Network{}

	if data, err := os.ReadFile("/proc/net/dev"); err == nil {
		re := regexp.MustCompile(`^\s*(\w+):`)
		scanner := bufio.NewScanner(bytes.NewReader(data))
		for scanner.Scan() {
			line := scanner.Text()
			if match := re.FindStringSubmatch(line); match != nil {
				iface := match[1]
				if iface != "lo" {
					net.Interfaces = append(net.Interfaces, iface)
				}
			}
		}
	}

	return net
}

func detectVirt() Virtualization {
	virt := Virtualization{}

	if data, err := os.ReadFile("/sys/class/dmi/sys/vendor"); err == nil {
		virt.Vendor = strings.TrimSpace(string(data))
	}

	if output, err := exec.Command("systemd-detect-virt").Output(); err == nil {
		virt.Type = strings.TrimSpace(string(output))
	}

	if virt.Type == "" {
		if data, err := os.ReadFile("/proc/1/cgroup"); err == nil {
			content := string(data)
			if strings.Contains(content, "docker") {
				virt.Type = "docker"
			} else if strings.Contains(content, "lxc") {
				virt.Type = "lxc"
			}
		}
	}

	return virt
}

func detectOS() OS {
	osInfo := OS{}
	osInfo.Kernel = runtime.GOOS + "/" + runtime.GOARCH

	if data, err := os.ReadFile("/proc/version"); err == nil {
		osInfo.Kernel = strings.TrimSpace(string(data))
	}

	if data, err := os.ReadFile("/etc/os-release"); err == nil {
		scanner := bufio.NewScanner(bytes.NewReader(data))
		for scanner.Scan() {
			line := scanner.Text()
			if strings.HasPrefix(line, "PRETTY_NAME") {
				parts := strings.SplitN(line, "=", 2)
				if len(parts) == 2 {
					osInfo.Name = strings.TrimSpace(parts[1])
				}
			} else if strings.HasPrefix(line, "VERSION") {
				parts := strings.SplitN(line, "=", 2)
				if len(parts) == 2 {
					osInfo.Version = strings.TrimSpace(parts[1])
				}
			}
		}
	}

	if osInfo.Name == "" {
		if uname, err := exec.Command("uname", "-sro").Output(); err == nil {
			osInfo.Name = strings.TrimSpace(string(uname))
		}
	}

	return osInfo
}

func GenerateReport() (string, error) {
	info, err := Detect()
	if err != nil {
		return "", fmt.Errorf("failed to detect hardware: %w", err)
	}

	var buf bytes.Buffer
	buf.WriteString("LibreServ Hardware Report\n")
	buf.WriteString("==========================\n")
	buf.WriteString(fmt.Sprintf("Generated: %s\n", time.Now().Format(time.RFC3339)))
	buf.WriteString(fmt.Sprintf("Hostname: %s\n", getHostname()))
	buf.WriteString("\n")

	buf.WriteString("=== CPU ===\n")
	buf.WriteString(fmt.Sprintf("  Model: %s\n", info.CPU.Model))
	buf.WriteString(fmt.Sprintf("  Cores: %d\n", info.CPU.Cores))
	buf.WriteString(fmt.Sprintf("  Threads: %d\n", info.CPU.Threads))
	buf.WriteString("\n")

	buf.WriteString("=== RAM ===\n")
	buf.WriteString(fmt.Sprintf("  Total: %.2f GB\n", info.RAM.TotalGB))
	buf.WriteString(fmt.Sprintf("  Available: %.2f GB\n", info.RAM.AvailableGB))
	buf.WriteString("\n")

	buf.WriteString("=== Disk ===\n")
	buf.WriteString(fmt.Sprintf("  Total: %d GB\n", info.Disk.TotalGB))
	buf.WriteString(fmt.Sprintf("  Available: %d GB\n", info.Disk.AvailableGB))
	buf.WriteString("\n")

	buf.WriteString("=== GPU ===\n")
	if info.GPU.Description != "" {
		buf.WriteString(fmt.Sprintf("  %s\n", info.GPU.Description))
	} else {
		buf.WriteString("  No GPU detected\n")
	}
	buf.WriteString("\n")

	buf.WriteString("=== Network ===\n")
	for _, iface := range info.Network.Interfaces {
		buf.WriteString(fmt.Sprintf("  %s\n", iface))
	}
	buf.WriteString("\n")

	buf.WriteString("=== Virtualization ===\n")
	buf.WriteString(fmt.Sprintf("  Vendor: %s\n", info.Virtualization.Vendor))
	buf.WriteString(fmt.Sprintf("  Type: %s\n", info.Virtualization.Type))
	buf.WriteString("\n")

	buf.WriteString("=== Operating System ===\n")
	buf.WriteString(fmt.Sprintf("  Name: %s\n", info.OS.Name))
	buf.WriteString(fmt.Sprintf("  Version: %s\n", info.OS.Version))
	buf.WriteString(fmt.Sprintf("  Kernel: %s\n", info.OS.Kernel))
	buf.WriteString("\n")

	buf.WriteString("=== Minimum Requirements ===\n")
	if info.MeetsMinimums {
		buf.WriteString("  All requirements met!\n")
	} else {
		buf.WriteString("  WARNING: Below minimum requirements\n")
	}

	return buf.String(), nil
}

func getHostname() string {
	hostname, err := os.Hostname()
	if err != nil {
		return "unknown"
	}
	return hostname
}
