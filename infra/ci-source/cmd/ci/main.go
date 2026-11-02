package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
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

	checkCmd := flag.NewFlagSet("check", flag.ExitOnError)
	checkChanged := checkCmd.Bool("changed", false, "Only the checks a git diff can affect")
	checkRun := checkCmd.Bool("run", false, "Also run the affected tests, not just the static checks")
	checkSecurity := checkCmd.Bool("security", false, "Include the slow static analysis (staticcheck, gosec, govulncheck)")
	checkAll := checkCmd.Bool("all", false, "Every check, ignoring -changed")
	checkList := checkCmd.Bool("list", false, "Print the selected tests and exit without running")

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
		case "check":
			checkCmd.Parse(os.Args[2:])
			runCheck(*checkChanged, *checkRun, *checkSecurity, *checkAll, *checkList)
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
  check     Fast static checks (format, vet, lint, typecheck, colours)
  help      Show this help message

Check Flags:
  -changed            Only the checks the current diff can affect (default: all)
  -run                Also run the affected tests, not just the static checks
  -security           Include staticcheck, gosec and govulncheck (slow)
  -all                Every check, ignoring -changed
  -list               Print the selection and exit without running

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
  ci profiles                  # List all profiles
  ci check                     # Fast checks over everything (about a minute)
  ci check -changed            # Only what your diff can break
  ci check -changed -run       # ...plus the tests it can break
  ci check -changed -security  # ...plus staticcheck, gosec, govulncheck`)
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

// runOpts carries the `ci run` flags through to the executor.
type runOpts struct {
	fuzzDuration string
	failFast     bool
	outputDir    string
	session      bool
	perf         string
	cpus         float64
	memory       string
	parallel     int
	parallelSet  bool
	verbose      bool
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

	runTests(testsToRun, runOpts{
		fuzzDuration: fuzzDuration,
		failFast:     failFast,
		outputDir:    outputDir,
		session:      session,
		perf:         perf,
		cpus:         cpus,
		memory:       memory,
		parallel:     parallel,
		parallelSet:  parallelSet,
		verbose:      true,
	})
}

