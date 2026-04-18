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
- Examples: certificate requests, backup operations, app installs

**Features:**
- SQLite persistence
- Priority queues
- Retry with exponential backoff
- Job status tracking
- Cancellation support
- Worker pool management

## Future Work

**TODO:** Consider migrating `jobs.Scheduler` to use `jobqueue` for:
- Better visibility into update check failures
- Ability to manually trigger update checks
- Consistent job tracking across the system

**Decision:** Keep separate for now due to simplicity of scheduler vs complexity of jobqueue integration overhead.
