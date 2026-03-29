package apps

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/docker"
)

// instanceIDPattern validates that instance IDs contain only safe characters
var instanceIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

type ScriptExecutor struct {
	logger       *slog.Logger
	dockerClient *docker.Client
	basePath     string
	catalogPath  string
}

func NewScriptExecutor(logger *slog.Logger, dockerClient *docker.Client, basePath string) *ScriptExecutor {
	return &ScriptExecutor{
		logger:       logger,
		dockerClient: dockerClient,
		basePath:     basePath,
		catalogPath:  "",
	}
}

func NewScriptExecutorWithCatalog(logger *slog.Logger, dockerClient *docker.Client, basePath, catalogPath string) *ScriptExecutor {
	return &ScriptExecutor{
		logger:       logger,
		dockerClient: dockerClient,
		basePath:     basePath,
		catalogPath:  catalogPath,
	}
}

// validateInstanceID ensures the instance ID is safe and prevents path traversal
func (e *ScriptExecutor) validateInstanceID(instanceID string) error {
	if instanceID == "" {
		return fmt.Errorf("instance ID cannot be empty")
	}
	if len(instanceID) > 64 {
		return fmt.Errorf("instance ID too long (max 64 characters)")
	}
	if !instanceIDPattern.MatchString(instanceID) {
		return fmt.Errorf("instance ID contains invalid characters (only letters, numbers, hyphens, and underscores allowed)")
	}
	// Additional check for path traversal attempts
	if strings.Contains(instanceID, "..") || strings.Contains(instanceID, "/") || strings.Contains(instanceID, "\\") {
		return fmt.Errorf("instance ID cannot contain path separators")
	}
	return nil
}

// validateScriptPath checks if a script path is safe to execute
// It resolves symlinks and verifies the final path is within allowed directory
func (e *ScriptExecutor) validateScriptPath(scriptPath string) (string, error) {
	// Resolve any symlinks to prevent TOCTOU attacks
	resolvedPath, err := filepath.EvalSymlinks(scriptPath)
	if err != nil {
		return "", fmt.Errorf("failed to resolve script path: %w", err)
	}

	absScriptPath, err := filepath.Abs(resolvedPath)
	if err != nil {
		return "", fmt.Errorf("failed to resolve script path: %w", err)
	}
	absScriptPath = filepath.Clean(absScriptPath)

	// Check if path is within apps data directory
	absBasePath, err := filepath.Abs(e.basePath)
	if err != nil {
		return "", fmt.Errorf("failed to resolve base path: %w", err)
	}
	absBasePath = filepath.Clean(absBasePath)

	if strings.HasPrefix(absScriptPath, absBasePath+string(filepath.Separator)) {
		return absScriptPath, nil
	}

	// Check if path is within catalog directory (for builtin app scripts)
	if e.catalogPath != "" {
		absCatalogPath, err := filepath.Abs(e.catalogPath)
		if err != nil {
			return "", fmt.Errorf("failed to resolve catalog path: %w", err)
		}
		absCatalogPath = filepath.Clean(absCatalogPath)

		if strings.HasPrefix(absScriptPath, absCatalogPath+string(filepath.Separator)) {
			return absScriptPath, nil
		}
	}

	return "", fmt.Errorf("script path outside allowed directory: %s", scriptPath)
}

