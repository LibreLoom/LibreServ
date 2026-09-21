package jobs

import (
	"path/filepath"
	"testing"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
)

func TestLeaderForcedByEnv(t *testing.T) {
	dir := t.TempDir()
	db, err := database.Open(filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	t.Setenv("LUNACONNECT_JOB_LEADER", "1")
	l := NewLeader(db)
	if !l.IsLeader() {
		t.Fatal("expected leader when LUNACONNECT_JOB_LEADER=1")
	}

	t.Setenv("LUNACONNECT_JOB_LEADER", "0")
	l2 := NewLeader(db)
	if l2.IsLeader() {
		t.Fatal("expected follower when LUNACONNECT_JOB_LEADER=0")
	}
}

func TestLeaderSQLiteFileLock(t *testing.T) {
	dir := t.TempDir()
	config.C.DataDir = dir
	t.Setenv("LUNACONNECT_JOB_LEADER", "")

	db, err := database.Open(filepath.Join(dir, "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	l1 := NewLeader(db)
	if !l1.IsLeader() {
		t.Fatal("first instance should acquire file lock")
	}
	defer l1.Close()

	l2 := NewLeader(db)
	if l2.IsLeader() {
		t.Fatal("second instance should not be leader while lock held")
	}
}
