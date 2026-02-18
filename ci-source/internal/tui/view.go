package tui

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"sort"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/progress"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/export"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/notify"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/runner"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/tests"
)

var (
	titleStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("#7C3AED")).
			Padding(0, 1).
			MarginBottom(1)

	selectedStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#7C3AED")).
			Bold(true)

	normalStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#888888"))

	passedStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#22C55E")).
			Bold(true)

	failedStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#EF4444")).
			Bold(true)

	runningStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#F59E0B")).
			Bold(true)

	haltingStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#F59E0B")).
			Bold(true)

	headerStyle = lipgloss.NewStyle().
			Bold(true).
			Background(lipgloss.Color("#1E1E2E")).
			Foreground(lipgloss.Color("#CDD6F4")).
			Padding(0, 1)

	boxStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color("#45475A")).
			Padding(0, 1).
			Margin(0, 1)

	logStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#A6E3A1"))

	errorStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#F38BA8"))

	helpStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#6C7086")).
			Padding(1, 2)
)

type tickMsg struct{}
type outputMsg struct{ line runner.OutputLine }
type resultMsg struct{ result *tests.TestResult }

func tickCmd() tea.Cmd {
	return tea.Tick(100*time.Millisecond, func(time.Time) tea.Msg {
		return tickMsg{}
	})
}

func waitForOutput(ch <-chan runner.OutputLine) tea.Cmd {
	return func() tea.Msg {
		select {
		case line := <-ch:
			return outputMsg{line: line}
		default:
			return nil
		}
	}
}

func waitForResult(ch <-chan *tests.TestResult) tea.Cmd {
	return func() tea.Msg {
		select {
		case result := <-ch:
			return resultMsg{result: result}
		default:
			return nil
		}
	}
}

func (m Model) Init() tea.Cmd {
	if m.running {
		return tickCmd()
	}
	return nil
}

func (m *Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		return m.handleKeyPress(msg)
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil
	case tickMsg:
		if !m.running {
			return m, nil
		}

		var cmds []tea.Cmd
		if m.outputChan != nil {
			cmds = append(cmds, waitForOutput(m.outputChan))
		}
		if m.resultChan != nil {
			cmds = append(cmds, waitForResult(m.resultChan))
		}
		cmds = append(cmds, tickCmd())
		return m, tea.Batch(cmds...)
	case outputMsg:
		m.AddOutput(msg.line)
		return m, nil
	case resultMsg:
		m.UpdateResult(msg.result)
		if m.runningCount <= 0 && m.running {
			m.running = false
			m.viewMode = ViewResults
			m.cursor = 0

			if m.settings.Notifications {
				title := "CI Complete"
				if m.failedCount > 0 {
					title = fmt.Sprintf("CI Failed (%d failed)", m.failedCount)
				} else if m.passedCount > 0 {
					title = fmt.Sprintf("CI Passed (%d passed)", m.passedCount)
				}
				duration := m.endTime.Sub(m.startTime)
				if m.endTime.IsZero() {
					duration = time.Since(m.startTime)
				}
				msg := fmt.Sprintf("%d passed, %d failed, %d skipped in %v",
					m.passedCount, m.failedCount, m.skippedCount, duration.Round(time.Second))
				go notify.Send(title, msg)
			}
		}
		return m, nil
	}
	return m, nil
}

func (m *Model) handleKeyPress(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch m.viewMode {
	case ViewMain:
		return m.handleMainKeys(msg)
	case ViewProfileSelect:
		return m.handleProfileSelectKeys(msg)
	case ViewTestSelect:
		return m.handleTestSelectKeys(msg)
	case ViewSettings:
		return m.handleSettingsKeys(msg)
	case ViewRunning:
		return m.handleRunningKeys(msg)
	case ViewRunningDetail:
		return m.handleRunningDetailKeys(msg)
	case ViewResults:
		return m.handleResultsKeys(msg)
	case ViewDetail:
		return m.handleDetailKeys(msg)
	case ViewExport:
		return m.handleExportKeys(msg)
	case ViewExportCopy:
		return m.handleExportCopyKeys(msg)
	}
	return m, nil
}

