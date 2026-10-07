package engine

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func job(id string, deps ...string) Job {
	return Job{ID: id, Deps: deps, Run: func(ctx context.Context, j *JobRun) error { return nil }}
}

func TestValidate(t *testing.T) {
	g := NewGraph()
	g.Add(job("a", "b"), job("b", "a"))
	if err := g.Validate(); err == nil {
		t.Fatal("cycle not detected")
	}
	g = NewGraph()
	g.Add(job("a", "zzz"))
	if err := g.Validate(); err == nil {
		t.Fatal("unknown dep not detected")
	}
	g = NewGraph()
	if err := g.Add(job("a"), job("a")); err == nil {
		t.Fatal("duplicate not detected")
	}
}

func TestOrderAndParallelCap(t *testing.T) {
	var cur, peak int32
	var mu sync.Mutex
	var order []string
	mk := func(id string, deps ...string) Job {
		return Job{ID: id, Deps: deps, Run: func(ctx context.Context, j *JobRun) error {
			c := atomic.AddInt32(&cur, 1)
			for {
				p := atomic.LoadInt32(&peak)
				if c <= p || atomic.CompareAndSwapInt32(&peak, p, c) {
					break
				}
			}
			time.Sleep(20 * time.Millisecond)
			atomic.AddInt32(&cur, -1)
			mu.Lock()
			order = append(order, id)
			mu.Unlock()
			return nil
		}}
	}
	g := NewGraph()
	g.Add(mk("root"), mk("a", "root"), mk("b", "root"), mk("c", "root"), mk("d", "root"), mk("end", "a", "b", "c", "d"))
	res, err := g.Run(context.Background(), Options{Jobs: 2})
	if err != nil || !res.OK() {
		t.Fatal(err, res.FirstError())
	}
	if peak > 2 {
		t.Fatalf("peak parallelism %d > 2", peak)
	}
	if peak < 2 {
		t.Fatalf("expected parallelism 2, got %d", peak)
	}
	if order[0] != "root" || order[len(order)-1] != "end" {
		t.Fatalf("bad order %v", order)
	}
}

func TestHeavyCap(t *testing.T) {
	var cur, peak int32
	mk := func(id string, heavy bool) Job {
		return Job{ID: id, Heavy: heavy, Run: func(ctx context.Context, j *JobRun) error {
			if heavy {
				c := atomic.AddInt32(&cur, 1)
				for {
					p := atomic.LoadInt32(&peak)
					if c <= p || atomic.CompareAndSwapInt32(&peak, p, c) {
						break
					}
				}
				defer atomic.AddInt32(&cur, -1)
			}
			time.Sleep(20 * time.Millisecond)
			return nil
		}}
	}
	g := NewGraph()
	for _, id := range []string{"h1", "h2", "h3", "h4"} {
		g.Add(mk(id, true))
	}
	g.Add(mk("l1", false), mk("l2", false))
	res, _ := g.Run(context.Background(), Options{Jobs: 6, HeavyJobs: 1})
	if !res.OK() || peak != 1 {
		t.Fatalf("ok=%v heavy peak=%d", res.OK(), peak)
	}
}

func TestFailureSkipsDependents(t *testing.T) {
	boom := errors.New("boom")
	g := NewGraph()
	g.Add(
		Job{ID: "bad", Run: func(ctx context.Context, j *JobRun) error { return boom }},
		job("child", "bad"),
		job("grandchild", "child"),
		job("other"),
	)
	res, _ := g.Run(context.Background(), Options{Jobs: 4})
	want := map[string]Status{"bad": Failed, "child": Skipped, "grandchild": Skipped, "other": Succeeded}
	for id, st := range want {
		if r, _ := res.Get(id); r.Status != st {
			t.Errorf("%s = %v, want %v", id, r.Status, st)
		}
	}
	if !errors.Is(res.Jobs[0].Err, boom) {
		t.Error("error lost")
	}
}

