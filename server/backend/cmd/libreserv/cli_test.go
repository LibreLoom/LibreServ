package main

import (
	"strings"
	"testing"
)

func TestParseCLIArgsServeConfigForms(t *testing.T) {
	cases := []struct {
		name    string
		args    []string
		wantCfg string
		wantCmd string
	}{
		{
			name:    "serve then --config (Makefile form)",
			args:    []string{"serve", "--config", "./configs/custom.yaml"},
			wantCfg: "./configs/custom.yaml",
			wantCmd: "serve",
		},
		{
			name:    "--config then serve",
			args:    []string{"--config", "./configs/custom.yaml", "serve"},
			wantCfg: "./configs/custom.yaml",
			wantCmd: "serve",
		},
		{
			name:    "--config=equals then serve",
			args:    []string{"--config=./configs/equals.yaml", "serve"},
			wantCfg: "./configs/equals.yaml",
			wantCmd: "serve",
		},
		{
			name:    "bare binary uses default config",
			args:    nil,
			wantCfg: defaultConfigPath,
			wantCmd: "",
		},
		{
			name:    "config get with trailing --config",
			args:    []string{"config", "get", "logging.level", "--config", "/etc/libreserv.yaml"},
			wantCfg: "/etc/libreserv.yaml",
			wantCmd: "config",
		},
		{
			name:    "config defaults with leading --config",
			args:    []string{"--config", "/tmp/ls.yaml", "config", "defaults"},
			wantCfg: "/tmp/ls.yaml",
			wantCmd: "config",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseCLIArgs(tc.args)
			if err != nil {
				t.Fatalf("parseCLIArgs(%v) error: %v", tc.args, err)
			}
			if got.Help {
				t.Fatalf("unexpected Help=true")
			}
			if got.ConfigPath != tc.wantCfg {
				t.Fatalf("ConfigPath = %q, want %q", got.ConfigPath, tc.wantCfg)
			}
			if got.Command != tc.wantCmd {
				t.Fatalf("Command = %q, want %q", got.Command, tc.wantCmd)
			}
			if tc.wantCmd == "config" {
				if len(got.CommandArgs) == 0 {
					t.Fatalf("expected config sub-args, got none")
				}
				if strings.HasPrefix(got.CommandArgs[0], "-") {
					t.Fatalf("config sub-args still contain flags: %v", got.CommandArgs)
				}
			}
		})
	}
}

func TestParseCLIArgsErrorsAndHelp(t *testing.T) {
	if _, err := parseCLIArgs([]string{"serve", "--config"}); err == nil || !strings.Contains(err.Error(), "--config requires") {
		t.Fatalf("missing --config value error = %v", err)
	}
	if _, err := parseCLIArgs([]string{"serve", "extra"}); err == nil || !strings.Contains(err.Error(), "serve takes no arguments") {
		t.Fatalf("serve extra args error = %v", err)
	}
	if _, err := parseCLIArgs([]string{"explode"}); err == nil || !strings.Contains(err.Error(), "unknown command") {
		t.Fatalf("unknown command error = %v", err)
	}
	if _, err := parseCLIArgs([]string{"--bogus"}); err == nil || !strings.Contains(err.Error(), "unknown flag") {
		t.Fatalf("unknown flag error = %v", err)
	}
	got, err := parseCLIArgs([]string{"--help", "serve"})
	if err != nil {
		t.Fatalf("--help parse error: %v", err)
	}
	if !got.Help {
		t.Fatalf("expected Help=true")
	}
}

func TestParseCLIArgsStripsConfigFromConfigSubcommand(t *testing.T) {
	got, err := parseCLIArgs([]string{"config", "get", "logging.level", "--config", "/etc/libreserv.yaml"})
	if err != nil {
		t.Fatal(err)
	}
	if got.ConfigPath != "/etc/libreserv.yaml" {
		t.Fatalf("ConfigPath = %q", got.ConfigPath)
	}
	if got.Command != "config" {
		t.Fatalf("Command = %q", got.Command)
	}
	wantArgs := []string{"get", "logging.level"}
	if len(got.CommandArgs) != len(wantArgs) {
		t.Fatalf("CommandArgs = %v, want %v", got.CommandArgs, wantArgs)
	}
	for i := range wantArgs {
		if got.CommandArgs[i] != wantArgs[i] {
			t.Fatalf("CommandArgs = %v, want %v", got.CommandArgs, wantArgs)
		}
	}
}