func (e *ScriptExecutor) Execute(ctx context.Context, instanceID, scriptPath string, options map[string]interface{}) (*ScriptResult, error) {
	startTime := time.Now()

	// Validate instance ID to prevent path traversal attacks
	if err := e.validateInstanceID(instanceID); err != nil {
		return &ScriptResult{
			Success:  false,
			Error:    fmt.Sprintf("Invalid app identifier: %s", err.Error()),
			Duration: time.Since(startTime),
		}, fmt.Errorf("invalid instance ID: %w", err)
	}

	// Validate and resolve script path (prevents symlink attacks)
	validatedPath, err := e.validateScriptPath(scriptPath)
	if err != nil {
		return &ScriptResult{
			Success:  false,
			Error:    "Script path validation failed",
			Duration: time.Since(startTime),
		}, err
	}

	if _, err := os.Stat(validatedPath); os.IsNotExist(err) {
		return &ScriptResult{
			Success:  false,
			Error:    "The requested action is not available for this app",
			Duration: time.Since(startTime),
		}, fmt.Errorf("script not found: %s", validatedPath)
	}

	// Install path is derived from validated script path (script is at {installPath}/scripts/{name})
	installPath := filepath.Dir(filepath.Dir(validatedPath))
	appDataPath := filepath.Join(installPath, "data")
	configPath := filepath.Join(installPath, "config.json")

	scriptConfig := ScriptExecutionConfig{
		InstanceID:  instanceID,
		InstallPath: installPath,
		AppDataPath: appDataPath,
		ConfigPath:  configPath,
		Runtime: RuntimeInfo{
			ComposeFile: filepath.Join(installPath, "app-compose", "docker-compose.yml"),
			ProjectName: fmt.Sprintf("libreserv-%s", instanceID),
		},
		Options: options,
	}

	configFile, err := e.createConfigFile(configPath, scriptConfig)
	if err != nil {
		return &ScriptResult{
			Success:  false,
			Error:    fmt.Sprintf("failed to create config file: %v", err),
			Duration: time.Since(startTime),
		}, err
	}
	defer os.Remove(configFile)

	cmd := exec.CommandContext(ctx, validatedPath, configFile)
	cmd.Dir = installPath

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	e.logger.Debug("executing script",
		"script", validatedPath,
		"instance_id", instanceID,
		"config_file", configFile)

	err = cmd.Run()
	duration := time.Since(startTime)

	output := stdout.String()
	stderrOutput := stderr.String()

	result := &ScriptResult{
		ExitCode: 0,
		Output:   output,
		Duration: duration,
	}

	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			result.ExitCode = exitErr.ExitCode()
		}
		result.Error = stderrOutput
		if result.Error == "" {
			result.Error = err.Error()
		}
	}

	result.Success = result.ExitCode == 0

	e.logger.Debug("script execution completed",
		"script", scriptPath,
		"success", result.Success,
		"exit_code", result.ExitCode,
		"duration", duration)

	if !result.Success && result.Output != "" {
		result.Error = result.Output + "\n" + result.Error
		result.Output = ""
	}

	data := e.parseScriptOutput(output)
	if data != nil {
		result.Data = data
		if exposedInfo, ok := data["exposed_info"].(map[string]interface{}); ok {
			result.ExposedInfo = e.validateExposedInfo(exposedInfo)
		}
	}

	return result, nil
}

// validateExposedInfo ensures script output's exposed_info has valid structure:
// string keys and scalar values (string, number, bool).
func (e *ScriptExecutor) validateExposedInfo(raw map[string]interface{}) map[string]interface{} {
	validated := make(map[string]interface{})
	for key, val := range raw {
		if key == "" {
			e.logger.Warn("exposed_info: skipping empty key")
			continue
		}
		switch v := val.(type) {
		case string, float64, int, bool:
			validated[key] = v
		default:
			e.logger.Warn("exposed_info: skipping non-scalar value", "key", key, "type", fmt.Sprintf("%T", v))
		}
	}
	return validated
}

