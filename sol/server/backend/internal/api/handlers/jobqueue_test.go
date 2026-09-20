package handlers

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/jobqueue"
)

type fakeQueueManager struct {
	job         jobqueue.JobInfo
	latest      jobqueue.JobInfo
	jobs        []*jobqueue.Job
	runningJobs []*jobqueue.Job
	stats       *jobqueue.QueueStats
	err         error
	running     bool
	lastStatus  jobqueue.JobStatus
	lastLimit   int
	lastDomain  string
	lastType    jobqueue.JobType
	cancelledID string
}

func (f *fakeQueueManager) GetJob(context.Context, string) (jobqueue.JobInfo, error) {
	return f.job, f.err
}
func (f *fakeQueueManager) GetLatestJob(_ context.Context, domain string, typ jobqueue.JobType) (jobqueue.JobInfo, error) {
	f.lastDomain, f.lastType = domain, typ
	return f.latest, f.err
}
func (f *fakeQueueManager) GetJobsByStatus(status jobqueue.JobStatus, limit int) ([]*jobqueue.Job, error) {
	f.lastStatus, f.lastLimit = status, limit
	return f.jobs, f.err
}
func (f *fakeQueueManager) GetPendingJobs(limit int) ([]*jobqueue.Job, error) {
	f.lastLimit = limit
	return f.jobs, f.err
}
func (f *fakeQueueManager) GetRunningJobs() ([]*jobqueue.Job, error) {
	return f.runningJobs, f.err
}
func (f *fakeQueueManager) GetQueueStats() (*jobqueue.QueueStats, error) {
	return f.stats, f.err
}
func (f *fakeQueueManager) CancelJob(id string) error {
	f.cancelledID = id
	return f.err
}
func (f *fakeQueueManager) IsRunning() bool { return f.running }

type nonConcreteJobInfo struct{}

func (nonConcreteJobInfo) GetID() string      { return "interface-job" }
func (nonConcreteJobInfo) GetStatus() string  { return "queued" }
func (nonConcreteJobInfo) GetDomain() string  { return "example.com" }
func (nonConcreteJobInfo) GetType() string    { return "issuance" }
func (nonConcreteJobInfo) GetPriority() int   { return 5 }
func (nonConcreteJobInfo) GetRetryCount() int { return 0 }
func (nonConcreteJobInfo) GetMaxRetries() int { return 3 }
func (nonConcreteJobInfo) IsTerminal() bool   { return false }

func requestWithJobParam(method, target, key, value string) *http.Request {
	req := httptest.NewRequest(method, target, nil)
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add(key, value)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))
}

func sampleHandlerJob() *jobqueue.Job {
	next := time.Now().Add(time.Hour)
	started := time.Now().Add(-time.Minute)
	ended := time.Now()
	return &jobqueue.Job{
		ID: "job-1", Type: jobqueue.JobTypeIssuance, Domain: "app.example.com",
		Email: "owner@example.com", RouteID: "route-1", Status: jobqueue.JobStatusRunning,
		Priority: jobqueue.PriorityCritical, Error: "example", RetryCount: 1, MaxRetries: 3,
		NextRetryAt: &next, CreatedAt: time.Now().Add(-time.Hour), StartedAt: &started, EndedAt: &ended,
		Logs:       []jobqueue.JobLogEntry{{Timestamp: time.Now(), Level: "INFO", Message: "working"}},
		WebhookURL: "https://hooks.example.com", WorkerID: "worker-1",
	}
}

