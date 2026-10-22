package apps

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRunSystemSetupReportsMissingAndFailingRequiredScripts(t *testing.T) {
	base := t.TempDir()
	installer := &Installer{appsDataDir: filepath.Join(base, "installed"), logger: slog.Default()}
	if err := os.MkdirAll(filepath.Join(installer.appsDataDir, "instance"), 0o755); err != nil {
		t.Fatal(err)
	}
	appDef := &AppDefinition{ID: "fixture", CatalogPath: filepath.Join(base, "catalog"), Scripts: ScriptConfig{System: SystemScripts{Setup: "scripts/system-setup"}}}
	if err := installer.RunSystemSetup(context.Background(), appDef, "instance", nil, nil); err == nil {
		t.Fatal("missing required system-setup script should fail")
	}
	setupPath := filepath.Join(appDef.CatalogPath, "scripts", "system-setup")
	if err := os.MkdirAll(filepath.Dir(setupPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(setupPath, []byte("#!/bin/sh\nexit 7\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := installer.RunSystemSetup(context.Background(), appDef, "instance", nil, nil); err == nil {
		t.Fatal("non-zero setup exit should fail the install")
	}
}

func TestDeploymentPortAvailabilityAllowsSameInstallReservation(t *testing.T) {
	pm := &PortManager{usedPorts: make(map[int]string), serverPort: 19501, logger: slog.Default()}
	port := 0
	for candidate := 19510; candidate <= 19519; candidate++ {
		if pm.IsPortFreeAtOS(candidate) {
			port = candidate
			break
		}
	}
	if port == 0 {
		t.Fatal("no free fixture port in 19510–19519")
	}
	pm.Reserve(port, "install-1")
	if !pm.IsAvailableForOwner(port, "install-1") {
		t.Fatal("same install should be able to reuse its reserved deployment port")
	}
	if pm.IsAvailableForOwner(port, "install-2") {
		t.Fatal("a different install must not reuse another install's port")
	}
}

func TestStreamExecutionCancellationStopsScriptProcessGroup(t *testing.T) {
	base := t.TempDir()
	installPath := filepath.Join(base, "instance")
	scriptPath := filepath.Join(installPath, "scripts", "wait")
	if err := os.MkdirAll(filepath.Dir(scriptPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(scriptPath, []byte("#!/bin/sh\necho started\nsleep 30 &\nwait\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	executor := NewScriptExecutorWithCatalog(slog.Default(), nil, base, "")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	outputs, err := executor.StreamExecuteAt(ctx, "instance", scriptPath, installPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan []ScriptOutput, 1)
	go func() {
		var got []ScriptOutput
		for output := range outputs {
			got = append(got, output)
			if strings.Contains(output.Content, "started") {
				cancel()
			}
		}
		done <- got
	}()
	select {
	case got := <-done:
		foundCancellation := false
		for _, output := range got {
			if output.Type == "error" && strings.Contains(output.Error, "stopped") {
				foundCancellation = true
			}
		}
		if !foundCancellation {
			t.Fatalf("stream did not report cancellation: %+v", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cancelled script process group did not stop promptly")
	}
}

func TestStreamExecutionTimeoutStopsDescendantHoldingOutputPipe(t *testing.T) {
	base := t.TempDir()
	installPath := filepath.Join(base, "instance")
	scriptPath := filepath.Join(installPath, "scripts", "leave-child-running")
	if err := os.MkdirAll(filepath.Dir(scriptPath), 0o755); err != nil {
		t.Fatal(err)
	}
	// The background child inherits the script's output pipes. The script exits
	// immediately, so the stream can finish only after the context timeout kills
	// the process group and closes those inherited pipes.
	if err := os.WriteFile(scriptPath, []byte("#!/bin/sh\nsleep 30 &\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	executor := NewScriptExecutorWithCatalog(slog.Default(), nil, base, "")
	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()
	outputs, err := executor.StreamExecuteAt(ctx, "instance", scriptPath, installPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan []ScriptOutput, 1)
	go func() {
		var got []ScriptOutput
		for output := range outputs {
			got = append(got, output)
		}
		done <- got
	}()
	select {
	case got := <-done:
		foundTimeout := false
		for _, output := range got {
			if output.Type == "error" && strings.Contains(output.Error, "too long") {
				foundTimeout = true
			}
		}
		if !foundTimeout {
			t.Fatalf("stream did not report timeout: %+v", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out script left a descendant holding the output pipe")
	}
}

func TestInstallFailsWhenRequiredOIDCProvisioningFails(t *testing.T) {
	for _, provisionerErr := range []error{nil, errors.New("fixture OIDC provider unavailable")} {
		t.Run(map[bool]string{true: "configured provisioner fails", false: "provisioner missing"}[provisionerErr != nil], func(t *testing.T) {
			root := t.TempDir()
			appDir := filepath.Join(root, "catalog", "apps", "internal-fixture")
			if err := os.MkdirAll(appDir, 0o755); err != nil {
				t.Fatal(err)
			}
			appYAML := []byte("id: internal-fixture\nname: Internal fixture\ndescription: Tests required internal app access setup.\nversion: 1.0.0\naccess_model: internal\ndeployment:\n  image: example/unused:latest\n")
			if err := os.WriteFile(filepath.Join(appDir, "app.yaml"), appYAML, 0o644); err != nil {
				t.Fatal(err)
			}
			catalog, err := NewCatalog(filepath.Join(root, "catalog"))
			if err != nil {
				t.Fatal(err)
			}
			dataDir := filepath.Join(root, "apps")
			installer := NewInstaller(catalog, nil, nil, dataDir, nil, nil, nil)
			if provisionerErr != nil {
				installer.SetOIDCProvisioner(func(string, string, string) (string, string, string, error) { return "", "", "", provisionerErr })
			}
			result, err := installer.Install(context.Background(), InstallOptions{AppID: "internal-fixture"})
			if err == nil || result.Success {
				t.Fatalf("install should fail without internal-access credentials: result=%+v err=%v", result, err)
			}
			entries, err := os.ReadDir(dataDir)
			if err != nil {
				t.Fatal(err)
			}
			if len(entries) != 0 {
				t.Fatalf("failed OIDC setup left install data behind: %v", entries)
			}
		})
	}
}