// runTests executes the given test IDs under the universal bounds and exits
// non-zero if any failed. verbose prints the per-run banner (parallelism,
// limits); `ci check` leaves it out to keep the inner loop quiet.
func runTests(testsToRun []string, opts runOpts) {
	fuzzDur, err := time.ParseDuration(opts.fuzzDuration)
	if err != nil {
		fmt.Printf("Error: Invalid fuzz duration '%s': %v\n", opts.fuzzDuration, err)
		os.Exit(1)
	}

	limits, universal, err := resolveLimits(opts.session, opts.perf, opts.cpus, opts.memory, opts.parallel, opts.parallelSet)
	if err != nil {
		fmt.Printf("Error: %v\n", err)
		os.Exit(1)
	}
	parallel := limits.Parallelism

	cfg := config.DefaultConfig
	cfg.Parallelism = parallel
	cfg.FailFast = opts.failFast
	cfg.FuzzDuration = fuzzDur
	cfg.OutputDir = opts.outputDir

	executor, err := runner.NewExecutor(&cfg)
	if err != nil {
		fmt.Printf("Error creating executor: %v\n", err)
		os.Exit(1)
	}
	defer executor.Close()

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	if opts.verbose {
		fmt.Printf("Running %d tests: %v\n", len(testsToRun), testsToRun)
		fmt.Printf("Parallel: %d, Fail-fast: %v\n", parallel, opts.failFast)
		if limits.CPUQuota > 0 || limits.MemoryLimit > 0 || limits.Nice > 0 {
			scope := "this session only"
			if universal {
				scope = "shared by all ci runs on this machine"
			}
			fmt.Printf("Limits (%s): %s\n", scope, describeLimits(limits))
		}
		fmt.Println()
	}

	startTime := time.Now()
	results := make(map[string]*tests.TestResult)

	go func() {
		<-sigChan
		fmt.Println("\nInterrupted! Stopping all containers...")
		executor.Cancel()
	}()

	go executor.Execute("", testsToRun, parallel, opts.failFast, fuzzDur, limits.CPUQuota, limits.MemoryLimit, limits.Nice, universal)

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

	if opts.outputDir != "" && len(results) > 0 {
		writeResults(results, opts.outputDir, duration)
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

// runCheck is the fast inner loop: the static checks (format, vet, lint,
// typecheck, colour scan) that catch a broken edit without compiling test
// binaries or running product logic. With -run it adds the affected tests.
//
// It is deliberately not a profile. A profile is a fixed answer to a question
// whose answer changes with the diff; -changed derives the selection from the
// paths git reports, so a one-line edit runs the handful of checks that can
// actually fail because of it.
func runCheck(changed, withRun, security, all, listOnly bool) {
	root, err := findRepoRoot()
	if err != nil {
		fmt.Printf("Error: %v\n", err)
		os.Exit(1)
	}

	var scope []*tests.Test
	var scopeNote string

	if changed {
		paths, err := changedPaths(root)
		if err != nil {
			fmt.Printf("Error: reading changed files: %v\n", err)
			os.Exit(1)
		}
		scope = tests.TestsForPaths(paths)
		if len(paths) == 0 {
			scopeNote = "no changed files; checking everything"
		} else {
			scopeNote = fmt.Sprintf("%d changed file(s)", len(paths))
			for _, p := range paths {
				fmt.Printf("  changed: %s\n", p)
			}
		}
	} else {
		scope = tests.DefaultRegistry.List()
		scopeNote = "all files"
	}

	selected := tests.FilterChecks(scope, !security)
	if all {
		selected = tests.FilterChecks(tests.DefaultRegistry.List(), !security)
		scopeNote = "all files"
	}

	if withRun {
		// Everything the diff touches, checks and tests alike: the point of
		// -run is "did I break anything nearby", not "is the whole suite green".
		selected = scope
		if all {
			selected = tests.DefaultRegistry.List()
		}
	}

	if len(selected) == 0 {
		fmt.Printf("No checks matched (%s). Nothing to do.\n", scopeNote)
		return
	}

	ids := make([]string, 0, len(selected))
	for _, t := range selected {
		ids = append(ids, t.ID)
	}

	kind := "checks"
	if withRun {
		kind = "tests and checks"
	}
	fmt.Printf("%s (%s): %d %s\n", strings.ToUpper(kind[:1])+kind[1:], scopeNote, len(ids), kind)
	for _, t := range selected {
		fmt.Printf("  %s\n", t.ID)
	}

	if listOnly {
		return
	}
	fmt.Println()

	runTests(ids, runOpts{fuzzDuration: "5m", parallel: 4})
}

// changedPaths returns the repo-relative paths of everything not committed,
// including untracked files, plus whatever the branch adds on top of its
// upstream. Uncommitted work is what an agent is about to check, so it is the
// primary source; the upstream diff catches a branch that is already committed.
func changedPaths(root string) ([]string, error) {
	seen := make(map[string]bool)
	var paths []string

	add := func(out []byte) {
		for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
			line = strings.TrimSpace(line)
			if line == "" || seen[line] {
				continue
			}
			seen[line] = true
			paths = append(paths, line)
		}
	}

	// Tracked changes, staged and unstaged, against HEAD.
	if out, err := gitOutput(root, "diff", "--name-only", "HEAD"); err == nil {
		add(out)
	}
	// Untracked files, which `git diff` never reports.
	if out, err := gitOutput(root, "ls-files", "--others", "--exclude-standard"); err == nil {
		add(out)
	}
	// Committed work on this branch that the upstream does not have.
	if out, err := gitOutput(root, "diff", "--name-only", "@{upstream}...HEAD"); err == nil {
		add(out)
	}

	return tests.NormalizePaths(root, paths), nil
}

func gitOutput(root string, args ...string) ([]byte, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = root
	return cmd.Output()
}

// findRepoRoot walks up from the working directory looking for the checkout,
// so `ci check` works from any subdirectory.
func findRepoRoot() (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	dir := cwd
	for {
		if _, err := os.Stat(filepath.Join(dir, "sol", "server")); err == nil {
			if _, err := os.Stat(filepath.Join(dir, "sol", "connect")); err == nil {
				return dir, nil
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("could not find the repo root (looked for sol/server/ and sol/connect/)")
		}
		dir = parent
	}
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