func (m *Model) handleMainKeys(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "q", "ctrl+c":
		if m.executor != nil {
			m.executor.Close()
		}
		return m, tea.Quit
	case "up", "k":
		if m.cursor > 0 {
			m.cursor--
		}
	case "down", "j":
		if m.cursor < 3 {
			m.cursor++
		}
	case "enter", " ":
		switch m.cursor {
		case 0:
			m.viewMode = ViewProfileSelect
			m.cursor = m.selectedProfile
		case 1:
			m.viewMode = ViewTestSelect
			m.cursor = 0
		case 2:
			m.viewMode = ViewSettings
			m.cursor = 0
		case 3:
			return m.startExecution()
		}
	}
	return m, nil
}

func (m *Model) startExecution() (tea.Model, tea.Cmd) {
	var err error

	if m.executor != nil {
		m.executor.Close()
	}
	m.executor, err = runner.NewExecutor(m.config)
	if err != nil {
		m.lastError = err.Error()
		return m, nil
	}

	selectedTests := m.GetSelectedTests()
	if len(selectedTests) == 0 {
		m.lastError = "No tests selected"
		return m, nil
	}

	testIDs := make([]string, 0, len(selectedTests))
	for _, t := range selectedTests {
		testIDs = append(testIDs, t.ID)
	}

	m.runningTests = selectedTests

	m.outputChan = m.executor.OutputChan()
	m.resultChan = m.executor.ResultChan()

	m.StartRun()

	go m.executor.Execute("", testIDs, m.settings.Parallelism, m.settings.FailFast, m.settings.FuzzDuration, m.settings.CPUQuota, m.settings.MemoryLimit)

	return m, tickCmd()
}

func (m *Model) handleProfileSelectKeys(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "q", "esc":
		m.viewMode = ViewMain
		m.cursor = 0
	case "up", "k":
		if m.cursor > 0 {
			m.cursor--
		}
	case "down", "j":
		if m.cursor < len(m.profiles)-1 {
			m.cursor++
		}
	case "enter", " ":
		m.selectedProfile = m.cursor
		m.ApplyProfile()
		m.viewMode = ViewMain
		m.cursor = 0
	}
	return m, nil
}

func (m *Model) handleTestSelectKeys(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "q", "esc":
		m.viewMode = ViewMain
		m.cursor = 0
	case "up", "k":
		if m.cursor > 0 {
			m.cursor--
		}
	case "down", "j":
		if m.cursor < len(m.allTests)-1 {
			m.cursor++
		}
	case " ":
		testID := m.allTests[m.cursor].ID
		m.selectedTests[testID] = !m.selectedTests[testID]
	case "a":
		allSelected := true
		for _, t := range m.allTests {
			if !m.selectedTests[t.ID] {
				allSelected = false
				break
			}
		}
		for _, t := range m.allTests {
			m.selectedTests[t.ID] = !allSelected
		}
	case "enter":
		m.viewMode = ViewMain
		m.cursor = 0
	}
	return m, nil
}

func (m *Model) handleSettingsKeys(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "q", "esc":
		m.viewMode = ViewMain
		m.cursor = 0
		m.lastError = ""
	case "s":
		cfg := &config.UserConfig{
			Parallelism:   m.settings.Parallelism,
			FuzzDuration:  m.settings.FuzzDuration,
			FailFast:      m.settings.FailFast,
			Notifications: m.settings.Notifications,
			CPUQuota:      m.settings.CPUQuota,
			MemoryLimit:   m.settings.MemoryLimit,
		}
		if err := config.SaveUserConfig(cfg); err != nil {
			m.lastError = "Failed to save: " + err.Error()
		} else {
			m.lastError = "Config saved!"
		}
	case "up", "k":
		if m.cursor > 0 {
			m.cursor--
		}
	case "down", "j":
		if m.cursor < 5 {
			m.cursor++
		}
	case "left", "h":
		switch m.cursor {
		case 0:
			if m.settings.Parallelism > 1 {
				m.settings.Parallelism--
			}
		case 1:
			if m.settings.FuzzDuration > time.Minute {
				m.settings.FuzzDuration -= time.Minute
			}
		case 2:
			m.settings.FailFast = false
		case 3:
			m.settings.Notifications = false
		case 4:
			if m.settings.CPUQuota > 100000 {
				m.settings.CPUQuota -= 100000
			} else if m.settings.CPUQuota > 0 {
				m.settings.CPUQuota = 0
			}
		case 5:
			if m.settings.MemoryLimit > 512*1024*1024 {
				m.settings.MemoryLimit -= 512 * 1024 * 1024
			} else if m.settings.MemoryLimit > 0 {
				m.settings.MemoryLimit = 0
			}
		}
	case "right", "l":
		switch m.cursor {
		case 0:
			if m.settings.Parallelism < 16 {
				m.settings.Parallelism++
			}
		case 1:
			m.settings.FuzzDuration += time.Minute
		case 2:
			m.settings.FailFast = true
		case 3:
			m.settings.Notifications = true
		case 4:
			if m.settings.CPUQuota < 4000000 {
				m.settings.CPUQuota += 100000
			}
		case 5:
			if m.settings.MemoryLimit < 16384*1024*1024 {
				m.settings.MemoryLimit += 512 * 1024 * 1024
			}
		}
	case " ", "enter":
		switch m.cursor {
		case 2:
			m.settings.FailFast = !m.settings.FailFast
		case 3:
			m.settings.Notifications = !m.settings.Notifications
		}
	}
	return m, nil
}

