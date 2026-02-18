package runner

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/mount"
	"github.com/docker/docker/client"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/tests"
)

type Runner struct {
	cli               *client.Client
	cfg               *config.Config
	repoPath          string
	outputChan        chan OutputLine
	resultChan        chan *tests.TestResult
	workers           int
	cpuQuota          int64
	memoryLimit       int64
	pullMutex         sync.Mutex
	pulledImages      map[string]bool
	streamManager     *StreamManager
	runningContainers map[string]string
	containersMu      sync.RWMutex
	skippedTests      map[string]bool
	skippedMu         sync.RWMutex
}

type OutputLine struct {
	TestID string
	Line   string
	Type   OutputType
}

type OutputType int

const (
	OutputStdout OutputType = iota
	OutputStderr
	OutputStatus
	OutputError
)

type RunOptions struct {
	TestIDs      []string
	Profile      string
	Parallelism  int
	FuzzDuration time.Duration
	FailFast     bool
	SkipTestChan chan string
	CPUQuota     int64
	MemoryLimit  int64
}

func NewRunner(cfg *config.Config) (*Runner, error) {
	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		return nil, fmt.Errorf("failed to create Docker client: %w", err)
	}

	repoPath, err := findRepoRoot()
	if err != nil {
		return nil, fmt.Errorf("failed to find repo root: %w", err)
	}

	r := &Runner{
		cli:               cli,
		cfg:               cfg,
		repoPath:          repoPath,
		outputChan:        make(chan OutputLine, 1000),
		resultChan:        make(chan *tests.TestResult, 100),
		workers:           cfg.Parallelism,
		pulledImages:      make(map[string]bool),
		streamManager:     NewStreamManager(),
		runningContainers: make(map[string]string),
		skippedTests:      make(map[string]bool),
	}

	r.cleanupOrphanedContainers()

	return r, nil
}

func (r *Runner) cleanupOrphanedContainers() {
	ctx := context.Background()
	containers, err := r.cli.ContainerList(ctx, container.ListOptions{All: true})
	if err != nil {
		return
	}

	for _, c := range containers {
		if c.Labels["libreserv.ci"] == "true" {
			r.cli.ContainerStop(ctx, c.ID, container.StopOptions{Timeout: intPtr(1)})
			r.cli.ContainerRemove(ctx, c.ID, container.RemoveOptions{Force: true})
		}
	}
}

func intPtr(i int) *int {
	return &i
}

func (r *Runner) OutputChan() <-chan OutputLine {
	return r.outputChan
}

func (r *Runner) ResultChan() <-chan *tests.TestResult {
	return r.resultChan
}

func (r *Runner) Run(ctx context.Context, opts RunOptions) *RunSummary {
	r.streamManager.Clear()

	var testList []*tests.Test
	if opts.Profile != "" {
		testList = config.GetTestsForProfile(opts.Profile)
	} else if len(opts.TestIDs) > 0 {
		testList = tests.DefaultRegistry.GetByIDs(opts.TestIDs)
	} else {
		testList = tests.DefaultRegistry.List()
	}

	if opts.Parallelism > 0 {
		r.workers = opts.Parallelism
	}

	// Store resource limits for container creation
	r.cpuQuota = opts.CPUQuota
	r.memoryLimit = opts.MemoryLimit

	summary := &RunSummary{
		StartTime: time.Now(),
		Results:   make(map[string]*tests.TestResult),
	}

	pending := make(chan *tests.Test, len(testList))
	for _, t := range testList {
		pending <- t
	}
	close(pending)

	var wg sync.WaitGroup
	results := make(chan *tests.TestResult, len(testList))
	stopFlag := &atomicBool{}

	workerCount := r.workers
	if workerCount > len(testList) {
		workerCount = len(testList)
	}

	for i := 0; i < workerCount; i++ {
		wg.Add(1)
		go r.worker(ctx, &wg, pending, results, stopFlag, opts.FailFast, opts.FuzzDuration, opts.SkipTestChan)
	}

	go func() {
		wg.Wait()
		close(results)
	}()

	for result := range results {
		summary.Results[result.TestID] = result
		r.resultChan <- result

		if opts.FailFast && result.Status == tests.StatusFailed {
			stopFlag.Set(true)
		}
	}

	summary.EndTime = time.Now()
	summary.Duration = summary.EndTime.Sub(summary.StartTime)
	r.calculateSummaryStats(summary)

	return summary
}

