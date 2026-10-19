package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/runner"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/tests"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/tui"
)

func main() {
	runCmd := flag.NewFlagSet("run", flag.ExitOnError)
	profileName := runCmd.String("profile", "", "Profile to run")
	testIDs := runCmd.String("tests", "", "Comma-separated test IDs")
	parallel := runCmd.Int("parallel", 4, "Parallel containers")
	fuzzDuration := runCmd.String("fuzz", "5m", "Fuzz duration")
	failFast := runCmd.Bool("fail-fast", false, "Stop on first failure")
	outputDir := runCmd.String("output", "", "Output directory for results")
	session := runCmd.Bool("session", false, "Ignore the universal bounds in .ci.conf; use -perf/-cpus/-memory/-parallel for this run only")
	perf := runCmd.String("perf", "", "Performance profile for this session (full, balanced, gentle, custom); needs -session")
	cpus := runCmd.Float64("cpus", 0, "Cap CPU use to this many cores (0 = no cap)")
	memory := runCmd.String("memory", "", "Cap memory, e.g. 8G or 4096M (empty = no cap)")

	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "list":
			listTests()
		case "profiles":
			listProfiles()
		case "perf":
			listPerfProfiles()
		case "run":
			runCmd.Parse(os.Args[2:])
			runCLI(*profileName, *testIDs, *parallel, *fuzzDuration, *failFast, *outputDir, *session, *perf, *cpus, *memory, flagSet(runCmd, "parallel"))
		case "help", "-h", "--help":
			printHelp()
		default:
			fmt.Printf("Unknown command: %s\n", os.Args[1])
			printHelp()
			os.Exit(1)
		}
		return
	}

	model := tui.InitialModel()
	p := tea.NewProgram(&model, tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

func printHelp() {
	fmt.Println(`LibreServ CI - Local Test Runner

Usage:
  ci [command]

Commands:
  (none)    Launch interactive TUI
  list      List all available tests
  profiles  List all test profiles
  perf      List performance profiles (how hard a run may push this machine)
  run       Run tests non-interactively (use flags)
  help      Show this help message

Run Flags:
  -profile <name>     Run tests for a profile (quick, sol, luna, full, etc.)
  -tests <id,...>     Run specific test IDs (comma-separated)
  -fuzz <duration>    Fuzz test duration (default: 5m)
  -fail-fast          Stop on first failure
  -output <dir>       Output directory for results (JSON)
  -session            Ignore the universal bounds in .ci.conf; the flags below
                      then bound this run alone (none = unbounded)
  -perf <name>        With -session: full, balanced, gentle, custom
  -cpus <n>           With -session: cap CPU use to n cores
  -memory <size>      With -session: cap memory, e.g. 8G
  -parallel <n>       With -session: parallel containers

Examples:
  ci                           # Launch TUI
  ci run -profile quick        # Run quick profile
  ci run -tests go-test,go-vet # Run specific tests
  ci run -profile sol    # LibreServ release gate (no Luna/Connect)
  ci run -profile luna         # Luna (luna/ci.sh on the host)
  ci run -profile full         # Run full profile
  ci run -profile quick -session -perf balanced   # This run only, ignoring the universal bounds
  ci run -profile luna -session -cpus 4 -memory 8G
  ci list                      # List all tests
  ci profiles                  # List all profiles`)
}

func listTests() {
	fmt.Print("Available Tests:\n\n")
	for _, t := range tui.GetAllTests() {
		fmt.Printf("  %-20s %s (%s)\n", t.ID, t.Name, t.Type)
	}
}

func listProfiles() {
	fmt.Print("Available Profiles:\n\n")
	for _, p := range tui.GetProfiles() {
		fmt.Printf("  %-12s %s\n", p.Name, p.Description)
		fmt.Printf("              Tests: %v\n\n", p.TestIDs)
	}
}

func runCLI(profileName, testIDs string, parallel int, fuzzDuration string, failFast bool, outputDir string, session bool, perf string, cpus float64, memory string, parallelSet bool) {
	var testsToRun []string

	if profileName != "" {
		profile := config.GetProfile(profileName)
		if profile == nil {
			fmt.Printf("Error: Unknown profile '%s'\n", profileName)
			os.Exit(1)
		}
		testsToRun = profile.TestIDs
	} else if testIDs != "" {
		testsToRun = strings.Split(testIDs, ",")
		for i := range testsToRun {
			testsToRun[i] = strings.TrimSpace(testsToRun[i])
		}
	} else {
		fmt.Println("Error: Must specify either -profile or -tests")
		os.Exit(1)
	}

	if len(testsToRun) == 0 {
		fmt.Println("Error: No tests to run")
		os.Exit(1)
	}

	fuzzDur, err := time.ParseDuration(fuzzDuration)
	if err != nil {
		fmt.Printf("Error: Invalid fuzz duration '%s': %v\n", fuzzDuration, err)
		os.Exit(1)
	}

	limits, universal, err := resolveLimits(session, perf, cpus, memory, parallel, parallelSet)
	if err != nil {
		fmt.Printf("Error: %v\n", err)
		os.Exit(1)
	}
	parallel = limits.Parallelism

	cfg := config.DefaultConfig
	cfg.Parallelism = parallel
	cfg.FailFast = failFast
	cfg.FuzzDuration = fuzzDur
	cfg.OutputDir = outputDir

	executor, err := runner.NewExecutor(&cfg)
	if err != nil {
		fmt.Printf("Error creating executor: %v\n", err)
		os.Exit(1)
	}
	defer executor.Close()

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	fmt.Printf("Running %d tests: %v\n", len(testsToRun), testsToRun)
	fmt.Printf("Parallel: %d, Fail-fast: %v\n", parallel, failFast)
	if limits.CPUQuota > 0 || limits.MemoryLimit > 0 || limits.Nice > 0 {
		scope := "this session only"
		if universal {
			scope = "shared by all ci runs on this machine"
		}
		fmt.Printf("Limits (%s): %s\n", scope, describeLimits(limits))
	}
	fmt.Println()

	startTime := time.Now()
	results := make(map[string]*tests.TestResult)

	go func() {
		<-sigChan
		fmt.Println("\nInterrupted! Stopping all containers...")
		executor.Cancel()
	}()

	go executor.Execute("", testsToRun, parallel, failFast, fuzzDur, limits.CPUQuota, limits.MemoryLimit, limits.Nice, universal)

	passed := 0
	failed := 0
	skipped := 0

	for {
		select {
		case result := <-executor.ResultChan():
			results[result.TestID] = result
			duration := result.Duration.Round(time.Second)
			switch result.Status {
			case tests.StatusPassed:
				passed++
				fmt.Printf("✓ %s (%v)\n", result.Name, duration)
			case tests.StatusFailed:
				failed++
				fmt.Printf("✗ %s (%v)\n", result.Name, duration)
				if out := strings.TrimSpace(result.Output); out != "" {
					fmt.Printf("%s\n", indentLines(out, "    "))
				}
			case tests.StatusSkipped:
				skipped++
				fmt.Printf("⊘ %s (skipped)\n", result.Name)
			case tests.StatusHalting:
				fmt.Printf("⊗ %s (halting)\n", result.Name)
			}
		case line := <-executor.OutputChan():
			if line.Type == runner.OutputStatus || line.Type == runner.OutputError {
				fmt.Printf("[%s] %s\n", line.TestID, line.Line)
			}
		default:
			if passed+failed+skipped >= len(testsToRun) && len(results) >= len(testsToRun) {
				goto done
			}
			time.Sleep(10 * time.Millisecond)
		}
	}

done:
	duration := time.Since(startTime).Round(time.Second)
	fmt.Printf("\n=============================\n")
	fmt.Printf("Results: %d passed, %d failed, %d skipped in %v\n", passed, failed, skipped, duration)
	fmt.Printf("=============================\n")

	if outputDir != "" && len(results) > 0 {
		writeResults(results, outputDir, duration)
	}

	if failed > 0 {
		os.Exit(1)
	}
}

func indentLines(text, prefix string) string {
	lines := strings.Split(text, "\n")
	for i := range lines {
		lines[i] = prefix + lines[i]
	}
	return strings.Join(lines, "\n")
}

func writeResults(results map[string]*tests.TestResult, outputDir string, duration time.Duration) {
	os.MkdirAll(outputDir, 0755)

	summary := struct {
		Passed   int                          `json:"passed"`
		Failed   int                          `json:"failed"`
		Skipped  int                          `json:"skipped"`
		Duration time.Duration                `json:"duration"`
		Results  map[string]*tests.TestResult `json:"results"`
	}{0, 0, 0, duration, results}

	for _, r := range results {
		switch r.Status {
		case tests.StatusPassed:
			summary.Passed++
		case tests.StatusFailed:
			summary.Failed++
		case tests.StatusSkipped:
			summary.Skipped++
		}
	}

	data, _ := json.MarshalIndent(summary, "", "  ")
	os.WriteFile(outputDir+"/results.json", data, 0644)
	fmt.Printf("Results written to %s/results.json\n", outputDir)
}

func listPerfProfiles() {
	fmt.Print("Performance Profiles (the bounds in .ci.conf; for one run only: ci run -session -perf <name>):\n\n")
	for _, p := range config.PerfProfiles {
		l := p.Resolve(config.PerfLimits{Parallelism: 4})
		fmt.Printf("  %-10s %s\n", p.ID, p.Description)
		if l.CPUQuota > 0 || l.MemoryLimit > 0 {
			fmt.Printf("             On this machine: %s, %d at a time\n", describeLimits(l), l.Parallelism)
		}
		fmt.Println()
	}
}

// flagSet reports whether a flag was given explicitly.
func flagSet(fs *flag.FlagSet, name string) bool {
	set := false
	fs.Visit(func(f *flag.Flag) {
		if f.Name == name {
			set = true
		}
	})
	return set
}

// resolveLimits picks the bounds for a run. By default these are the universal
// bounds in .ci.conf, shared by every ci run on the machine. With session set
// they are ignored and the flags bound this run alone (none = unbounded).
// Limit flags without session are refused so they can't quietly bypass the
// universal bounds.
func resolveLimits(session bool, perf string, cpus float64, memory string, parallel int, parallelSet bool) (config.PerfLimits, bool, error) {
	if !session {
		if perf != "" || cpus > 0 || memory != "" || parallelSet {
			return config.PerfLimits{}, false, fmt.Errorf("-perf, -cpus, -memory and -parallel only apply with -session; without it the bounds come from %s and cover every ci run on this machine", config.ConfigFileName)
		}
		cfg, err := config.LoadUserConfig()
		if err != nil {
			return config.PerfLimits{}, false, fmt.Errorf("reading %s: %w", config.ConfigFileName, err)
		}
		l, bounded := cfg.Limits()
		return l, bounded, nil
	}

	cur := config.PerfLimits{Parallelism: parallel}
	if perf != "" {
		p := config.GetPerfProfile(perf)
		if p == nil {
			return cur, false, fmt.Errorf("unknown performance profile %q (see: ci perf)", perf)
		}
		cur = p.Resolve(cur)
		if parallelSet {
			cur.Parallelism = parallel
		}
	}
	if cpus > 0 {
		cur.CPUQuota = int64(cpus * 100000)
	}
	if memory != "" {
		b, err := parseSize(memory)
		if err != nil {
			return cur, false, err
		}
		cur.MemoryLimit = b
	}
	return cur, false, nil
}

func parseSize(s string) (int64, error) {
	t := strings.ToUpper(strings.TrimSpace(s))
	t = strings.TrimSuffix(t, "B")
	mult := int64(1)
	switch {
	case strings.HasSuffix(t, "G"):
		mult, t = 1<<30, strings.TrimSuffix(t, "G")
	case strings.HasSuffix(t, "M"):
		mult, t = 1<<20, strings.TrimSuffix(t, "M")
	case strings.HasSuffix(t, "K"):
		mult, t = 1<<10, strings.TrimSuffix(t, "K")
	}
	n, err := strconv.ParseFloat(t, 64)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("invalid memory size %q (try 8G or 4096M)", s)
	}
	return int64(n * float64(mult)), nil
}

func describeLimits(l config.PerfLimits) string {
	var parts []string
	if l.CPUQuota > 0 {
		parts = append(parts, fmt.Sprintf("%.1f cores", float64(l.CPUQuota)/100000))
	}
	if l.MemoryLimit > 0 {
		parts = append(parts, fmt.Sprintf("%.1f GB memory", float64(l.MemoryLimit)/(1<<30)))
	}
	if l.Nice > 0 {
		parts = append(parts, fmt.Sprintf("priority nice %d", l.Nice))
	}
	return strings.Join(parts, ", ")
}