func (m *Model) handleRunningKeys(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "q", "ctrl+c":
		if m.executor != nil {
			m.executor.Close()
		}
		return m, tea.Quit
	case "enter", " ":
		if m.cursor < len(m.runningTests) {
			t := m.runningTests[m.cursor]
			m.selectedResult = m.testResults[t.ID]
			m.scrollOffset = 99999
			m.viewMode = ViewRunningDetail
		}
	case "up", "k":
		if m.cursor > 0 {
			m.cursor--
		}
	case "down", "j":
		if m.cursor < len(m.runningTests)-1 {
			m.cursor++
		}
	}
	return m, nil
}

func (m *Model) handleRunningDetailKeys(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "q", "esc", "enter":
		m.viewMode = ViewRunning
		m.selectedResult = nil
		return m, nil
	case "s":
		if m.selectedResult != nil && (m.selectedResult.Status == tests.StatusRunning || m.selectedResult.Status == tests.StatusPending) {
			m.SkipTest(m.selectedResult.TestID)
			m.testOutputs[m.selectedResult.TestID] = append(m.testOutputs[m.selectedResult.TestID], "\n--- TEST SKIPPED BY USER ---")
		}
		return m, nil
	case "up", "k":
		if m.scrollOffset > 0 {
			m.scrollOffset--
		}
	case "down", "j":
		m.scrollOffset++
	}

	if m.selectedResult == nil {
		return m, nil
	}

	lines := strings.Split(strings.Join(m.testOutputs[m.selectedResult.TestID], "\n"), "\n")
	if m.selectedResult.Output != "" {
		lines = strings.Split(m.selectedResult.Output, "\n")
	}
	maxLines := m.height - 15
	if maxLines < 5 {
		maxLines = 20
	}
	if m.scrollOffset > len(lines)-maxLines {
		m.scrollOffset = len(lines) - maxLines
	}
	if m.scrollOffset < 0 {
		m.scrollOffset = 0
	}

	return m, nil
}

func (m *Model) handleResultsKeys(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "q", "ctrl+c":
		if m.executor != nil {
			m.executor.Close()
		}
		return m, tea.Quit
	case "enter", " ":
		if len(m.testResults) > 0 {
			ids := make([]string, 0, len(m.testResults))
			for id := range m.testResults {
				ids = append(ids, id)
			}
			sort.Strings(ids)
			if m.cursor < len(ids) {
				m.selectedResult = m.testResults[ids[m.cursor]]
				m.scrollOffset = 99999
				m.viewMode = ViewDetail
			}
		}
	case "up", "k":
		if m.cursor > 0 {
			m.cursor--
		}
	case "down", "j":
		if m.cursor < len(m.testResults)-1 {
			m.cursor++
		}
	case "e":
		m.viewMode = ViewExport
		m.cursor = 0
	}
	return m, nil
}

func (m *Model) handleDetailKeys(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "q", "esc", "enter":
		m.viewMode = ViewResults
		m.selectedResult = nil
		m.lastError = ""
		return m, nil
	case "c":
		return m.copyToClipboard()
	case "up", "k":
		if m.scrollOffset > 0 {
			m.scrollOffset--
		}
	case "down", "j":
		m.scrollOffset++
	}

	if m.selectedResult == nil {
		return m, nil
	}

	lines := strings.Split(strings.Join(m.testOutputs[m.selectedResult.TestID], "\n"), "\n")
	if m.selectedResult.Output != "" {
		lines = strings.Split(m.selectedResult.Output, "\n")
	}
	maxLines := m.height - 15
	if maxLines < 5 {
		maxLines = 20
	}
	if m.scrollOffset > len(lines)-maxLines {
		m.scrollOffset = len(lines) - maxLines
	}
	if m.scrollOffset < 0 {
		m.scrollOffset = 0
	}

	return m, nil
}