func (r *Runner) worker(
	ctx context.Context,
	wg *sync.WaitGroup,
	pending <-chan *tests.Test,
	results chan<- *tests.TestResult,
	stopFlag *atomicBool,
	failFast bool,
	fuzzDuration time.Duration,
	skipTestChan chan string,
) {
	defer wg.Done()

	for t := range pending {
		if stopFlag.Get() {
			results <- &tests.TestResult{
				TestID:    t.ID,
				Name:      t.Name,
				Status:    tests.StatusSkipped,
				StartTime: time.Now(),
				EndTime:   time.Now(),
			}
			continue
		}

		if r.shouldSkip(t.ID) {
			results <- &tests.TestResult{
				TestID:    t.ID,
				Name:      t.Name,
				Status:    tests.StatusSkipped,
				StartTime: time.Now(),
				EndTime:   time.Now(),
				Error:     "Skipped by user",
			}
			continue
		}

		result := r.runTest(ctx, t, fuzzDuration, skipTestChan)
		results <- result

		if failFast && result.Status == tests.StatusFailed {
			stopFlag.Set(true)
		}
	}
}

func (r *Runner) runTest(ctx context.Context, t *tests.Test, fuzzDuration time.Duration, skipTestChan <-chan string) *tests.TestResult {
	result := &tests.TestResult{
		TestID:    t.ID,
		Name:      t.Name,
		Status:    tests.StatusRunning,
		StartTime: time.Now(),
	}

	r.resultChan <- result

	r.outputChan <- OutputLine{
		TestID: t.ID,
		Type:   OutputStatus,
		Line:   "starting...",
	}

	if err := r.pullImageIfNeeded(ctx, t.Container); err != nil {
		result.Status = tests.StatusFailed
		result.Error = fmt.Sprintf("failed to pull image: %v", err)
		result.EndTime = time.Now()
		result.Duration = result.EndTime.Sub(result.StartTime)
		return result
	}

	containerID, err := r.createContainer(ctx, t, fuzzDuration)
	if err != nil {
		result.Status = tests.StatusFailed
		result.Error = fmt.Sprintf("failed to create container: %v", err)
		result.EndTime = time.Now()
		result.Duration = result.EndTime.Sub(result.StartTime)
		return result
	}
	result.ContainerID = containerID

	r.containersMu.Lock()
	r.runningContainers[t.ID] = containerID
	r.containersMu.Unlock()

	defer func() {
		r.containersMu.Lock()
		delete(r.runningContainers, t.ID)
		r.containersMu.Unlock()
		r.cleanupContainer(ctx, containerID)
	}()

	if err := r.cli.ContainerStart(ctx, containerID, container.StartOptions{}); err != nil {
		result.Status = tests.StatusFailed
		result.Error = fmt.Sprintf("failed to start container: %v", err)
		result.EndTime = time.Now()
		result.Duration = result.EndTime.Sub(result.StartTime)
		return result
	}

	outputDone := make(chan struct{})
	go r.streamOutput(ctx, containerID, t.ID, outputDone)

	// Apply test timeout if configured
	testCtx := ctx
	if t.Timeout > 0 {
		var cancel context.CancelFunc
		testCtx, cancel = context.WithTimeout(ctx, t.Timeout)
		defer cancel()
	}

	skipRequested := make(chan struct{})
	if skipTestChan != nil {
		go func() {
			for {
				select {
				case sid := <-skipTestChan:
					if sid == t.ID || sid == "*" {
						close(skipRequested)
						r.cleanupContainer(ctx, containerID)
						return
					}
					// Signal for different test - mark it as skipped
					if sid != "" {
						r.markSkipped(sid)
					}
				case <-ctx.Done():
					return
				}
			}
		}()
	}

	waitCh, errCh := r.cli.ContainerWait(testCtx, containerID, container.WaitConditionNotRunning)

	var exitCode int64
	containerExited := make(chan struct{})
	go func() {
		select {
		case waitResp := <-waitCh:
			exitCode = waitResp.StatusCode
		case err := <-errCh:
			r.outputChan <- OutputLine{
				TestID: t.ID,
				Type:   OutputError,
				Line:   fmt.Sprintf("container wait error: %v", err),
			}
			exitCode = 1
		case <-ctx.Done():
			r.outputChan <- OutputLine{
				TestID: t.ID,
				Type:   OutputError,
				Line:   "context cancelled",
			}
			exitCode = 1
		}
		close(containerExited)
	}()

	checkSkipTicker := time.NewTicker(100 * time.Millisecond)
	defer checkSkipTicker.Stop()

waitLoop:
	for {
		select {
		case <-containerExited:
			break waitLoop
		case <-skipRequested:
			r.outputChan <- OutputLine{
				TestID: t.ID,
				Type:   OutputStatus,
				Line:   "halting...",
			}
			result.Status = tests.StatusHalting

			r.forceStopContainer(ctx, containerID)
			r.waitForContainerStopped(ctx, containerID)

			r.resultChan <- result

			r.outputChan <- OutputLine{
				TestID: t.ID,
				Type:   OutputStatus,
				Line:   "skipped",
			}

			select {
			case <-outputDone:
			case <-time.After(1 * time.Second):
			}
			r.fetchRemainingLogs(ctx, containerID, t.ID)
			result.Status = tests.StatusSkipped
			result.Error = "Skipped by user"
			result.EndTime = time.Now()
			result.Duration = result.EndTime.Sub(result.StartTime)
			result.ExitCode = -1
			return result
		case <-checkSkipTicker.C:
			if r.shouldSkip(t.ID) {
				r.outputChan <- OutputLine{
					TestID: t.ID,
					Type:   OutputStatus,
					Line:   "halting...",
				}
				result.Status = tests.StatusHalting

				r.forceStopContainer(ctx, containerID)
				r.waitForContainerStopped(ctx, containerID)

				r.resultChan <- result

				r.outputChan <- OutputLine{
					TestID: t.ID,
					Type:   OutputStatus,
					Line:   "skipped",
				}

				select {
				case <-outputDone:
				case <-time.After(1 * time.Second):
				}
				r.fetchRemainingLogs(ctx, containerID, t.ID)
				result.Status = tests.StatusSkipped
				result.Error = "Skipped by user"
				result.EndTime = time.Now()
				result.Duration = result.EndTime.Sub(result.StartTime)
				result.ExitCode = -1
				return result
			}
		}
	}

	// Wait for log stream to finish (with timeout for slow flushes like race detection)
	select {
	case <-outputDone:
	case <-time.After(2 * time.Second):
	}

	// Also fetch any remaining logs after container stops
	r.fetchRemainingLogs(ctx, containerID, t.ID)

	// Check if skip was requested while container was exiting
	if r.shouldSkip(t.ID) {
		result.Status = tests.StatusSkipped
		result.Error = "Skipped by user"
		result.EndTime = time.Now()
		result.Duration = result.EndTime.Sub(result.StartTime)
		result.ExitCode = -1
		result.Output = r.streamManager.GetOutput(t.ID)
		return result
	}

	result.ExitCode = int(exitCode)
	result.EndTime = time.Now()
	result.Duration = result.EndTime.Sub(result.StartTime)

	if exitCode == 0 {
		result.Status = tests.StatusPassed
	} else {
		result.Status = tests.StatusFailed
	}

	result.Output = r.streamManager.GetOutput(t.ID)

	return result
}