func (e *ScriptExecutor) StreamExecute(ctx context.Context, instanceID, scriptPath string, options map[string]interface{}) (<-chan ScriptOutput, error) {
	// Validate instance ID to prevent path traversal attacks (same as Execute)
	if err := e.validateInstanceID(instanceID); err != nil {
		return nil, fmt.Errorf("invalid instance ID: %w", err)
	}

	// Validate and resolve script path (prevents symlink attacks)
	validatedPath, err := e.validateScriptPath(scriptPath)
	if err != nil {
		return nil, err
	}

	// Install path is derived from validated script path (script is at {installPath}/scripts/{name})
	installPath := filepath.Dir(filepath.Dir(validatedPath))
	appDataPath := filepath.Join(installPath, "data")
	configPath := filepath.Join(installPath, "config.json")

	scriptConfig := ScriptExecutionConfig{
		InstanceID:  instanceID,
		InstallPath: installPath,
		AppDataPath: appDataPath,
		ConfigPath:  configPath,
		Runtime: RuntimeInfo{
			ComposeFile: filepath.Join(installPath, "app-compose", "docker-compose.yml"),
			ProjectName: fmt.Sprintf("libreserv-%s", instanceID),
		},
		Options: options,
	}

	configFile, err := e.createConfigFile(configPath, scriptConfig)
	if err != nil {
		return nil, err
	}

	cmd := exec.CommandContext(ctx, validatedPath, configFile)
	cmd.Dir = installPath

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = os.Remove(configFile)
		return nil, fmt.Errorf("failed to get stdout pipe: %w", err)
	}

	stderr, err := cmd.StderrPipe()
	if err != nil {
		_ = os.Remove(configFile)
		return nil, fmt.Errorf("failed to get stderr pipe: %w", err)
	}

	outputCh := make(chan ScriptOutput, 100)

	if err := cmd.Start(); err != nil {
		_ = os.Remove(configFile)
		return nil, fmt.Errorf("failed to start script: %w", err)
	}

	go func() {
		defer os.Remove(configFile)
		defer close(outputCh)
		defer cmd.Wait()

		buf := make([]byte, 1024)
		for {
			select {
			case <-ctx.Done():
				// Context cancelled, exit goroutine
				return
			default:
			}

			n, err := stdout.Read(buf)
			if n > 0 {
				select {
				case outputCh <- ScriptOutput{
					Type:    "stdout",
					Content: string(buf[:n]),
				}:
				case <-ctx.Done():
					return
				}
			}
			if err != nil {
				if err != io.EOF {
					select {
					case outputCh <- ScriptOutput{
						Type:  "error",
						Error: fmt.Sprintf("stdout read error: %v", err),
					}:
					case <-ctx.Done():
						return
					}
				}
				break
			}
		}

		errBuf, _ := io.ReadAll(stderr)
		if len(errBuf) > 0 {
			select {
			case outputCh <- ScriptOutput{
				Type:    "stderr",
				Content: string(errBuf),
			}:
			case <-ctx.Done():
				return
			}
		}

		select {
		case outputCh <- ScriptOutput{
			Type:     "complete",
			ExitCode: cmd.ProcessState.ExitCode(),
		}:
		case <-ctx.Done():
		}
	}()

	return outputCh, nil
}

func (e *ScriptExecutor) createConfigFile(path string, config ScriptExecutionConfig) (string, error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", fmt.Errorf("failed to create config directory: %w", err)
	}

	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return "", fmt.Errorf("failed to marshal config: %w", err)
	}

	if err := os.WriteFile(path, data, 0600); err != nil {
		return "", fmt.Errorf("failed to write config file: %w", err)
	}

	return path, nil
}

func (e *ScriptExecutor) parseScriptOutput(output string) map[string]interface{} {
	var data map[string]interface{}

	jsonOutput := e.extractJSON(output)
	if jsonOutput == "" {
		return nil
	}

	if err := json.Unmarshal([]byte(jsonOutput), &data); err != nil {
		e.logger.Debug("failed to parse script JSON output", "output", jsonOutput, "error", err)
		return nil
	}

	return data
}

func (e *ScriptExecutor) extractJSON(output string) string {
	lines := strings.Split(output, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		candidate := strings.TrimSpace(lines[i])
		if candidate == "" {
			continue
		}
		if strings.HasPrefix(candidate, "{") && strings.HasSuffix(candidate, "}") {
			return candidate
		}
	}

	return ""
}

type ScriptOutput struct {
	Type     string `json:"type"`
	Content  string `json:"content,omitempty"`
	Error    string `json:"error,omitempty"`
	ExitCode int    `json:"exit_code,omitempty"`
}

func (e *ScriptExecutor) GetActionSchema(appPath, scriptName string) (*ScriptAction, error) {
	optsPath := filepath.Join(appPath, "scripts", scriptName+".opts")

	if _, err := os.Stat(optsPath); os.IsNotExist(err) {
		return nil, nil
	}

	data, err := os.ReadFile(optsPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read opts file: %w", err)
	}

	var action ScriptAction
	if err := yaml.Unmarshal(data, &action); err != nil {
		return nil, fmt.Errorf("failed to parse opts file: %w", err)
	}

	action.Script = filepath.Join("scripts", scriptName)

	return &action, nil
}

func (e *ScriptExecutor) GetSystemScriptPath(appPath, scriptType string) string {
	scriptMap := map[string]string{
		"setup":             "system-setup",
		"update":            "system-update",
		"repair":            "system-repair",
		"destructiveRepair": "system-destroy-repair",
		"backup":            "system-backup",
		"restore":           "system-restore",
	}

	scriptName, ok := scriptMap[scriptType]
	if !ok {
		return ""
	}

	scriptPath := filepath.Join(appPath, "scripts", scriptName)
	if _, err := os.Stat(scriptPath); os.IsNotExist(err) {
		return ""
	}

	return scriptPath
}