func TestJobQueueListJobsFiltersAndResponses(t *testing.T) {
	job := sampleHandlerJob()
	tests := []struct {
		name       string
		target     string
		configure  func(*fakeQueueManager)
		wantStatus int
		check      func(*testing.T, *fakeQueueManager, string)
	}{
		{
			name: "pending defaults", target: "/jobs",
			configure:  func(f *fakeQueueManager) { f.jobs = []*jobqueue.Job{job} },
			wantStatus: http.StatusOK,
			check: func(t *testing.T, f *fakeQueueManager, body string) {
				if f.lastLimit != 50 || !strings.Contains(body, `"count":1`) || !strings.Contains(body, `"worker_id":"worker-1"`) {
					t.Fatalf("pending response = %s, limit %d", body, f.lastLimit)
				}
			},
		},
		{
			name: "status and limit", target: "/jobs?status=failed&limit=25",
			configure:  func(f *fakeQueueManager) { f.jobs = []*jobqueue.Job{} },
			wantStatus: http.StatusOK,
			check: func(t *testing.T, f *fakeQueueManager, _ string) {
				if f.lastStatus != jobqueue.JobStatusFailed || f.lastLimit != 25 {
					t.Fatalf("filter = %s, %d", f.lastStatus, f.lastLimit)
				}
			},
		},
		{
			name: "invalid limit", target: "/jobs?limit=5001",
			configure:  func(f *fakeQueueManager) {},
			wantStatus: http.StatusOK,
			check: func(t *testing.T, f *fakeQueueManager, _ string) {
				if f.lastLimit != 50 {
					t.Fatalf("invalid limit was accepted: %d", f.lastLimit)
				}
			},
		},
		{
			name: "domain", target: "/jobs?domain=app.example.com&type=renewal",
			configure:  func(f *fakeQueueManager) { f.latest = job },
			wantStatus: http.StatusOK,
			check: func(t *testing.T, f *fakeQueueManager, body string) {
				if f.lastDomain != "app.example.com" || f.lastType != jobqueue.JobTypeRenewal || !strings.Contains(body, `"count":1`) {
					t.Fatalf("domain result = %q, %q, %s", f.lastDomain, f.lastType, body)
				}
			},
		},
		{
			name: "non-concrete latest", target: "/jobs?domain=app.example.com",
			configure:  func(f *fakeQueueManager) { f.latest = nonConcreteJobInfo{} },
			wantStatus: http.StatusOK,
			check: func(t *testing.T, _ *fakeQueueManager, body string) {
				if !strings.Contains(body, `"count":0`) {
					t.Fatalf("body = %s", body)
				}
			},
		},
		{
			name: "pending error", target: "/jobs",
			configure:  func(f *fakeQueueManager) { f.err = errors.New("database") },
			wantStatus: http.StatusInternalServerError,
		},
		{
			name: "status error", target: "/jobs?status=failed",
			configure:  func(f *fakeQueueManager) { f.err = errors.New("database") },
			wantStatus: http.StatusInternalServerError,
		},
		{
			name: "domain error", target: "/jobs?domain=app.example.com",
			configure:  func(f *fakeQueueManager) { f.err = errors.New("database") },
			wantStatus: http.StatusInternalServerError,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fake := &fakeQueueManager{}
			tt.configure(fake)
			handler := NewJobQueueHandler(fake)
			rec := httptest.NewRecorder()
			handler.ListJobs(rec, httptest.NewRequest(http.MethodGet, tt.target, nil))
			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, body %s", rec.Code, rec.Body)
			}
			if tt.check != nil {
				tt.check(t, fake, rec.Body.String())
			}
		})
	}
}