func (r *Runner) pullImageIfNeeded(ctx context.Context, imageRef string) error {
	r.pullMutex.Lock()
	defer r.pullMutex.Unlock()

	if r.pulledImages[imageRef] {
		return nil
	}

	r.outputChan <- OutputLine{
		TestID: "",
		Type:   OutputStatus,
		Line:   fmt.Sprintf("pulling image %s...", imageRef),
	}

	reader, err := r.cli.ImagePull(ctx, imageRef, image.PullOptions{})
	if err != nil {
		return err
	}
	defer reader.Close()

	io.Copy(io.Discard, reader)

	r.pulledImages[imageRef] = true
	return nil
}

func (r *Runner) createContainer(ctx context.Context, t *tests.Test, fuzzDuration time.Duration) (string, error) {
	env := make([]string, len(t.Env))
	copy(env, t.Env)

	if t.Type == tests.TestTypeFuzz && fuzzDuration > 0 {
		env = append(env, fmt.Sprintf("FUZZ_DURATION=%s", fuzzDuration))
	}

	cacheDir := filepath.Join(r.repoPath, ".cache")
	os.MkdirAll(cacheDir, 0755)

	testCacheDir := filepath.Join(cacheDir, "test-"+t.ID)
	os.MkdirAll(testCacheDir, 0755)

	mounts := []mount.Mount{
		{
			Type:   mount.TypeBind,
			Source: r.repoPath,
			Target: "/repo",
		},
		{
			Type:   mount.TypeBind,
			Source: cacheDir,
			Target: "/cache",
		},
	}

	if t.ID == "frontend-lint" || t.ID == "frontend-build" || t.ID == "frontend-colors" {
		nodeModulesCache := filepath.Join(testCacheDir, "node_modules")
		os.MkdirAll(nodeModulesCache, 0755)
		mounts = append(mounts, mount.Mount{
			Type:   mount.TypeBind,
			Source: nodeModulesCache,
			Target: "/repo/server/frontend/node_modules",
		})
		npmCache := filepath.Join(testCacheDir, "npm")
		os.MkdirAll(npmCache, 0755)
		env = append(env, "NPM_CONFIG_CACHE="+npmCache)
	}

	if t.Type == tests.TestTypeIntegration && t.ID == "docker-build" {
		mounts = append(mounts, mount.Mount{
			Type:   mount.TypeBind,
			Source: "/var/run/docker.sock",
			Target: "/var/run/docker.sock",
		})
	}

	if t.Type == tests.TestTypeE2E {
		mounts = append(mounts, mount.Mount{
			Type:   mount.TypeBind,
			Source: "/var/run/docker.sock",
			Target: "/var/run/docker.sock",
		})
	}

	config := &container.Config{
		Image:      t.Container,
		Cmd:        []string{"sh", "-c", t.Command},
		WorkingDir: t.WorkDir,
		Env:        env,
		Tty:        false,
		Labels:     map[string]string{"libreserv.ci": "true"},
	}

	hostConfig := &container.HostConfig{
		Mounts: mounts,
	}

	if t.Type == tests.TestTypeE2E {
		hostConfig.ExtraHosts = []string{"host.docker.internal:host-gateway"}
	}

	// Apply resource limits if configured
	if r.cpuQuota > 0 {
		hostConfig.CPUQuota = r.cpuQuota
		hostConfig.CPUPeriod = 100000 // Default period (100ms)
	}
	if r.memoryLimit > 0 {
		hostConfig.Memory = r.memoryLimit
	}

	resp, err := r.cli.ContainerCreate(ctx, config, hostConfig, nil, nil, "")
	if err != nil {
		return "", err
	}

	return resp.ID, nil
}