func (m *Model) copyToClipboard() (tea.Model, tea.Cmd) {
	if m.selectedResult == nil {
		return m, nil
	}

	output := m.selectedResult.Output
	if output == "" {
		output = strings.Join(m.testOutputs[m.selectedResult.TestID], "\n")
	}

	if err := copyToClipboardFn(output); err != nil {
		m.lastError = "Failed to copy: " + err.Error()
	} else {
		m.lastError = "Copied to clipboard!"
	}
	return m, nil
}

func copyToClipboardFn(text string) error {
	commands := [][]string{
		{"wl-copy"},
		{"xclip", "-selection", "clipboard"},
		{"xsel", "--clipboard", "--input"},
		{"pbcopy"},
		{"clip"},
	}

	for _, args := range commands {
		cmd := exec.Command(args[0], args[1:]...)
		cmd.Stdin = strings.NewReader(text)
		if cmd.Run() == nil {
			return nil
		}
	}
	return fmt.Errorf("no clipboard tool found")
}

func (m *Model) handleExportKeys(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "q", "esc":
		if len(m.testResults) > 0 {
			m.viewMode = ViewResults
		} else {
			m.viewMode = ViewMain
		}
		m.cursor = 0
		m.lastError = ""
	case "up", "k":
		if m.cursor > 0 {
			m.cursor--
		}
	case "down", "j":
		if m.cursor < 3 {
			m.cursor++
		}
	case "enter", " ":
		if m.cursor == 3 {
			m.viewMode = ViewExportCopy
			m.cursor = 0
		} else {
			return m.doExport()
		}
	}
	return m, nil
}

func (m *Model) handleExportCopyKeys(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "q", "esc":
		m.viewMode = ViewExport
		m.cursor = 0
		m.lastError = ""
	case "up", "k":
		if m.cursor > 0 {
			m.cursor--
		}
	case "down", "j":
		if m.cursor < 2 {
			m.cursor++
		}
	case "enter", " ":
		return m.doExportCopy()
	}
	return m, nil
}

func (m *Model) doExport() (tea.Model, tea.Cmd) {
	if len(m.testResults) == 0 {
		m.lastError = "No results to export"
		return m, nil
	}

	duration := time.Since(m.startTime)
	exporter := export.NewExporter(m.config.OutputDir)

	switch m.cursor {
	case 0:
		filename, err := exporter.ExportJSON(m.testResults, duration)
		if err != nil {
			m.lastError = err.Error()
		} else {
			m.lastError = "Saved: " + filename
		}
	case 1:
		filename, err := exporter.ExportHTML(m.testResults, duration)
		if err != nil {
			m.lastError = err.Error()
		} else {
			m.lastError = "Saved: " + filename
		}
	case 2:
		filename, err := exporter.ExportJUnit(m.testResults, duration)
		if err != nil {
			m.lastError = err.Error()
		} else {
			m.lastError = "Saved: " + filename
		}
	}

	m.viewMode = ViewResults
	m.cursor = 0
	return m, nil
}

func (m *Model) doExportCopy() (tea.Model, tea.Cmd) {
	if len(m.testResults) == 0 {
		m.lastError = "No results to export"
		return m, nil
	}

	duration := time.Since(m.startTime)
	exporter := export.NewExporter(m.config.OutputDir)

	switch m.cursor {
	case 0:
		data, err := json.MarshalIndent(m.testResults, "", "  ")
		if err != nil {
			m.lastError = err.Error()
		} else if err := copyToClipboardFn(string(data)); err != nil {
			m.lastError = err.Error()
		} else {
			m.lastError = "Copied JSON to clipboard!"
		}
	case 1:
		data, err := exporter.ExportHTMLForClipboard(m.testResults, duration)
		if err != nil {
			m.lastError = err.Error()
		} else if err := copyToClipboardFn(data); err != nil {
			m.lastError = err.Error()
		} else {
			m.lastError = "Copied HTML to clipboard!"
		}
	case 2:
		data, err := exporter.ExportJUnitForClipboard(m.testResults, duration)
		if err != nil {
			m.lastError = err.Error()
		} else if err := copyToClipboardFn(data); err != nil {
			m.lastError = err.Error()
		} else {
			m.lastError = "Copied JUnit XML to clipboard!"
		}
	}

	m.viewMode = ViewExportCopy
	m.cursor = 0
	return m, nil
}

