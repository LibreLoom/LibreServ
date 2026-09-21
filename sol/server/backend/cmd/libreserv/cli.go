package main

import (
	"fmt"
	"os"
	"strings"
)

const defaultConfigPath = "./configs/libreserv.yaml"

// cliArgs is the result of parsing libreserv command-line arguments.
//
// The standard library flag package stops at the first non-flag argument, so
// documented forms like `libreserv serve --config PATH` and
// `libreserv config get KEY --config PATH` silently ignored --config. This
// parser accepts --config anywhere among the args.
type cliArgs struct {
	ConfigPath  string
	Command     string   // "", "serve", or "config"
	CommandArgs []string // args after the command word
	Help        bool
}

func parseCLIArgs(args []string) (cliArgs, error) {
	out := cliArgs{ConfigPath: defaultConfigPath}
	var positionals []string

	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--":
			positionals = append(positionals, args[i+1:]...)
			i = len(args)
		case a == "-h" || a == "--help":
			out.Help = true
		case a == "--config" || a == "-config":
			if i+1 >= len(args) {
				return out, fmt.Errorf("--config requires a path argument")
			}
			out.ConfigPath = args[i+1]
			i++
		case strings.HasPrefix(a, "--config="):
			val := strings.TrimPrefix(a, "--config=")
			if val == "" {
				return out, fmt.Errorf("--config requires a path argument")
			}
			out.ConfigPath = val
		case strings.HasPrefix(a, "-config="):
			val := strings.TrimPrefix(a, "-config=")
			if val == "" {
				return out, fmt.Errorf("--config requires a path argument")
			}
			out.ConfigPath = val
		case strings.HasPrefix(a, "-"):
			return out, fmt.Errorf("unknown flag: %s", a)
		default:
			positionals = append(positionals, a)
		}
	}

	if len(positionals) > 0 {
		out.Command = positionals[0]
		out.CommandArgs = positionals[1:]
	}

	switch out.Command {
	case "", "serve":
		if out.Command == "serve" && len(out.CommandArgs) > 0 {
			return out, fmt.Errorf("serve takes no arguments")
		}
	case "config":
		// handled by handleConfigCommand
	default:
		return out, fmt.Errorf("unknown command %q (want serve or config)", out.Command)
	}

	return out, nil
}

func printCLIUsage() {
	fmt.Fprintf(os.Stderr, `Usage:
  libreserv [--config PATH] [serve]
  libreserv config defaults|get|set ... [--config PATH]

Options:
  --config PATH   Path to configuration file (default %s)
  -h, --help      Show this help

`, defaultConfigPath)
}
