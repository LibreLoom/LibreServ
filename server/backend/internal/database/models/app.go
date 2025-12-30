package models

import "time"

// App represents an app record stored in the database.
type App struct {
	ID           string                 `json:"id"`
	Name         string                 `json:"name"`
	Type         string                 `json:"type"` // builtin, custom, external
	Source       string                 `json:"source"`
	Path         string                 `json:"path"`
	Status       string                 `json:"status"`
	HealthStatus string                 `json:"health_status"`
	InstalledAt  time.Time              `json:"installed_at"`
	UpdatedAt    time.Time              `json:"updated_at"`
	Metadata     map[string]interface{} `json:"metadata"`
}

// AppRepository defines database operations for apps.
type AppRepository interface {
	Create(app *App) error
	GetByID(id string) (*App, error)
	List(filters map[string]interface{}) ([]*App, error)
	Update(app *App) error
	Delete(id string) error
	UpdateStatus(id, status string) error
	UpdateHealth(id, health string) error
}