func (m Model) View() string {
	switch m.viewMode {
	case ViewMain:
		return m.viewMain()
	case ViewProfileSelect:
		return m.viewProfileSelect()
	case ViewTestSelect:
		return m.viewTestSelect()
	case ViewSettings:
		return m.viewSettings()
	case ViewRunning:
		return m.viewRunning()
	case ViewRunningDetail:
		return m.viewRunningDetail()
	case ViewResults:
		return m.viewResults()
	case ViewDetail:
		return m.viewDetail()
	case ViewExport:
		return m.viewExport()
	case ViewExportCopy:
		return m.viewExportCopy()
	}
	return ""
}

func (m Model) viewMain() string {
	var b strings.Builder

	b.WriteString(titleStyle.Render("LibreServ CI"))
	b.WriteString("\n")

	profile := m.GetProfile()
	if profile != nil {
		b.WriteString(normalStyle.Render("Profile: " + profile.Name))
	}
	b.WriteString("\n\n")

	menuItems := []string{
		"Select Profile",
		"Select Tests",
		"Settings",
		"Run Tests",
	}

	for i, item := range menuItems {
		if i == m.cursor {
			b.WriteString(selectedStyle.Render("-> " + item))
		} else {
			b.WriteString(normalStyle.Render("   " + item))
		}
		b.WriteString("\n")
	}

	selected := len(m.GetSelectedTests())
	b.WriteString(fmt.Sprintf("\n%s tests selected\n", normalStyle.Render(fmt.Sprintf("%d", selected))))

	if m.lastError != "" {
		b.WriteString("\n")
		b.WriteString(errorStyle.Render(m.lastError))
	}

	b.WriteString(helpStyle.Render("up/k up | down/j down | enter select | q quit"))

	return b.String()
}

func (m Model) viewProfileSelect() string {
	var b strings.Builder

	b.WriteString(titleStyle.Render("Select Profile"))
	b.WriteString("\n\n")

	for i, p := range m.profiles {
		prefix := "   "
		if i == m.cursor {
			prefix = "-> "
		}
		line := prefix + p.Name + " - " + p.Description
		if i == m.cursor {
			b.WriteString(selectedStyle.Render(line))
		} else {
			b.WriteString(normalStyle.Render(line))
		}
		b.WriteString("\n")
	}

	b.WriteString("\n")
	b.WriteString(helpStyle.Render("up/k up | down/j down | enter select | esc back"))

	return b.String()
}

func (m Model) viewTestSelect() string {
	var b strings.Builder

	b.WriteString(titleStyle.Render("Select Tests"))
	b.WriteString("\n\n")

	for i, t := range m.allTests {
		check := "[ ]"
		if m.selectedTests[t.ID] {
			check = "[x]"
		}
		cursor := " "
		if i == m.cursor {
			cursor = "->"
		}
		line := fmt.Sprintf("%s %s %s (%s)", cursor, check, t.Name, t.Type)
		if i == m.cursor {
			b.WriteString(selectedStyle.Render(line))
		} else if m.selectedTests[t.ID] {
			b.WriteString(passedStyle.Render(line))
		} else {
			b.WriteString(normalStyle.Render(line))
		}
		b.WriteString("\n")
	}

	b.WriteString("\n")
	b.WriteString(helpStyle.Render("space toggle | a toggle all | enter confirm | esc back"))

	return b.String()
}

func (m Model) viewSettings() string {
	var b strings.Builder

	b.WriteString(titleStyle.Render("Settings"))
	b.WriteString("\n\n")

	notifStatus := "Disabled"
	if m.settings.Notifications {
		notifStatus = "Enabled"
	}

	failfastStatus := "Off"
	if m.settings.FailFast {
		failfastStatus = "On"
	}

	cpuStatus := "Unlimited"
	if m.settings.CPUQuota > 0 {
		cpuStatus = fmt.Sprintf("%.2f cores", float64(m.settings.CPUQuota)/100000)
	}

	memStatus := "Unlimited"
	if m.settings.MemoryLimit > 0 {
		memStatus = fmt.Sprintf("%.0f MB", float64(m.settings.MemoryLimit)/(1024*1024))
	}

	settingsItems := []string{
		fmt.Sprintf("Parallelism:     %d containers", m.settings.Parallelism),
		fmt.Sprintf("Fuzz Duration:   %v", m.settings.FuzzDuration),
		fmt.Sprintf("Fail Fast:       %s", failfastStatus),
		fmt.Sprintf("Notifications:   %s", notifStatus),
		fmt.Sprintf("CPU Limit:       %s", cpuStatus),
		fmt.Sprintf("Memory Limit:    %s", memStatus),
	}

	for i, item := range settingsItems {
		if i == m.cursor {
			b.WriteString(selectedStyle.Render("-> " + item + "  <- ->"))
		} else {
			b.WriteString(normalStyle.Render("   " + item))
		}
		b.WriteString("\n")
	}

	b.WriteString("\n")
	b.WriteString(helpStyle.Render("left/h decrease | right/l increase | space toggle | s save to disk | esc back"))

	if m.lastError != "" {
		b.WriteString("\n")
		if strings.Contains(m.lastError, "saved") {
			b.WriteString(passedStyle.Render(m.lastError))
		} else {
			b.WriteString(errorStyle.Render(m.lastError))
		}
	}

	return b.String()
}

