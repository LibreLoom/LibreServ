package tests

import "time"

type TestType string

const (
	TestTypeUnit        TestType = "unit"
	TestTypeFuzz        TestType = "fuzz"
	TestTypeE2E         TestType = "e2e"
	TestTypeSecurity    TestType = "security"
	TestTypeIntegration TestType = "integration"
)

type Test struct {
	ID           string        `json:"id" yaml:"id"`
	Name         string        `json:"name" yaml:"name"`
	Description  string        `json:"description" yaml:"description"`
	Type         TestType      `json:"type" yaml:"type"`
	Container    string        `json:"container" yaml:"container"`
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
