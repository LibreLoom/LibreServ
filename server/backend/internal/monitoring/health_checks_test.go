package monitoring

import (
	"context"
	"testing"

	"github.com/docker/docker/api/types"
)

func TestPickContainer_PrefersComposeProjectLabelAndRunning(t *testing.T) {
	containers := []types.Container{
		{
			ID:    "a",
			State: "exited",
			Labels: map[string]string{
				"com.docker.compose.project": "proj1",
			},
		},
		{
			ID:    "b",
			State: "running",
			Labels: map[string]string{
				"com.docker.compose.project": "proj1",
			},
		},
	}

	got := pickContainer(containers, "proj1")
	if got == nil || got.ID != "b" {
		t.Fatalf("expected running container 'b', got %#v", got)
	}
}

func TestPickContainer_FallsBackToNameMatch(t *testing.T) {
	containers := []types.Container{
		{
			ID:    "a",
			State: "running",
			Names: []string{"/unrelated"},
		},
		{
			ID:    "b",
			State: "running",
			Names: []string{"/myapp_web_1"},
		},
	}

	got := pickContainer(containers, "myapp")
	if got == nil || got.ID != "b" {
		t.Fatalf("expected name-matched container 'b', got %#v", got)
	}
}

func TestContainerCheck_Run_WithNilDockerClient_Degrades(t *testing.T) {
	cc := NewContainerCheck(ContainerCheckConfig{ContainerName: "anything"}, nil)
	res := cc.Run(context.Background())

	if res.Status != HealthStatusDegraded {
		t.Fatalf("expected degraded, got %q", res.Status)
	}
	if res.Message == "" {
		t.Fatalf("expected a message")
	}
}