func (m Model) viewRunning() string {
	var b strings.Builder

	b.WriteString(titleStyle.Render("Running Tests"))
	b.WriteString("\n\n")

	total := len(m.runningTests)
	if total > 0 {
		done := m.passedCount + m.failedCount + m.skippedCount
		prog := progress.New(progress.WithDefaultGradient())
		prog.Width = m.width - 10
		if m.width > 20 {
			b.WriteString(prog.ViewAs(float64(done)/float64(total)) + "\n\n")
		}
	}

	b.WriteString(fmt.Sprintf("Running: %d  ", m.runningCount))
	b.WriteString(fmt.Sprintf("Passed: %s  ", passedStyle.Render(fmt.Sprintf("%d", m.passedCount))))
	b.WriteString(fmt.Sprintf("Failed: %s  ", failedStyle.Render(fmt.Sprintf("%d", m.failedCount))))
	b.WriteString(fmt.Sprintf("Skipped: %s\n\n", normalStyle.Render(fmt.Sprintf("%d", m.skippedCount))))

	for i, t := range m.runningTests {
		result, ok := m.testResults[t.ID]
		if !ok {
			continue
		}

		var styledLine string
		switch result.Status {
		case tests.StatusRunning:
			styledLine = ">>> " + t.Name + " (RUNNING)"
		case tests.StatusHalting:
			styledLine = ">>> " + t.Name + " (HALTING)"
		case tests.StatusPassed:
			styledLine = "ok " + t.Name + " (passed)"
		case tests.StatusFailed:
			styledLine = "FAIL " + t.Name + " (failed)"
		case tests.StatusSkipped:
			styledLine = "skip " + t.Name + " (skipped)"
		default:
			styledLine = "... " + t.Name + " (pending)"
		}

		if i == m.cursor {
			b.WriteString(selectedStyle.Render("-> "))
			switch result.Status {
			case tests.StatusRunning, tests.StatusHalting:
				b.WriteString(haltingStyle.Render(styledLine))
			case tests.StatusPassed:
				b.WriteString(passedStyle.Render(styledLine))
			case tests.StatusFailed:
				b.WriteString(failedStyle.Render(styledLine))
			default:
				b.WriteString(normalStyle.Render(styledLine))
			}
		} else {
			switch result.Status {
			case tests.StatusRunning, tests.StatusHalting:
				b.WriteString(haltingStyle.Render("   " + styledLine))
			case tests.StatusPassed:
				b.WriteString(passedStyle.Render("   " + styledLine))
			case tests.StatusFailed:
				b.WriteString(failedStyle.Render("   " + styledLine))
			default:
				b.WriteString(normalStyle.Render("   " + styledLine))
			}
		}
		b.WriteString("\n")
	}

	b.WriteString("\n")
	b.WriteString(helpStyle.Render("enter view details | up/k select | down/j select | ctrl+c cancel"))

	return b.String()
}

