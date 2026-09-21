package podman

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/runtime"
)

// podmanContainer matches the JSON output of `podman ps --format json`.
type podmanContainer struct {
	Id     string            `json:"Id"`
	Names  []string          `json:"Names"`
	Image  string            `json:"Image"`
	State  string            `json:"State"`
	Status string            `json:"Status"`
	Labels map[string]string `json:"Labels"`
}

// podmanInspectResult matches the JSON output of `podman inspect`.
type podmanInspectResult struct {
	Id     string       `json:"Id"`
	Name   string       `json:"Name"`
	Config podmanConfig `json:"Config"`
	State  podmanState  `json:"State"`
}

// podmanConfig matches a subset of `podman inspect` Config.
type podmanConfig struct {
	Tty bool `json:"Tty"`
}

// podmanState matches a subset of `podman inspect` State.
type podmanState struct {
	Status     string `json:"Status"`
	Running    bool   `json:"Running"`
	Paused     bool   `json:"Paused"`
	Restarting bool   `json:"Restarting"`
	OOMKilled  bool   `json:"OOMKilled"`
	Dead       bool   `json:"Dead"`
	Pid        int    `json:"Pid"`
	ExitCode   int    `json:"ExitCode"`
	Error      string `json:"Error"`
	StartedAt  string `json:"StartedAt"`
	FinishedAt string `json:"FinishedAt"`
}

// podmanStatsResult matches the JSON output of `podman stats --no-stream --format json`.
type podmanStatsResult struct {
	Id         string `json:"id"`
	Name       string `json:"name"`
	CPUPercent string `json:"cpu_percent"`
	MemUsage   string `json:"mem_usage"`
	BlockIO    string `json:"block_io"`
	NetIO      string `json:"net_io"`
}

// runtimeBinary returns the configured runtime binary (podman by default).
func (c *Client) runtimeBinary() string {
	if c == nil || c.binary == "" {
		return "podman"
	}
	return c.binary
}

// listContainers runs `podman ps -a` with the given extra filter args and
// parses the JSON output into runtime container info.
func (c *Client) listContainers(ctx context.Context, filterArgs ...string) ([]runtime.ContainerInfo, error) {
	args := append([]string{"ps", "-a"}, filterArgs...)
	args = append(args, "--format", "json")
	cmd := exec.CommandContext(ctx, c.runtimeBinary(), args...)
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("podman ps failed: %w", err)
	}

	var containers []podmanContainer
	if len(out) == 0 || string(out) == "[]\n" {
		return nil, nil
	}
	if err := json.Unmarshal(out, &containers); err != nil {
		return nil, err
	}

	var result []runtime.ContainerInfo
	for _, pc := range containers {
		result = append(result, runtime.ContainerInfo{
			ID:     pc.Id,
			Names:  pc.Names,
			Image:  pc.Image,
			State:  pc.State,
			Status: pc.Status,
			Labels: pc.Labels,
		})
	}
	return result, nil
}

// ListContainersByLabel returns containers matching a label selector using the Podman CLI.
func (c *Client) ListContainersByLabel(ctx context.Context, label string) ([]runtime.ContainerInfo, error) {
	return c.listContainers(ctx, "--filter", "label="+label)
}

// ListContainersAll returns all containers (running and stopped) using the Podman CLI.
func (c *Client) ListContainersAll(ctx context.Context) ([]runtime.ContainerInfo, error) {
	return c.listContainers(ctx)
}

// GetContainerStats retrieves real-time stats using the Podman CLI.
func (c *Client) GetContainerStats(ctx context.Context, containerID string) (*runtime.ContainerStats, error) {
	args := []string{"stats", "--no-stream", "--format", "json", containerID}
	cmd := exec.CommandContext(ctx, c.runtimeBinary(), args...)
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("podman stats failed: %w", err)
	}

	var statsResults []podmanStatsResult
	if err := json.Unmarshal(out, &statsResults); err != nil {
		return nil, err
	}
	if len(statsResults) == 0 {
		return nil, errors.New("no stats returned")
	}

	r := statsResults[0]
	cpuPct, err := parsePercent(r.CPUPercent)
	if err != nil {
		cpuPct = 0
	}

	memUsage, memLimit, _ := parseMemUsage(r.MemUsage)
	_, _, netRx, netTx := parseNetIO(r.NetIO)

	return &runtime.ContainerStats{
		CPUPercent:  cpuPct,
		MemoryUsage: memUsage,
		MemoryLimit: memLimit,
		NetworkRx:   netRx,
		NetworkTx:   netTx,
	}, nil
}

