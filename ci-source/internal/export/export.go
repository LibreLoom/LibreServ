package export

import (
	"encoding/json"
	"fmt"
	"html/template"
	"os"
	"path/filepath"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/tests"
)

type Exporter struct {
	outputDir string
}

func NewExporter(outputDir string) *Exporter {
	return &Exporter{outputDir: outputDir}
}

type Report struct {
	GeneratedAt time.Time            `json:"generatedAt"`
	Duration    time.Duration        `json:"duration"`
	Total       int                  `json:"total"`
	Passed      int                  `json:"passed"`
	Failed      int                  `json:"failed"`
	Skipped     int                  `json:"skipped"`
	Results     map[string]*TestInfo `json:"results"`
}

type TestInfo struct {
	ID       string        `json:"id"`
	Name     string        `json:"name"`
	Status   string        `json:"status"`
	Duration time.Duration `json:"duration"`
	ExitCode int           `json:"exitCode"`
	Output   string        `json:"output,omitempty"`
	Error    string        `json:"error,omitempty"`
}

func (e *Exporter) ExportJSON(results map[string]*tests.TestResult, duration time.Duration) (string, error) {
	report := e.buildReport(results, duration)

	data, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return "", fmt.Errorf("failed to marshal JSON: %w", err)
	}

	filename := filepath.Join(e.outputDir, fmt.Sprintf("ci-report-%s.json", time.Now().Format("20060102-150405")))
	if err := os.MkdirAll(e.outputDir, 0755); err != nil {
		return "", fmt.Errorf("failed to create output directory: %w", err)
	}

	if err := os.WriteFile(filename, data, 0644); err != nil {
		return "", fmt.Errorf("failed to write JSON file: %w", err)
	}

	return filename, nil
}

func (e *Exporter) ExportHTML(results map[string]*tests.TestResult, duration time.Duration) (string, error) {
	report := e.buildReport(results, duration)

	tmpl, err := template.New("report").Parse(htmlTemplate)
	if err != nil {
		return "", fmt.Errorf("failed to parse template: %w", err)
	}

	var buf strings.Builder
	if err := tmpl.Execute(&buf, report); err != nil {
		return "", fmt.Errorf("failed to execute template: %w", err)
	}

	filename := filepath.Join(e.outputDir, fmt.Sprintf("ci-report-%s.html", time.Now().Format("20060102-150405")))
	if err := os.MkdirAll(e.outputDir, 0755); err != nil {
		return "", fmt.Errorf("failed to create output directory: %w", err)
	}

	if err := os.WriteFile(filename, []byte(buf.String()), 0644); err != nil {
		return "", fmt.Errorf("failed to write HTML file: %w", err)
	}

	return filename, nil
}

func (e *Exporter) ExportJUnit(results map[string]*tests.TestResult, duration time.Duration) (string, error) {
	var buf strings.Builder

	buf.WriteString(`<?xml version="1.0" encoding="UTF-8"?>`)
	buf.WriteString(fmt.Sprintf("\n<testsuites name=\"LibreServ CI\" time=\"%.3f\">\n", duration.Seconds()))

	testsuites := make(map[string][]*tests.TestResult)
	for _, r := range results {
		tsName := "tests"
		testsuites[tsName] = append(testsuites[tsName], r)
	}

	for tsName, tsResults := range testsuites {
		failures := 0
		for _, r := range tsResults {
			if r.Status == tests.StatusFailed {
				failures++
			}
		}

		buf.WriteString(fmt.Sprintf("  <testsuite name=\"%s\" tests=\"%d\" failures=\"%d\">\n",
			tsName, len(tsResults), failures))

		for _, r := range tsResults {
			buf.WriteString(fmt.Sprintf("    <testcase name=\"%s\" classname=\"%s\" time=\"%.3f\"",
				r.Name, r.TestID, r.Duration.Seconds()))

			if r.Status == tests.StatusFailed {
				buf.WriteString(">\n")
				buf.WriteString(fmt.Sprintf("      <failure message=\"exit code %d\"><![CDATA[%s]]></failure>\n",
					r.ExitCode, escapeXML(r.Output)))
				buf.WriteString("    </testcase>\n")
			} else if r.Status == tests.StatusSkipped {
				buf.WriteString(">\n")
				buf.WriteString("      <skipped/>\n")
				buf.WriteString("    </testcase>\n")
			} else {
				buf.WriteString("/>\n")
			}
		}

		buf.WriteString("  </testsuite>\n")
	}

	buf.WriteString("</testsuites>\n")

	filename := filepath.Join(e.outputDir, fmt.Sprintf("junit-%s.xml", time.Now().Format("20060102-150405")))
	if err := os.MkdirAll(e.outputDir, 0755); err != nil {
		return "", fmt.Errorf("failed to create output directory: %w", err)
	}

	if err := os.WriteFile(filename, []byte(buf.String()), 0644); err != nil {
		return "", fmt.Errorf("failed to write JUnit file: %w", err)
	}

	return filename, nil
}