func (m Model) viewRunningDetail() string {
	var b strings.Builder

	if m.selectedResult == nil {
		return "No test selected"
	}

	r := m.selectedResult

	b.WriteString(titleStyle.Render("Test: " + r.Name))
	b.WriteString("\n\n")

	statusText := string(r.Status)
	switch r.Status {
	case tests.StatusRunning:
		statusText = runningStyle.Render("RUNNING")
	case tests.StatusHalting:
		statusText = haltingStyle.Render("HALTING")
	case tests.StatusPending:
		statusText = normalStyle.Render("PENDING (not started yet)")
	case tests.StatusPassed:
		statusText = passedStyle.Render("PASSED")
	case tests.StatusFailed:
		statusText = failedStyle.Render("FAILED")
	case tests.StatusSkipped:
		statusText = normalStyle.Render("SKIPPED")
	}

	b.WriteString(fmt.Sprintf("Status:    %s\n", statusText))
	b.WriteString(fmt.Sprintf("Started:   %v\n", r.StartTime.Format("15:04:05")))

	if r.Status == tests.StatusRunning {
		elapsed := time.Since(r.StartTime)
		b.WriteString(fmt.Sprintf("Elapsed:   %v\n", elapsed.Round(time.Second)))
	} else if r.EndTime.IsZero() == false {
		b.WriteString(fmt.Sprintf("Duration:  %v\n", r.Duration.Round(time.Second)))
	}

	b.WriteString("\n")
	b.WriteString(headerStyle.Render("Output"))
	b.WriteString("\n")

	output := strings.Join(m.testOutputs[r.TestID], "\n")
	if output == "" {
		output = r.Output
	}

	if r.Status == tests.StatusPending {
		b.WriteString(normalStyle.Render("Test has not started yet...\n"))
	} else if output == "" {
		b.WriteString(normalStyle.Render("Waiting for output...\n"))
	} else {
		lines := strings.Split(output, "\n")
		maxLines := m.height - 15
		if maxLines < 5 {
			maxLines = 20
		}

		start := m.scrollOffset
		if start < 0 {
			start = 0
		}
		if start > len(lines)-maxLines {
			start = len(lines) - maxLines
		}
		if start < 0 {
			start = 0
		}
		end := start + maxLines
		if end > len(lines) {
			end = len(lines)
		}

		for _, line := range lines[start:end] {
			b.WriteString(logStyle.Render(line) + "\n")
		}

		if start > 0 {
			b.WriteString(normalStyle.Render(fmt.Sprintf("\n... %d more lines before", start)))
		}
		if end < len(lines) {
			b.WriteString(normalStyle.Render(fmt.Sprintf("\n... %d more lines", len(lines)-end)))
		}
	}

	b.WriteString("\n")
	if r.Status == tests.StatusRunning {
		b.WriteString(helpStyle.Render("s skip/cancel | up/k scroll up | down/j scroll down | esc back"))
	} else {
		b.WriteString(helpStyle.Render("up/k scroll up | down/j scroll down | esc back"))
	}

	return b.String()
}

