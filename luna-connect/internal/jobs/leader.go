package jobs

import (
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
)

// advisoryLockID is a fixed Postgres advisory lock key for Luna Connect background jobs.
const advisoryLockID int64 = 840015001

// Leader decides whether this process should run singleton background jobs.
type Leader struct {
	db       *database.DB
	explicit bool
	forced   bool
	leader   bool
	lockFile *os.File
}

// NewLeader resolves leadership for this process.
//
// Priority:
//  1. LUNACONNECT_JOB_LEADER=1 forces leader; =0 forces follower.
//  2. Postgres: pg_try_advisory_lock when env is unset.
//  3. SQLite/shared data dir: non-blocking flock on {data_dir}/job-leader.lock.
//  4. Otherwise leader (single local dev instance).
func NewLeader(db *database.DB) *Leader {
	l := &Leader{db: db}
	switch jobLeaderEnv() {
	case 1:
		l.explicit = true
		l.forced = true
		l.leader = true
		return l
	case 0:
		l.explicit = true
		l.leader = false
		return l
	}
	if db != nil && db.Driver() == database.DriverPostgres {
		var ok bool
		if err := db.QueryRow(`SELECT pg_try_advisory_lock($1)`, advisoryLockID).Scan(&ok); err == nil && ok {
			l.leader = true
			return l
		}
		l.leader = false
		return l
	}
	if f, ok := tryJobLockFile(); ok {
		l.lockFile = f
		l.leader = true
		return l
	}
	l.leader = false
	return l
}

func jobLeaderEnv() int {
	v := strings.TrimSpace(os.Getenv("LUNACONNECT_JOB_LEADER"))
	if v == "" {
		return -1
	}
	if v == "1" || strings.EqualFold(v, "true") || strings.EqualFold(v, "yes") {
		return 1
	}
	if v == "0" || strings.EqualFold(v, "false") || strings.EqualFold(v, "no") {
		return 0
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return -1
	}
	if n == 1 {
		return 1
	}
	if n == 0 {
		return 0
	}
	return -1
}

func tryJobLockFile() (*os.File, bool) {
	dir := strings.TrimSpace(config.C.DataDir)
	if dir == "" {
		dir = "dev/data"
	}
	path := filepath.Join(dir, "job-leader.lock")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, false
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, false
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		return nil, false
	}
	return f, true
}

// IsLeader reports whether singleton background jobs should run here.
func (l *Leader) IsLeader() bool {
	if l == nil {
		return false
	}
	return l.leader
}

// Close releases advisory/file locks held by this leader.
func (l *Leader) Close() {
	if l == nil {
		return
	}
	if l.lockFile != nil {
		_ = syscall.Flock(int(l.lockFile.Fd()), syscall.LOCK_UN)
		_ = l.lockFile.Close()
		l.lockFile = nil
	}
	if l.db != nil && l.db.Driver() == database.DriverPostgres && l.leader && !l.explicit {
		_, _ = l.db.Exec(`SELECT pg_advisory_unlock($1)`, advisoryLockID)
	}
}

// LogStartup emits one line about job leadership for operators.
func (l *Leader) LogStartup() {
	if l == nil {
		return
	}
	if l.leader {
		mode := "auto"
		if l.forced {
			mode = "env"
		} else if l.lockFile != nil {
			mode = "file-lock"
		} else if l.db != nil && l.db.Driver() == database.DriverPostgres {
			mode = "postgres-advisory-lock"
		}
		slog.Info("background job leader", "leader", true, "mode", mode)
		return
	}
	slog.Info("background job leader", "leader", false, "hint", "set LUNACONNECT_JOB_LEADER=1 on one instance or use Postgres advisory lock")
}
