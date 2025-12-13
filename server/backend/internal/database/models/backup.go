package models

import "time"

type Backup struct {
	ID        string    `json:"id"`
	AppID     string    `json:"app_id,omitempty"`
	Type      string    `json:"type"` // app, system
	Path      string    `json:"path"`
	Size      int64     `json:"size"`
	CreatedAt time.Time `json:"created_at"`
}

type DatabaseBackup struct {
	ID        string    `json:"id"`
	Path      string    `json:"path"`
	Size      int64     `json:"size"`
	CreatedAt time.Time `json:"created_at"`
	Checksum  string    `json:"checksum"`
}

type BackupRepository interface {
	Create(backup *Backup) error
	GetByID(id string) (*Backup, error)
	List(filters map[string]interface{}) ([]*Backup, error)
	Delete(id string) error
}