func (m Model) viewResults() string {
	var b strings.Builder

	b.WriteString(titleStyle.Render("Results"))
	b.WriteString("\n\n")

	duration := m.endTime.Sub(m.startTime)
	if m.endTime.IsZero() {
		duration = time.Since(m.startTime)
	}

	summary := fmt.Sprintf("Total: %d  Passed: %d  Failed: %d  Skipped: %d  Duration: %v",
		len(m.testResults),
		m.passedCount,
		m.failedCount,
		m.skippedCount,
		duration.Round(time.Second),
	)
	b.WriteString(boxStyle.Render(summary))
	b.WriteString("\n\n")

	ids := make([]string, 0, len(m.testResults))
	for id := range m.testResults {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	for i, id := range ids {
		result := m.testResults[id]
		duration := result.Duration.Round(time.Millisecond)

		var styledLine string
		switch result.Status {
		case tests.StatusPassed:
			styledLine = "ok " + result.Name + " (" + duration.String() + ")"
			if i == m.cursor {
				b.WriteString(selectedStyle.Render("-> "))
				b.WriteString(passedStyle.Render(styledLine))
			} else {
				b.WriteString(passedStyle.Render("   " + styledLine))
			}
		case tests.StatusFailed:
			styledLine = "FAIL " + result.Name + " (" + duration.String() + ")"
			if i == m.cursor {
				b.WriteString(selectedStyle.Render("-> "))
				b.WriteString(failedStyle.Render(styledLine))
			} else {
				b.WriteString(failedStyle.Render("   " + styledLine))
			}
		default:
			styledLine = "skip " + result.Name + " (" + duration.String() + ")"
			if i == m.cursor {
				b.WriteString(selectedStyle.Render("-> "))
				b.WriteString(normalStyle.Render(styledLine))
			} else {
				b.WriteString(normalStyle.Render("   " + styledLine))
			}
		}
		b.WriteString("\n")
	}

	b.WriteString("\n")
	b.WriteString(helpStyle.Render("enter view details | e export | q quit"))

	if m.lastError != "" {
		b.WriteString("\n")
		if strings.Contains(m.lastError, "Saved") || strings.Contains(m.lastError, "Copied") {
			b.WriteString(passedStyle.Render(m.lastError))
		} else {
			b.WriteString(errorStyle.Render(m.lastError))
		}
	}

	return b.String()
}

func (m Model) viewDetail() string {
	var b strings.Builder

	if m.selectedResult == nil {
		return "No result selected"
	}

	r := m.selectedResult

	b.WriteString(titleStyle.Render("Result: " + r.Name))
	b.WriteString("\n\n")

	statusText := string(r.Status)
	switch r.Status {
	case tests.StatusPassed:
		statusText = passedStyle.Render("PASSED")
	case tests.StatusFailed:
		statusText = failedStyle.Render("FAILED")
	}

	b.WriteString(fmt.Sprintf("Status:    %s\n", statusText))
	b.WriteString(fmt.Sprintf("Duration:  %v\n", r.Duration.Round(time.Millisecond)))
	b.WriteString(fmt.Sprintf("Exit Code: %d\n", r.ExitCode))

	if r.Error != "" {
		b.WriteString(fmt.Sprintf("\nError:\n%s\n", errorStyle.Render(r.Error)))
	}

	b.WriteString("\n")
	b.WriteString(headerStyle.Render("Output"))
	b.WriteString("\n")

	output := r.Output
	if output == "" {
		output = strings.Join(m.testOutputs[r.TestID], "\n")
	}

	lines := strings.Split(output, "\n")
	maxLines := m.height - 15
	if maxLines < 5 {
		maxLines = 20
	}

	start := m.scrollOffset
	if start < 0 {
		start = 0
	}
	if start > len(lines)-maxLines {
		start = len(lines) - maxLines
	}
	if start < 0 {
		start = 0
	}
	end := start + maxLines
	if end > len(lines) {
		end = len(lines)
	}

	for _, line := range lines[start:end] {
		b.WriteString(logStyle.Render(line) + "\n")
	}

	if start > 0 {
		b.WriteString(normalStyle.Render(fmt.Sprintf("\n... %d more lines before", start)))
	}
	if end < len(lines) {
		b.WriteString(normalStyle.Render(fmt.Sprintf("\n... %d more lines", len(lines)-end)))
	}

	b.WriteString("\n")
	b.WriteString(helpStyle.Render("c copy | up/k scroll up | down/j scroll down | esc back"))

	if m.lastError != "" {
		b.WriteString("\n")
		if strings.Contains(m.lastError, "Copied") {
			b.WriteString(passedStyle.Render(m.lastError))
		} else {
			b.WriteString(errorStyle.Render(m.lastError))
		}
	}

	return b.String()
}

func (m Model) viewExport() string {
	var b strings.Builder

	b.WriteString(titleStyle.Render("Export Results"))
	b.WriteString("\n\n")

	formats := []struct {
		name        string
		description string
	}{
		{"JSON File", "Save to file"},
		{"HTML File", "Save to file"},
		{"JUnit File", "Save to file"},
		{"Copy to Clipboard", "->"},
	}

	for i, f := range formats {
		line := "   " + f.name + " - " + f.description
		if i == m.cursor {
			line = "-> " + f.name + " - " + f.description
			b.WriteString(selectedStyle.Render(line))
		} else {
			b.WriteString(normalStyle.Render(line))
		}
		b.WriteString("\n")
	}

	b.WriteString("\n")
	b.WriteString(helpStyle.Render("enter select | esc back"))

	return b.String()
}

func (m Model) viewExportCopy() string {
	var b strings.Builder

	b.WriteString(titleStyle.Render("Copy to Clipboard"))
	b.WriteString("\n\n")

	formats := []string{
		"Copy JSON",
		"Copy HTML",
		"Copy JUnit XML",
	}

	for i, f := range formats {
		if i == m.cursor {
			b.WriteString(selectedStyle.Render("-> " + f))
		} else {
			b.WriteString(normalStyle.Render("   " + f))
		}
		b.WriteString("\n")
	}

	b.WriteString("\n")
	b.WriteString(helpStyle.Render("enter copy | esc back"))

	if m.lastError != "" {
		b.WriteString("\n")
		if strings.Contains(m.lastError, "Copied") {
			b.WriteString(passedStyle.Render(m.lastError))
		} else {
			b.WriteString(errorStyle.Render(m.lastError))
		}
	}

	return b.String()
}