func (e *Exporter) buildReport(results map[string]*tests.TestResult, duration time.Duration) *Report {
	report := &Report{
		GeneratedAt: time.Now(),
		Duration:    duration,
		Results:     make(map[string]*TestInfo),
	}

	for id, r := range results {
		report.Results[id] = &TestInfo{
			ID:       r.TestID,
			Name:     r.Name,
			Status:   string(r.Status),
			Duration: r.Duration,
			ExitCode: r.ExitCode,
			Output:   r.Output,
			Error:    r.Error,
		}

		report.Total++
		switch r.Status {
		case tests.StatusPassed:
			report.Passed++
		case tests.StatusFailed:
			report.Failed++
		case tests.StatusSkipped:
			report.Skipped++
		}
	}

	return report
}

func (e *Exporter) ExportHTMLForClipboard(results map[string]*tests.TestResult, duration time.Duration) (string, error) {
	report := e.buildReport(results, duration)
	tmpl, err := template.New("report").Parse(htmlTemplate)
	if err != nil {
		return "", fmt.Errorf("failed to parse template: %w", err)
	}
	var buf strings.Builder
	if err := tmpl.Execute(&buf, report); err != nil {
		return "", fmt.Errorf("failed to execute template: %w", err)
	}
	return buf.String(), nil
}

func (e *Exporter) ExportJUnitForClipboard(results map[string]*tests.TestResult, duration time.Duration) (string, error) {
	var buf strings.Builder
	buf.WriteString(`<?xml version="1.0" encoding="UTF-8"?>`)
	buf.WriteString(fmt.Sprintf("\n<testsuites name=\"LibreServ CI\" time=\"%.3f\">\n", duration.Seconds()))

	testsuites := make(map[string][]*tests.TestResult)
	for _, r := range results {
		tsName := "tests"
		testsuites[tsName] = append(testsuites[tsName], r)
	}

	for tsName, tsResults := range testsuites {
		failures := 0
		for _, r := range tsResults {
			if r.Status == tests.StatusFailed {
				failures++
			}
		}
		buf.WriteString(fmt.Sprintf("  <testsuite name=\"%s\" tests=\"%d\" failures=\"%d\">\n", tsName, len(tsResults), failures))
		for _, r := range tsResults {
			buf.WriteString(fmt.Sprintf("    <testcase name=\"%s\" classname=\"%s\" time=\"%.3f\"", r.Name, r.TestID, r.Duration.Seconds()))
			if r.Status == tests.StatusFailed {
				buf.WriteString(">\n")
				buf.WriteString(fmt.Sprintf("      <failure message=\"exit code %d\"><![CDATA[%s]]></failure>\n", r.ExitCode, escapeXML(r.Output)))
				buf.WriteString("    </testcase>\n")
			} else if r.Status == tests.StatusSkipped {
				buf.WriteString(">\n      <skipped/>\n    </testcase>\n")
			} else {
				buf.WriteString("/>\n")
			}
		}
		buf.WriteString("  </testsuite>\n")
	}
	buf.WriteString("</testsuites>\n")
	return buf.String(), nil
}

