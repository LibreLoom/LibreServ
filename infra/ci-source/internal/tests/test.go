package tests

import "time"

type TestType string

const (
	TestTypeUnit        TestType = "unit"
	TestTypeFuzz        TestType = "fuzz"
	TestTypeSecurity    TestType = "security"
	TestTypeIntegration TestType = "integration"
)

// ContainerHost is the sentinel Container value that runs a test directly on
// the host instead of in a container. It is an escape hatch, not a default:
// a test using it must say why in NeedsHost, and the registry panics on init
// if it does not, so "host" can never be an oversight.
const ContainerHost = "host"

// LocalImagePrefix marks a Container value as an image built from this repo
// (<repo>/infra/ci-source/images/<name>/Containerfile) instead of pulled from a
// registry. It lives here so both the registry and the runner can name it
// without an import cycle.
const LocalImagePrefix = "libreserv-ci/"

type Test struct {
	ID          string   `json:"id" yaml:"id"`
	Name        string   `json:"name" yaml:"name"`
	Description string   `json:"description" yaml:"description"`
	Type        TestType `json:"type" yaml:"type"`
	Container   string   `json:"container" yaml:"container"`
	// NeedsHost is required when Container is ContainerHost and must be empty
	// otherwise. It records the concrete constraint that keeps the test off a
	// container image, so the next reader can tell a real one from a mistake.
	NeedsHost    string        `json:"needsHost,omitempty" yaml:"needsHost,omitempty"`
	Command      string        `json:"command" yaml:"command"`
	WorkDir      string        `json:"workDir" yaml:"workDir"`
	Timeout      time.Duration `json:"timeout" yaml:"timeout"`
	Env          []string      `json:"env,omitempty" yaml:"env,omitempty"`
	Dependencies []string      `json:"dependencies,omitempty" yaml:"dependencies,omitempty"`
	SkipIf       string        `json:"skipIf,omitempty" yaml:"skipIf,omitempty"`
	FuzzPackage  string        `json:"fuzzPackage,omitempty" yaml:"fuzzPackage,omitempty"`
}

type TestResult struct {
	TestID      string        `json:"testId"`
	Name        string        `json:"name"`
	Status      TestStatus    `json:"status"`
	Duration    time.Duration `json:"duration"`
	StartTime   time.Time     `json:"startTime"`
	EndTime     time.Time     `json:"endTime"`
	Output      string        `json:"output"`
	Error       string        `json:"error,omitempty"`
	ExitCode    int           `json:"exitCode"`
	ContainerID string        `json:"containerId,omitempty"`
}

type TestStatus string

const (
	StatusPending   TestStatus = "pending"
	StatusRunning   TestStatus = "running"
	StatusHalting   TestStatus = "halting"
	StatusPassed    TestStatus = "passed"
	StatusFailed    TestStatus = "failed"
	StatusSkipped   TestStatus = "skipped"
	StatusCancelled TestStatus = "cancelled"
	StatusTimeout   TestStatus = "timeout"
)