func TestJobQueueGetCancelStatsRunningAndStatus(t *testing.T) {
	job := sampleHandlerJob()
	fake := &fakeQueueManager{
		job:         job,
		runningJobs: []*jobqueue.Job{job},
		stats:       &jobqueue.QueueStats{Pending: 1, Queued: 2, Running: 3, Succeeded: 4, Failed: 5, Total: 6},
		running:     true,
	}
	handler := NewJobQueueHandler(fake)

	tests := []struct {
		name   string
		call   func(http.ResponseWriter, *http.Request)
		req    *http.Request
		status int
		body   string
	}{
		{"get", handler.GetJob, requestWithJobParam(http.MethodGet, "/jobs/job-1", "id", "job-1"), http.StatusOK, `"id":"job-1"`},
		{"stats", handler.GetJobStats, httptest.NewRequest(http.MethodGet, "/jobs/stats", nil), http.StatusOK, `"succeeded":4`},
		{"cancel", handler.CancelJob, requestWithJobParam(http.MethodDelete, "/jobs/job-1", "id", "job-1"), http.StatusOK, `"job_id":"job-1"`},
		{"running", handler.GetRunningJobs, httptest.NewRequest(http.MethodGet, "/jobs/running", nil), http.StatusOK, `"count":1`},
		{"queue status", handler.GetQueueStatus, httptest.NewRequest(http.MethodGet, "/jobs/status", nil), http.StatusOK, `"status":"operational"`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			tt.call(rec, tt.req)
			if rec.Code != tt.status || !strings.Contains(rec.Body.String(), tt.body) {
				t.Fatalf("response = %d %s", rec.Code, rec.Body)
			}
		})
	}
	if fake.cancelledID != "job-1" {
		t.Fatalf("cancelled ID = %q", fake.cancelledID)
	}

	fake.running = false
	rec := httptest.NewRecorder()
	handler.GetQueueStatus(rec, httptest.NewRequest(http.MethodGet, "/jobs/status", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"status":"stopped"`) {
		t.Fatalf("stopped response = %d %s", rec.Code, rec.Body)
	}
}

func TestJobQueueEndpointErrors(t *testing.T) {
	tests := []struct {
		name   string
		setup  func(*fakeQueueManager)
		call   func(*JobQueueHandler, http.ResponseWriter, *http.Request)
		req    *http.Request
		status int
	}{
		{"get missing ID", func(*fakeQueueManager) {}, (*JobQueueHandler).GetJob, httptest.NewRequest(http.MethodGet, "/jobs/", nil), http.StatusBadRequest},
		{"get missing job", func(f *fakeQueueManager) { f.err = errors.New("missing") }, (*JobQueueHandler).GetJob, requestWithJobParam(http.MethodGet, "/jobs/x", "id", "x"), http.StatusNotFound},
		{"get wrong job type", func(f *fakeQueueManager) { f.job = nonConcreteJobInfo{} }, (*JobQueueHandler).GetJob, requestWithJobParam(http.MethodGet, "/jobs/x", "id", "x"), http.StatusInternalServerError},
		{"stats error", func(f *fakeQueueManager) { f.err = errors.New("stats") }, (*JobQueueHandler).GetJobStats, httptest.NewRequest(http.MethodGet, "/jobs/stats", nil), http.StatusInternalServerError},
		{"cancel missing ID", func(*fakeQueueManager) {}, (*JobQueueHandler).CancelJob, httptest.NewRequest(http.MethodDelete, "/jobs/", nil), http.StatusBadRequest},
		{"cancel error", func(f *fakeQueueManager) { f.err = errors.New("running") }, (*JobQueueHandler).CancelJob, requestWithJobParam(http.MethodDelete, "/jobs/x", "id", "x"), http.StatusBadRequest},
		{"running error", func(f *fakeQueueManager) { f.err = errors.New("database") }, (*JobQueueHandler).GetRunningJobs, httptest.NewRequest(http.MethodGet, "/jobs/running", nil), http.StatusInternalServerError},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fake := &fakeQueueManager{}
			tt.setup(fake)
			handler := NewJobQueueHandler(fake)
			rec := httptest.NewRecorder()
			tt.call(handler, rec, tt.req)
			if rec.Code != tt.status {
				t.Fatalf("status = %d, body %s", rec.Code, rec.Body)
			}
		})
	}
}

func TestJobToResponseCopiesFields(t *testing.T) {
	job := sampleHandlerJob()
	got := jobToResponse(job)
	if got.ID != job.ID || got.Type != string(job.Type) || got.Email != job.Email ||
		got.RouteID != job.RouteID || got.Status != string(job.Status) || got.Priority != int(job.Priority) ||
		got.Error != job.Error || got.RetryCount != job.RetryCount || got.MaxRetries != job.MaxRetries ||
		got.NextRetryAt != job.NextRetryAt || got.StartedAt != job.StartedAt || got.EndedAt != job.EndedAt ||
		len(got.Logs) != 1 || got.WebhookURL != job.WebhookURL || got.WorkerID != job.WorkerID {
		t.Fatalf("response = %+v", got)
	}
}