func escapeXML(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	s = strings.ReplaceAll(s, "\"", "&quot;")
	s = strings.ReplaceAll(s, "'", "&apos;")
	return s
}

const htmlTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>LibreServ CI Report</title>
    <style>
        :root {
            --bg: #1a1b26;
            --card: #24283b;
            --border: #414868;
            --fg: #c0caf5;
            --muted: #565f89;
            --green: #9ece6a;
            --red: #f7768e;
            --yellow: #e0af68;
            --purple: #bb9af7;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: var(--bg);
            color: var(--fg);
            line-height: 1.6;
            padding: 2rem;
        }
        .container { max-width: 1200px; margin: 0 auto; }
        h1 { color: var(--purple); margin-bottom: 1rem; }
        .summary {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 1rem;
            margin-bottom: 2rem;
        }
        .summary-card {
            background: var(--card);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 1rem;
            text-align: center;
        }
        .summary-card h3 { color: var(--muted); font-size: 0.875rem; }
        .summary-card .value { font-size: 2rem; font-weight: bold; }
        .summary-card.passed .value { color: var(--green); }
        .summary-card.failed .value { color: var(--red); }
        .summary-card.skipped .value { color: var(--yellow); }
        .results { background: var(--card); border-radius: 8px; overflow: hidden; }
        .result-item {
            border-bottom: 1px solid var(--border);
            padding: 1rem;
            cursor: pointer;
        }
        .result-item:hover { background: rgba(255,255,255,0.05); }
        .result-header { display: flex; justify-content: space-between; align-items: center; }
        .result-name { font-weight: 500; }
        .result-status {
            padding: 0.25rem 0.75rem;
            border-radius: 4px;
            font-size: 0.75rem;
            font-weight: 600;
            text-transform: uppercase;
        }
        .result-status.passed { background: rgba(158,206,106,0.2); color: var(--green); }
        .result-status.failed { background: rgba(247,118,142,0.2); color: var(--red); }
        .result-status.skipped { background: rgba(224,175,104,0.2); color: var(--yellow); }
        .result-output {
            margin-top: 1rem;
            padding: 1rem;
            background: var(--bg);
            border-radius: 4px;
            font-family: monospace;
            font-size: 0.875rem;
            white-space: pre-wrap;
            max-height: 300px;
            overflow-y: auto;
        }
        .meta { color: var(--muted); font-size: 0.875rem; margin-top: 0.5rem; }
    </style>
</head>
<body>
    <div class="container">
        <h1>LibreServ CI Report</h1>
        <p class="meta">Generated: {{.GeneratedAt.Format "2006-01-02 15:04:05"}} | Duration: {{.Duration}}</p>
        
        <div class="summary">
            <div class="summary-card">
                <h3>Total</h3>
                <div class="value">{{.Total}}</div>
            </div>
            <div class="summary-card passed">
                <h3>Passed</h3>
                <div class="value">{{.Passed}}</div>
            </div>
            <div class="summary-card failed">
                <h3>Failed</h3>
                <div class="value">{{.Failed}}</div>
            </div>
            <div class="summary-card skipped">
                <h3>Skipped</h3>
                <div class="value">{{.Skipped}}</div>
            </div>
        </div>

        <div class="results">
            {{range $id, $r := .Results}}
            <div class="result-item" onclick="toggleOutput('{{$id}}')">
                <div class="result-header">
                    <span class="result-name">{{$r.Name}}</span>
                    <span class="result-status {{$r.Status}}">{{$r.Status}}</span>
                </div>
                <div class="meta">Duration: {{$r.Duration}} | Exit Code: {{$r.ExitCode}}</div>
                <div id="output-{{$id}}" class="result-output" style="display:none;">{{$r.Output}}</div>
            </div>
            {{end}}
        </div>
    </div>
    <script>
        function toggleOutput(id) {
            const el = document.getElementById('output-' + id);
            el.style.display = el.style.display === 'none' ? 'block' : 'none';
        }
    </script>
</body>
</html>`
