package apps

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"gopkg.in/yaml.v3"
)

// Catalog manages the collection of available apps
type Catalog struct {
	mu          sync.RWMutex
	apps        map[string]*AppDefinition
	catalogPath string
}

// NewCatalog creates a new app catalog from the given path
func NewCatalog(catalogPath string) (*Catalog, error) {
	c := &Catalog{
		apps:        make(map[string]*AppDefinition),
		catalogPath: catalogPath,
	}

	if err := c.Load(); err != nil {
		return nil, fmt.Errorf("failed to load catalog: %w", err)
	}

	return c, nil
}

// Load reads all app definitions from the catalog directory
func (c *Catalog) Load() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.apps = make(map[string]*AppDefinition)

	if _, err := os.Stat(c.catalogPath); os.IsNotExist(err) {
		return fmt.Errorf("catalog path does not exist: %s", c.catalogPath)
	}

	appsPath := filepath.Join(c.catalogPath, "apps")
	if err := c.loadAppsFromDir(appsPath, AppTypeRepo); err != nil {
		if !os.IsNotExist(err) {
			return fmt.Errorf("failed to load repo apps: %w", err)
		}
	}

	return nil
}

// loadAppsFromDir loads all app definitions from a directory
func (c *Catalog) loadAppsFromDir(dirPath string, appType AppType) error {
	entries, err := os.ReadDir(dirPath)
	if err != nil {
		return err
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}

		appPath := filepath.Join(dirPath, entry.Name())
		metaPath := filepath.Join(appPath, "app.yaml")

		// Check if app.yaml exists
		if _, err := os.Stat(metaPath); os.IsNotExist(err) {
			continue
		}

		// Load the app definition
		app, err := c.loadAppDefinition(metaPath)
		if err != nil {
			return fmt.Errorf("failed to load app %s: %w", entry.Name(), err)
		}

		// Set additional metadata
		app.Type = appType
		app.CatalogPath = appPath

		// Use directory name as ID if not specified
		if app.ID == "" {
			app.ID = entry.Name()
		}

		if _, exists := c.apps[app.ID]; exists {
			return fmt.Errorf("duplicate app ID %q in %s", app.ID, appPath)
		}
		c.apps[app.ID] = app
	}

	return nil
}

// loadAppDefinition loads a single app definition from a YAML file
func (c *Catalog) loadAppDefinition(path string) (*AppDefinition, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("failed to read file: %w", err)
	}

	var app AppDefinition
	if err := yaml.Unmarshal(data, &app); err != nil {
		return nil, fmt.Errorf("failed to parse YAML: %w", err)
	}

	// Validate required fields
	if err := c.validateAppDefinition(&app); err != nil {
		return nil, fmt.Errorf("validation failed: %w", err)
	}

	return &app, nil
}

// validateAppDefinition validates that an app definition has all required fields
func (c *Catalog) validateAppDefinition(app *AppDefinition) error {
	if app.Name == "" {
		return fmt.Errorf("app name is required")
	}
	if app.Description == "" {
		return fmt.Errorf("app description is required")
	}
	if app.Deployment.ComposeFile == "" && app.Deployment.Image == "" {
		return fmt.Errorf("either compose_file or image must be specified")
	}

	// Validate health check configuration
	if err := c.validateHealthCheck(app); err != nil {
		return err
	}

	// Validate deployment port ranges
	if err := c.validatePorts(app); err != nil {
		return err
	}

	return nil
}

// validateHealthCheck checks that health check type and port are valid.
func (c *Catalog) validateHealthCheck(app *AppDefinition) error {
	if app.HealthCheck.Type == "" {
		return nil
	}
	switch app.HealthCheck.Type {
	case "http", "tcp", "container", "command":
	default:
		return fmt.Errorf("invalid health check type: %s", app.HealthCheck.Type)
	}

	// For http and tcp, port must be 0 (resolve at install) or 1-65535
	if app.HealthCheck.Type == "http" || app.HealthCheck.Type == "tcp" {
		p := app.HealthCheck.Port
		if p != 0 && (p < 1 || p > 65535) {
			return fmt.Errorf("health check port %d out of range (1-65535)", p)
		}
	}
	return nil
}

// validatePorts checks that all deployment port mappings are in valid range.
func (c *Catalog) validatePorts(app *AppDefinition) error {
	for _, pm := range app.Deployment.Ports {
		if pm.Host < 0 || pm.Host > 65535 {
			return fmt.Errorf("deployment port %d out of range (0-65535)", pm.Host)
		}
		if pm.Container < 0 || pm.Container > 65535 {
			return fmt.Errorf("deployment port %d out of range (0-65535)", pm.Container)
		}
	}
	return nil
}

// GetApp returns an app definition by ID.
// Returns a copy to prevent callers from mutating the catalog's canonical state.
func (c *Catalog) GetApp(id string) (*AppDefinition, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	app, ok := c.apps[id]
	if !ok {
		return nil, fmt.Errorf("app not found: %s", id)
	}

	return app.Clone(), nil
}

// ListApps returns all apps matching the given filters
func (c *Catalog) ListApps(filters CatalogFilters) []*AppDefinition {
	c.mu.RLock()
	defer c.mu.RUnlock()

	var result []*AppDefinition

	for _, app := range c.apps {
		// Apply filters
		if filters.Category != "" && app.Category != filters.Category {
			continue
		}
		if filters.Type != "" && app.Type != filters.Type {
			continue
		}
		if filters.Featured && !app.Featured {
			continue
		}
		if filters.Search != "" && !c.matchesSearch(app, filters.Search) {
			continue
		}

		result = append(result, app)
	}

	// Sort by name
	sort.Slice(result, func(i, j int) bool {
		// Featured apps first
		if result[i].Featured != result[j].Featured {
			return result[i].Featured
		}
		return result[i].Name < result[j].Name
	})

	return result
}

// matchesSearch checks if an app matches a search query
func (c *Catalog) matchesSearch(app *AppDefinition, query string) bool {
	query = strings.ToLower(query)
	return strings.Contains(strings.ToLower(app.Name), query) ||
		strings.Contains(strings.ToLower(app.Description), query) ||
		strings.Contains(strings.ToLower(string(app.Category)), query)
}

// GetCategories returns all unique categories in the catalog
func (c *Catalog) GetCategories() []AppCategory {
	c.mu.RLock()
	defer c.mu.RUnlock()

	categoryMap := make(map[AppCategory]bool)
	for _, app := range c.apps {
		categoryMap[app.Category] = true
	}

	var categories []AppCategory
	for cat := range categoryMap {
		categories = append(categories, cat)
	}

	sort.Slice(categories, func(i, j int) bool {
		return categories[i] < categories[j]
	})

	return categories
}

// Count returns the total number of apps in the catalog
func (c *Catalog) Count() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return len(c.apps)
}

// Refresh reloads the catalog from disk
func (c *Catalog) Refresh() error {
	return c.Load()
}

// CatalogFilters defines filters for listing apps
type CatalogFilters struct {
	Category AppCategory
	Type     AppType
	Featured bool
	Search   string
}

// GetComposeFilePath returns the full path to the compose file for an app
func (c *Catalog) GetComposeFilePath(appID string) (string, error) {
	app, err := c.GetApp(appID)
	if err != nil {
		return "", err
	}

	composePath := app.Deployment.ComposeFile
	if composePath == "" {
		composePath = "docker-compose.yml.tmpl"
	}

	return filepath.Join(app.CatalogPath, composePath), nil
}