func (r *Runner) streamOutput(ctx context.Context, containerID, testID string, done chan struct{}) {
	defer close(done)

	options := container.LogsOptions{
		ShowStdout: true,
		ShowStderr: true,
		Follow:     true,
		Timestamps: false,
	}

	reader, err := r.cli.ContainerLogs(ctx, containerID, options)
	if err != nil {
		r.outputChan <- OutputLine{
			TestID: testID,
			Type:   OutputError,
			Line:   fmt.Sprintf("failed to get logs: %v", err),
		}
		return
	}
	defer reader.Close()

	// Accumulate partial data across reads
	var buffer []byte
	buf := make([]byte, 4096)

	for {
		n, err := reader.Read(buf)
		if n > 0 {
			buffer = append(buffer, buf[:n]...)

			// Parse complete frames from buffer
			for len(buffer) >= 8 {
				// Docker log format: [stream_type(1), padding(3), length(4)] followed by payload
				header := buffer[:8]
				payloadLen := int(header[4])<<24 | int(header[5])<<16 | int(header[6])<<8 | int(header[7])

				if len(buffer) < 8+payloadLen {
					// Not enough data yet, wait for more
					break
				}

				payload := buffer[8 : 8+payloadLen]
				lines := strings.Split(string(payload), "\n")
				for _, line := range lines {
					if line != "" {
						r.streamManager.AddLine(testID, line)
						r.outputChan <- OutputLine{
							TestID: testID,
							Type:   OutputStdout,
							Line:   line,
						}
					}
				}
				buffer = buffer[8+payloadLen:]
			}
		}
		if err != nil {
			break
		}
	}

	// Small delay to ensure any final log data is processed
	time.Sleep(100 * time.Millisecond)

	// Process any remaining data in buffer
	for len(buffer) >= 8 {
		header := buffer[:8]
		payloadLen := int(header[4])<<24 | int(header[5])<<16 | int(header[6])<<8 | int(header[7])
		if len(buffer) < 8+payloadLen {
			break
		}
		payload := buffer[8 : 8+payloadLen]
		lines := strings.Split(string(payload), "\n")
		for _, line := range lines {
			if line != "" {
				r.streamManager.AddLine(testID, line)
				r.outputChan <- OutputLine{
					TestID: testID,
					Type:   OutputStdout,
					Line:   line,
				}
			}
		}
		buffer = buffer[8+payloadLen:]
	}
}

