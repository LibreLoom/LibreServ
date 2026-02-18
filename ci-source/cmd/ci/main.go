package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
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

	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "list":
			listTests()
		case "profiles":
			listProfiles()
		case "run":
			runCmd.Parse(os.Args[2:])
			runCLI(*profileName, *testIDs, *parallel, *fuzzDuration, *failFast, *outputDir)
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
  run       Run tests non-interactively (use flags)
  help      Show this help message

Run Flags:
  -profile <name>     Run tests for a profile (quick, deep, full, etc.)
  -tests <id,...>     Run specific test IDs (comma-separated)
  -parallel <n>       Number of parallel containers (default: 4)
  -fuzz <duration>    Fuzz test duration (default: 5m)
  -fail-fast          Stop on first failure
  -output <dir>       Output directory for results (JSON)

Examples:
  ci                           # Launch TUI
  ci run -profile quick        # Run quick profile
  ci run -tests go-test,go-vet # Run specific tests
  ci run -profile full         # Run full profile
  ci list                      # List all tests
  ci profiles                  # List all profiles`)
}

func listTests() {
	fmt.Println("Available Tests:\n")
	for _, t := range tui.GetAllTests() {
		fmt.Printf("  %-20s %s (%s)\n", t.ID, t.Name, t.Type)
	}
}

func listProfiles() {
	fmt.Println("Available Profiles:\n")
	for _, p := range tui.GetProfiles() {
		fmt.Printf("  %-12s %s\n", p.Name, p.Description)
		fmt.Printf("              Tests: %v\n\n", p.TestIDs)
	}
}

func runCLI(profileName, testIDs string, parallel int, fuzzDuration string, failFast bool, outputDir string) {
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
	fmt.Printf("Parallel: %d, Fail-fast: %v\n\n", parallel, failFast)

	startTime := time.Now()
	results := make(map[string]*tests.TestResult)

	go func() {
		<-sigChan
		fmt.Println("\nInterrupted! Stopping all containers...")
		executor.Cancel()
	}()

	go executor.Execute("", testsToRun, parallel, failFast, fuzzDur, 0, 0)

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
			time.Sleep(100 * time.Millisecond)
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
