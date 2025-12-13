package network

import (
	"testing"
	"time"
)

func TestProbeTCPLoopbackClosed(t *testing.T) {
	res := ProbeTCP("127.0.0.1", 9, 500*time.Millisecond) // discard port likely closed
	if res.Reachable {
		t.Fatalf("expected unreachable for closed port")
	}
}
