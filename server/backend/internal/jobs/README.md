# Jobs vs JobQueue

This directory contains two different background job systems with distinct purposes:

## `jobs/` - Simple Scheduler

**Purpose:** Periodic, time-based tasks that run on fixed schedules.

**Use when:**
- Task runs on a fixed interval (e.g., every 24 hours)
- No need for retry logic or priority queuing
- Task is idempotent and failure is acceptable
- Examples: update checks, cleanup tasks

**Current jobs:**
- App update checks (every 24h)
- System update checks (every 24h)

**Limitations:**
- No persistence (jobs lost on restart)
- No retry logic
- No priority system
- No job history tracking

## `jobqueue/` - Persistent Job Queue

**Purpose:** Reliable, tracked background operations with retry logic.

**Use when:**
- Task must complete successfully (retry on failure)
- Job progress needs tracking
- Multiple concurrent workers needed
- Job history/audit required
- Examples: ACME certificate issuance, renewal, revocation, validation

**Features:**
- SQLite persistence
- Priority queues
- Retry with exponential backoff
- Job status tracking
- Cancellation support
- Worker pool management

## Why these are separate (by design, not a deferral)

`jobqueue` is the **ACME certificate** queue: its `JobType`s are
`issuance`/`renewal`/`revocation`/`validation`, the `Job` schema carries
`Domain`/`Email`/`RouteID`, and it persists to the `acme_jobs` table. It is not a
general-purpose job queue.

`jobs.Scheduler` runs three fixed-interval periodic tasks (app/system update
checks + backup schedules). That is a different problem — periodic ticking, not
reliable queued work — so folding it in would mean generalizing an ACME-specific
queue to host non-cert tasks.

(`robfig/cron/v3` is used only to parse user-supplied cron expressions for
backup schedules, not for the scheduler's own ticking.)