func TestFailFastCancels(t *testing.T) {
	started := make(chan struct{})
	g := NewGraph()
	g.Add(
		Job{ID: "slow", Run: func(ctx context.Context, j *JobRun) error {
			close(started)
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(10 * time.Second):
				return nil
			}
		}},
		Job{ID: "bad", Run: func(ctx context.Context, j *JobRun) error {
			<-started
			return errors.New("boom")
		}},
		job("never", "slow"),
	)
	t0 := time.Now()
	res, _ := g.Run(context.Background(), Options{Jobs: 4, FailFast: true})
	if time.Since(t0) > 5*time.Second {
		t.Fatal("fail-fast did not cancel")
	}
	for id, st := range map[string]Status{"slow": Cancelled, "bad": Failed, "never": Skipped} {
		if r, _ := res.Get(id); r.Status != st {
			t.Errorf("%s = %v, want %v", id, r.Status, st)
		}
	}
}

func TestParentCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	g := NewGraph()
	g.Add(Job{ID: "a", Run: func(ctx context.Context, j *JobRun) error {
		cancel()
		<-ctx.Done()
		return ctx.Err()
	}}, job("b", "a"))
	res, _ := g.Run(ctx, Options{})
	if r, _ := res.Get("a"); r.Status != Cancelled {
		t.Errorf("a = %v", r.Status)
	}
	if r, _ := res.Get("b"); r.Status != Skipped {
		t.Errorf("b = %v", r.Status)
	}
	if err := res.FirstError(); !errors.Is(err, context.Canceled) {
		t.Errorf("a stopped run must report an error wrapping context.Canceled, got %v", err)
	}
}

func TestEventsAndRedaction(t *testing.T) {
	red := &Redactor{}
	red.Add("hunter2-secret")
	g := NewGraph()
	g.Add(Job{ID: "x", Run: func(ctx context.Context, j *JobRun) error {
		j.Log("password is hunter2-secret ok")
		return nil
	}})
	var evs []Event
	res, _ := g.Run(context.Background(), Options{Redactor: red, OnEvent: func(e Event) { evs = append(evs, e) }})
	if !res.OK() {
		t.Fatal("not ok")
	}
	var types []EventType
	var line string
	for _, e := range evs {
		types = append(types, e.Type)
		if e.Type == EventLog {
			line = e.Line
		}
	}
	want := []EventType{EventQueued, EventStarted, EventLog, EventFinished, EventGraphDone}
	if len(types) != len(want) {
		t.Fatalf("events %v", types)
	}
	for i := range want {
		if types[i] != want[i] {
			t.Fatalf("events %v, want %v", types, want)
		}
	}
	if line != "password is *** ok" {
		t.Fatalf("not redacted: %q", line)
	}
}

func TestPanicIsFailure(t *testing.T) {
	g := NewGraph()
	g.Add(Job{ID: "p", Run: func(ctx context.Context, j *JobRun) error { panic("oops") }})
	res, _ := g.Run(context.Background(), Options{})
	if r, _ := res.Get("p"); r.Status != Failed {
		t.Fatal(r.Status)
	}
}

// Every job, skipped ones included, finishes exactly once, and the graph is
// done only after the last of them.
func TestSkippedJobsFinishOnce(t *testing.T) {
	g := NewGraph()
	g.Add(
		Job{ID: "bad", Run: func(ctx context.Context, j *JobRun) error { return errors.New("boom") }},
		job("child", "bad"),
		job("grandchild", "child"),
		job("sibling", "bad"),
	)
	finished := map[string]int{}
	doneAfter := -1
	var evs int
	res, _ := g.Run(context.Background(), Options{Jobs: 2, OnEvent: func(e Event) {
		evs++
		switch e.Type {
		case EventFinished:
			finished[e.Job]++
		case EventGraphDone:
			doneAfter = len(finished)
		}
	}})
	if len(finished) != 4 || doneAfter != 4 {
		t.Fatalf("finished %v, done after %d jobs", finished, doneAfter)
	}
	for id, n := range finished {
		if n != 1 {
			t.Errorf("%s finished %d times", id, n)
		}
	}
	if res.OK() {
		t.Error("a failed graph reported OK")
	}
}