func (r *Runner) fetchRemainingLogs(ctx context.Context, containerID, testID string) {
	options := container.LogsOptions{
		ShowStdout: true,
		ShowStderr: true,
		Follow:     false,
		Timestamps: false,
	}

	reader, err := r.cli.ContainerLogs(ctx, containerID, options)
	if err != nil {
		return
	}
	defer reader.Close()

	var buffer []byte
	buf := make([]byte, 4096)

	for {
		n, err := reader.Read(buf)
		if n > 0 {
			buffer = append(buffer, buf[:n]...)

			// Parse complete frames from buffer
			for len(buffer) >= 8 {
				header := buffer[:8]
				payloadLen := int(header[4])<<24 | int(header[5])<<16 | int(header[6])<<8 | int(header[7])

				if len(buffer) < 8+payloadLen {
					break
				}

				payload := buffer[8 : 8+payloadLen]
				lines := strings.Split(string(payload), "\n")
				for _, line := range lines {
					if line != "" {
						r.streamManager.AddLine(testID, line)
					}
				}
				buffer = buffer[8+payloadLen:]
			}
		}
		if err != nil {
			break
		}
	}
}

func (r *Runner) StopTest(testID string) {}

func (r *Runner) cleanupContainer(ctx context.Context, containerID string) {
	timeout := 5
	_ = r.cli.ContainerStop(ctx, containerID, container.StopOptions{Timeout: &timeout})
	_ = r.cli.ContainerRemove(ctx, containerID, container.RemoveOptions{})
}

func (r *Runner) forceStopContainer(ctx context.Context, containerID string) {
	timeout := 1
	_ = r.cli.ContainerStop(ctx, containerID, container.StopOptions{Timeout: &timeout})
	_ = r.cli.ContainerRemove(ctx, containerID, container.RemoveOptions{})
}

func (r *Runner) waitForContainerStopped(ctx context.Context, containerID string) bool {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	timeout := time.After(10 * time.Second)
	for {
		select {
		case <-timeout:
			return false
		case <-ticker.C:
			insp, err := r.cli.ContainerInspect(ctx, containerID)
			if err != nil {
				return true
			}
			if !insp.State.Running {
				return true
			}
		}
	}
}

func (r *Runner) StopAllContainers() {
	r.containersMu.Lock()
	containers := make(map[string]string)
	for testID, containerID := range r.runningContainers {
		containers[testID] = containerID
	}
	r.containersMu.Unlock()

	for testID, containerID := range containers {
		r.cleanupContainer(context.Background(), containerID)
		r.containersMu.Lock()
		delete(r.runningContainers, testID)
		r.containersMu.Unlock()
	}
}

func (r *Runner) Close() error {
	r.StopAllContainers()
	return r.cli.Close()
}

func (r *Runner) shouldSkip(testID string) bool {
	r.skippedMu.RLock()
	defer r.skippedMu.RUnlock()
	return r.skippedTests[testID]
}

func (r *Runner) markSkipped(testID string) {
	r.skippedMu.Lock()
	defer r.skippedMu.Unlock()
	r.skippedTests[testID] = true
}

func (r *Runner) calculateSummaryStats(summary *RunSummary) {
	for _, result := range summary.Results {
		switch result.Status {
		case tests.StatusPassed:
			summary.Passed++
		case tests.StatusFailed:
			summary.Failed++
		case tests.StatusSkipped:
			summary.Skipped++
		case tests.StatusTimeout:
			summary.Timeout++
		}
	}
	summary.Total = len(summary.Results)
}

type RunSummary struct {
	StartTime time.Time
	EndTime   time.Time
	Duration  time.Duration
	Results   map[string]*tests.TestResult
	Total     int
	Passed    int
	Failed    int
	Skipped   int
	Timeout   int
}

type atomicBool struct {
	value bool
	mu    sync.RWMutex
}

func (a *atomicBool) Get() bool {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.value
}

func (a *atomicBool) Set(v bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.value = v
}

func findRepoRoot() (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}

	dir := cwd
	for {
		if _, err := os.Stat(filepath.Join(dir, "server")); err == nil {
			if _, err := os.Stat(filepath.Join(dir, "support")); err == nil {
				return dir, nil
			}
		}

		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("could not find repo root (looked for server/ and support/ dirs)")
		}
		dir = parent
	}
}

type StreamManager struct {
	mu      sync.RWMutex
	outputs map[string]*strings.Builder
}

func NewStreamManager() *StreamManager {
	return &StreamManager{
		outputs: make(map[string]*strings.Builder),
	}
}

func (sm *StreamManager) Clear() {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	sm.outputs = make(map[string]*strings.Builder)
}

func (sm *StreamManager) AddLine(testID, line string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	if sm.outputs[testID] == nil {
		sm.outputs[testID] = &strings.Builder{}
	}
	sm.outputs[testID].WriteString(line + "\n")
}

func (sm *StreamManager) GetOutput(testID string) string {
	sm.mu.RLock()
	defer sm.mu.RUnlock()

	if sb, ok := sm.outputs[testID]; ok {
		return sb.String()
	}
	return ""
}
