package runner

import (
	"context"
	"testing"
	"time"
)

func TestSlotPoolBoundsConcurrentJobs(t *testing.T) {
	dir := t.TempDir()
	a, err := newSlotPoolIn(dir, 2)
	if err != nil {
		t.Fatal(err)
	}
	// A second pool on the same directory stands in for a second ci process.
	b, _ := newSlotPoolIn(dir, 2)

	r1, err := a.Acquire(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	r2, err := b.Acquire(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 700*time.Millisecond)
	defer cancel()
	waited := false
	if _, err := a.Acquire(ctx, func() { waited = true }); err == nil {
		t.Fatal("a third job got a slot although both were taken")
	}
	if !waited {
		t.Fatal("onWait was not called")
	}

	r1()
	r3, err := b.Acquire(context.Background(), nil)
	if err != nil {
		t.Fatalf("freed slot not reusable: %v", err)
	}
	r2()
	r3()
}
