package monitoring

import (
	"context"
	"testing"
)

func TestMetricsCollector_CollectAppMetrics_DockerUnavailable(t *testing.T) {
	mc := NewMetricsCollector(nil)

	_, err := mc.CollectAppMetrics(context.Background(), "app1")
	if err == nil {
		t.Fatalf("expected error")
	}
	if !IsDockerUnavailable(err) {
		t.Fatalf("expected docker unavailable error, got: %v", err)
	}
}

func TestMetricsCollector_CollectContainerMetrics_DockerUnavailable(t *testing.T) {
	mc := NewMetricsCollector(nil)

	_, err := mc.CollectContainerMetrics(context.Background(), "cid")
	if err == nil {
		t.Fatalf("expected error")
	}
	if !IsDockerUnavailable(err) {
		t.Fatalf("expected docker unavailable error, got: %v", err)
	}
}