// InspectContainer returns detailed information about a container using the Podman CLI.
func (c *Client) InspectContainer(ctx context.Context, containerID string) (*runtime.ContainerInspectResult, error) {
	args := []string{"inspect", containerID}
	cmd := exec.CommandContext(ctx, c.runtimeBinary(), args...)
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("podman inspect failed: %w", err)
	}

	var result []podmanInspectResult
	if err := json.Unmarshal(out, &result); err != nil {
		return nil, err
	}
	if len(result) == 0 {
		return nil, errors.New("no inspect result returned")
	}

	ins := result[0]
	return &runtime.ContainerInspectResult{
		ID:   ins.Id,
		Name: ins.Name,
		TTY:  ins.Config.Tty,
		State: runtime.ContainerState{
			Running:     ins.State.Running,
			Paused:      ins.State.Paused,
			Restarting:  ins.State.Restarting,
			OOMKilled:   ins.State.OOMKilled,
			Dead:        ins.State.Dead,
			Pid:         ins.State.Pid,
			ExitCode:    ins.State.ExitCode,
			Error:       ins.State.Error,
			StartedAt:   ins.State.StartedAt,
			FinishedAt:  ins.State.FinishedAt,
			HealthState: "",
		},
		Raw: out,
	}, nil
}

// ContainerLogs retrieves logs from a container using the Podman CLI.
func (c *Client) ContainerLogs(ctx context.Context, containerID string, options runtime.LogOptions) (io.ReadCloser, error) {
	args := []string{"logs", containerID}
	if options.Follow {
		args = append(args, "--follow")
	}
	if options.Tail != "" && options.Tail != "all" {
		args = append(args, "--tail", options.Tail)
	}

	cmd := exec.CommandContext(ctx, c.runtimeBinary(), args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}

	if err := cmd.Start(); err != nil {
		return nil, err
	}

	// Combine stdout and stderr into a single ReadCloser.
	pr, pw := io.Pipe()
	go func() {
		_, _ = io.Copy(pw, stdout)
		_ = stdout.Close()
		_, _ = io.Copy(pw, stderr)
		_ = stderr.Close()
		_ = cmd.Wait()
		_ = pw.Close()
	}()
	return pr, nil
}

// RestartContainer restarts a container using the Podman CLI.
func (c *Client) RestartContainer(ctx context.Context, containerID string, timeout time.Duration) error {
	secs := strconv.Itoa(int(timeout.Seconds()))
	args := []string{"restart", "-t", secs, containerID}
	cmd := exec.CommandContext(ctx, c.runtimeBinary(), args...)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("podman restart failed: %w (output: %s)", err, string(out))
	}
	return nil
}

// StopContainer stops a running container using the Podman CLI.
func (c *Client) StopContainer(ctx context.Context, containerID string) error {
	args := []string{"stop", containerID}
	cmd := exec.CommandContext(ctx, c.runtimeBinary(), args...)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("podman stop failed: %w (output: %s)", err, string(out))
	}
	return nil
}

// StartContainer starts a stopped container using the Podman CLI.
func (c *Client) StartContainer(ctx context.Context, containerID string) error {
	args := []string{"start", containerID}
	cmd := exec.CommandContext(ctx, c.runtimeBinary(), args...)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("podman start failed: %w (output: %s)", err, string(out))
	}
	return nil
}

// --- helpers ---

func parsePercent(s string) (float64, error) {
	s = strings.TrimSpace(s)
	s = strings.TrimSuffix(s, "%")
	return strconv.ParseFloat(s, 64)
}

func parseMemUsage(s string) (usage uint64, limit uint64, ok bool) {
	parts := strings.Split(s, " / ")
	if len(parts) != 2 {
		return 0, 0, false
	}
	u, err1 := parseByteSize(strings.TrimSpace(parts[0]))
	l, err2 := parseByteSize(strings.TrimSpace(parts[1]))
	return u, l, err1 == nil && err2 == nil
}

func parseNetIO(s string) (txStr string, rxStr string, tx uint64, rx uint64) {
	parts := strings.Split(s, " / ")
	if len(parts) != 2 {
		return "", "", 0, 0
	}
	txStr = strings.TrimSpace(parts[0])
	rxStr = strings.TrimSpace(parts[1])
	txVal, _ := parseByteSize(txStr)
	rxVal, _ := parseByteSize(rxStr)
	return txStr, rxStr, txVal, rxVal
}

func parseByteSize(s string) (uint64, error) {
	s = strings.TrimSpace(s)
	s = strings.ReplaceAll(s, ",", "")
	if len(s) == 0 {
		return 0, nil
	}
	mult := float64(1)
	for _, unit := range []struct {
		suffix string
		mult   float64
	}{
		{"TB", 1e12}, {"GB", 1e9}, {"MB", 1e6}, {"kB", 1e3},
		{"T", 1e12}, {"G", 1e9}, {"M", 1e6}, {"K", 1e3},
	} {
		if strings.HasSuffix(s, unit.suffix) {
			mult = unit.mult
			s = strings.TrimSuffix(s, unit.suffix)
			break
		}
	}
	f, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		return 0, err
	}
	return uint64(f * mult), nil
}
