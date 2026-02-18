package tui

import (
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/runner"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/tests"
)

type ViewMode int

const (
	ViewMain ViewMode = iota
	ViewProfileSelect
	ViewTestSelect
	ViewSettings
	ViewRunning
	ViewRunningDetail
	ViewResults
	ViewDetail
	ViewExport
	ViewExportCopy
)

type Model struct {
	viewMode        ViewMode
	config          *config.Config
	executor        *runner.Executor
	profiles        []*config.Profile
	allTests        []*tests.Test
	selectedProfile int
	selectedTests   map[string]bool
	cursor          int
	width           int
	height          int

	running        bool
	runningTests   []*tests.Test
	testResults    map[string]*tests.TestResult
	haltingTests   map[string]bool
	testOutputs    map[string][]string
	currentOutputs map[string][]string
	outputBuffer   []runner.OutputLine
	outputChan     <-chan runner.OutputLine
	resultChan     <-chan *tests.TestResult
	runningCount   int
	passedCount    int
	failedCount    int
	skippedCount   int
	startTime      time.Time
	endTime        time.Time

	selectedResult *tests.TestResult
	scrollOffset   int
	resultsList    []string
	exportFormat   int
	clipboardMsg   string
	lastError      string

	settings        Settings
	settingsCursor  int
	settingsInputs  map[string]string
	settingsEditing string
	settingsData    map[string]interface{}
	loadingMsg      string
	errorMsg        string
}

type Settings struct {
	Parallelism   int
	FuzzDuration  time.Duration
	FailFast      bool
	Notifications bool
	CPUQuota      int64
	MemoryLimit   int64
	ExportFormat  ExportFormat
}

type ExportFormat string

const (
	ExportJSON  ExportFormat = "json"
	ExportHTML  ExportFormat = "html"
	ExportJUnit ExportFormat = "junit"
	ExportAll   ExportFormat = "all"
)

func InitialModel() Model {
	cfg := config.DefaultConfig
	profiles := config.ListProfiles()
	allTests := tests.DefaultRegistry.List()

	userCfg, _ := config.LoadUserConfig()

	selectedTests := make(map[string]bool)
	quickProfile := profiles[0]
	for _, id := range quickProfile.TestIDs {
		selectedTests[id] = true
	}

	return Model{
		viewMode:        ViewMain,
		config:          &cfg,
		profiles:        profiles,
		allTests:        allTests,
		selectedTests:   selectedTests,
		selectedProfile: 0,
		testResults:     make(map[string]*tests.TestResult),
		testOutputs:     make(map[string][]string),
		currentOutputs:  make(map[string][]string),
		outputBuffer:    make([]runner.OutputLine, 0, 1000),
		haltingTests:    make(map[string]bool),
		settings: Settings{
			Parallelism:   userCfg.Parallelism,
			FuzzDuration:  userCfg.FuzzDuration,
			FailFast:      userCfg.FailFast,
			Notifications: userCfg.Notifications,
			CPUQuota:      userCfg.CPUQuota,
			MemoryLimit:   userCfg.MemoryLimit,
			ExportFormat:  ExportAll,
		},
	}
}

func (m Model) GetSelectedTests() []*tests.Test {
	var result []*tests.Test
	for _, t := range m.allTests {
		if m.selectedTests[t.ID] {
			result = append(result, t)
		}
	}
	return result
}

func (m Model) GetProfile() *config.Profile {
	if m.selectedProfile < len(m.profiles) {
		return m.profiles[m.selectedProfile]
	}
	return nil
}

func (m *Model) ApplyProfile() {
	profile := m.GetProfile()
	if profile == nil {
		return
	}
	for _, t := range m.allTests {
		m.selectedTests[t.ID] = false
	}
	for _, id := range profile.TestIDs {
		m.selectedTests[id] = true
	}
}

func (m *Model) UpdateResult(result *tests.TestResult) {
	m.testResults[result.TestID] = result

	switch result.Status {
	case tests.StatusHalting:
		m.haltingTests[result.TestID] = true
	case tests.StatusPassed:
		m.passedCount++
		m.runningCount--
		delete(m.haltingTests, result.TestID)
	case tests.StatusFailed:
		m.failedCount++
		m.runningCount--
		delete(m.haltingTests, result.TestID)
	case tests.StatusSkipped:
		m.skippedCount++
		m.runningCount--
		delete(m.haltingTests, result.TestID)
	}

	if m.runningCount == 0 {
		m.endTime = time.Now()
	}
}

func (m *Model) AddOutput(line runner.OutputLine) {
	m.outputBuffer = append(m.outputBuffer, line)
	if len(m.outputBuffer) > 500 {
		m.outputBuffer = m.outputBuffer[len(m.outputBuffer)-500:]
	}

	if line.TestID != "" {
		m.testOutputs[line.TestID] = append(m.testOutputs[line.TestID], line.Line)
		if len(m.testOutputs[line.TestID]) > 200 {
			m.testOutputs[line.TestID] = m.testOutputs[line.TestID][200:]
		}

		if _, ok := m.currentOutputs[line.TestID]; ok {
			m.currentOutputs[line.TestID] = append(m.currentOutputs[line.TestID], line.Line)
			if len(m.currentOutputs[line.TestID]) > 50 {
				m.currentOutputs[line.TestID] = m.currentOutputs[line.TestID][50:]
			}
		}
	}
}

func (m *Model) StartRun() {
	m.running = true
	m.viewMode = ViewRunning
	m.testResults = make(map[string]*tests.TestResult)
	m.testOutputs = make(map[string][]string)
	m.currentOutputs = make(map[string][]string)
	m.haltingTests = make(map[string]bool)
	m.outputBuffer = make([]runner.OutputLine, 0, 1000)
	m.passedCount = 0
	m.failedCount = 0
	m.skippedCount = 0
	m.runningCount = len(m.runningTests)
	m.startTime = time.Now()
	m.endTime = time.Time{}
	for _, t := range m.runningTests {
		m.currentOutputs[t.ID] = make([]string, 0, 50)
		m.testResults[t.ID] = &tests.TestResult{
			TestID:    t.ID,
			Name:      t.Name,
			Status:    tests.StatusPending,
			StartTime: time.Now(),
		}
	}
}

func (m *Model) CancelRun() {
	if m.executor != nil {
		m.executor.Cancel()
	}
}

func (m *Model) SkipTest(testID string) {
	if m.executor != nil {
		m.executor.SkipTest(testID)
	}
}

func GetAllTests() []*tests.Test {
	return tests.DefaultRegistry.List()
}

func GetProfiles() []*config.Profile {
	return config.ListProfiles()
}
