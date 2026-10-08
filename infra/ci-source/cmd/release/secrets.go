package main

import (
	"bufio"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"golang.org/x/term"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/app"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/secrets"
)

const secretsUsage = `Usage: release secrets [subcommand]

  list [--json]                 Find and prove every secret (the default)
  prove [id] [--full]           Prove again from scratch (asks for missing passwords on a terminal)
  add-path <file|folder>        Search this file or folder for keys and keystores
  remove-path <file|folder>     Stop searching it
  paths                         Show the added paths
  set <slot>                    Remember a pasted value in the keyring (read from the terminal or stdin, never from arguments)
  forget <slot>                 Remove a remembered value
  slots                         Show what can be remembered
  choose <id> <ref>|--clear     Settle a conflict between two valid candidates
  store [system|vault]          Show, or switch, where remembered values live (the values move too)
  store passphrase              Change the vault passphrase

ids: sol-signing (sol), lsluna-signing (luna), forgejo-token (forgejo), android-keystore (android)
Secret values are never printed.
`

type statusJSON struct {
	ID         string          `json:"id"`
	Label      string          `json:"label"`
	State      string          `json:"state"`
	Summary    string          `json:"summary"`
	Candidates []candidateJSON `json:"candidates"`
}

type candidateJSON struct {
	Where   string `json:"where"`
	Ref     string `json:"ref"`
	Detail  string `json:"detail,omitempty"`
	Outcome string `json:"outcome"`
	Reason  string `json:"reason,omitempty"`
}

func toStatusJSON(sts []secrets.Status) []statusJSON {
	out := []statusJSON{}
	for _, s := range sts {
		j := statusJSON{ID: string(s.ID), Label: s.Label, State: string(s.State), Summary: s.Summary, Candidates: []candidateJSON{}}
		for _, c := range s.Candidates {
			j.Candidates = append(j.Candidates, candidateJSON{c.Where, c.Ref, c.Detail, string(c.Outcome), c.Reason})
		}
		out = append(out, j)
	}
	return out
}

var idAliases = map[string]secrets.ID{
	"sol": secrets.SolSigning, "sol-signing": secrets.SolSigning,
	"luna": secrets.LunaSigning, "lsluna": secrets.LunaSigning, "lsluna-signing": secrets.LunaSigning,
	"forgejo": secrets.ForgejoToken, "forgejo-token": secrets.ForgejoToken, "token": secrets.ForgejoToken,
	"android": secrets.AndroidKeystore, "android-keystore": secrets.AndroidKeystore, "keystore": secrets.AndroidKeystore,
}

func parseID(s string) (secrets.ID, error) {
	if id, ok := idAliases[strings.ToLower(s)]; ok {
		return id, nil
	}
	return "", fmt.Errorf("unknown secret %q (try: sol-signing, lsluna-signing, forgejo-token, android-keystore)", s)
}

func cmdSecrets(args []string) int {
	sub := "list"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		sub, args = args[0], args[1:]
	}
	if sub == "help" {
		fmt.Print(secretsUsage)
		return 0
	}
	fs := flag.NewFlagSet("secrets "+sub, flag.ContinueOnError)
	asJSON := fs.Bool("json", false, "print as JSON")
	full := fs.Bool("full", false, "prove: forget the pairing cache and rescan the home folder")
	fs.BoolVar(&verboseCandidates, "v", false, "list every rejected file the home scan looked at")
	clear := fs.Bool("clear", false, "choose: remove the choice")
	fs.Usage = func() { fmt.Fprint(os.Stderr, secretsUsage); fs.PrintDefaults() }
	pos, err := parseInterspersed(fs, args)
	if err != nil {
		if err == flag.ErrHelp {
			return 0
		}
		return 2
	}
	a, err := newApp(appOpts{keyring: true, prompt: sub == "prove" || sub == "set" || sub == "list" || sub == "choose"})
	if err != nil {
		return fail("secrets", err)
	}
	ctx, stop := signalContext()
	defer stop()
	m := a.Secrets()

	switch sub {
	case "list":
		return printStatuses(a.Redact, m.List(ctx), *asJSON)
	case "prove":
		var ids []secrets.ID
		if len(pos) > 0 {
			id, err := parseID(pos[0])
			if err != nil {
				return usageErr("secrets", err.Error())
			}
			ids = []secrets.ID{id}
		} else {
			ids = secrets.AllIDs()
		}
		var sts []secrets.Status
		for _, id := range ids {
			sts = append(sts, m.Reprove(ctx, id, *full))
		}
		return printStatuses(a.Redact, sts, *asJSON)
	case "add-path", "remove-path":
		if len(pos) != 1 {
			return usageErr("secrets", sub+" needs one path")
		}
		if sub == "add-path" {
			err = m.AddPath(pos[0])
		} else {
			err = m.RemovePath(pos[0])
		}
		if err != nil {
			return fail("secrets", err)
		}
		fmt.Println("ok")
		return 0
	case "paths":
		ps := m.Paths()
		if *asJSON {
			printJSON(map[string]any{"paths": append([]string{}, ps...)})
			return 0
		}
		if len(ps) == 0 {
			fmt.Println("no added paths (the default places are always searched)")
		}
		for _, p := range ps {
			fmt.Println(p)
		}
		return 0
	case "slots":
		type slot struct {
			Slot  string `json:"slot"`
			Label string `json:"label"`
			Set   bool   `json:"set"`
		}
		out := []slot{}
		for _, s := range m.Slots() {
			out = append(out, slot{s.Slot, s.Label, s.Set})
		}
		if *asJSON {
			printJSON(map[string]any{"slots": out})
			return 0
		}
		for _, s := range out {
			state := "not set"
			if s.Set {
				state = "set"
			}
			fmt.Printf("%-32s %-8s %s\n", s.Slot, state, s.Label)
		}
		return 0
	case "set":
		if len(pos) != 1 {
			return usageErr("secrets", "set needs a slot name (see `release secrets slots`)")
		}
		val, err := readSecretValue(pos[0])
		if err != nil {
			return fail("secrets", err)
		}
		a.Engine().Redactor.Add(val)
		if err := m.SetValue(pos[0], val); err != nil {
			return fail("secrets", fmt.Errorf("%s", a.Redact(err.Error())))
		}
		fmt.Printf("remembered %s\n", pos[0])
		return 0
	case "store":
		return cmdSecretsStore(a, pos, *asJSON)
	case "forget":
		if len(pos) != 1 {
			return usageErr("secrets", "forget needs a slot name")
		}
		if err := m.Forget(pos[0]); err != nil {
			return fail("secrets", err)
		}
		fmt.Println("ok")
		return 0
	case "choose":
		if len(pos) < 1 || (len(pos) < 2 && !*clear) {
			return usageErr("secrets", "choose needs an id and a candidate ref (or --clear)")
		}
		id, err := parseID(pos[0])
		if err != nil {
			return usageErr("secrets", err.Error())
		}
		ref := ""
		if len(pos) > 1 && !*clear {
			ref = pos[1]
		}
		if err := m.Choose(id, ref); err != nil {
			return fail("secrets", err)
		}
		return printStatuses(a.Redact, []secrets.Status{m.Status(ctx, id)}, *asJSON)
	}
	fmt.Fprintf(os.Stderr, "release secrets: unknown subcommand %q\n\n%s", sub, secretsUsage)
	return 2
}

// readSecretValue reads a value without echo from a terminal, or all of stdin.
func readSecretValue(slot string) (string, error) {
	if term.IsTerminal(int(os.Stdin.Fd())) {
		fmt.Fprintf(os.Stderr, "Value for %s (not shown): ", slot)
		b, err := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Fprintln(os.Stderr)
		if err != nil {
			return "", err
		}
		return strings.TrimRight(string(b), "\r\n"), nil
	}
	b, err := io.ReadAll(bufio.NewReader(os.Stdin))
	if err != nil {
		return "", err
	}
	return strings.TrimRight(string(b), "\r\n"), nil
}

func printStatuses(redact func(string) string, sts []secrets.Status, asJSON bool) int {
	code := 0
	for _, s := range sts {
		if s.State != secrets.Proven {
			code = 1
		}
	}
	if asJSON {
		printJSON(map[string]any{"ok": code == 0, "secrets": toStatusJSON(sts)})
		return code
	}
	for _, s := range sts {
		mark := map[secrets.State]string{secrets.Proven: "ok  ", secrets.Failed: "FAIL", secrets.Missing: "MISS", secrets.Conflict: "CONF"}[s.State]
		fmt.Printf("%s  %-32s %s\n", mark, s.Label, redact(s.Summary))
		printCandidates(os.Stdout, s)
	}
	return code
}

// verboseCandidates shows the rejected files of the home scan too.
var verboseCandidates bool

func printCandidates(w io.Writer, s secrets.Status) {
	hidden := 0
	for _, c := range s.Candidates {
		if c.Outcome == secrets.Rejected && strings.HasPrefix(c.Where, "home scan") && !verboseCandidates {
			hidden++
			continue
		}
		line := fmt.Sprintf("      %-9s %s", c.Outcome, c.Where)
		if c.Detail != "" {
			line += " (" + c.Detail + ")"
		}
		if c.Reason != "" {
			line += ": " + c.Reason
		}
		if s.State == secrets.Conflict {
			line += "  ref " + c.Ref
		}
		fmt.Fprintln(w, line)
	}
	if hidden > 0 {
		fmt.Fprintf(w, "      (%d other files found by the home scan were not keys; -v lists them)\n", hidden)
	}
}

// cmdSecretsStore shows or changes where remembered values live.
func cmdSecretsStore(a *app.App, pos []string, asJSON bool) int {
	sm := a.Store()
	if sm == nil {
		return fail("secrets", fmt.Errorf("the keyring is not available in this mode"))
	}
	if len(pos) == 0 {
		sysOK, sysErr := sm.SystemAvailable()
		mode := sm.Mode()
		state := "unlocked"
		if sm.NeedsUnlock() {
			state = "locked"
		}
		if mode == secrets.ModeSystem && !sm.Unlocked() {
			state = "not reachable"
		}
		if asJSON {
			j := map[string]any{"store": string(mode), "chosen": sm.Saved() != "", "state": state,
				"system_available": sysOK, "vault_exists": sm.VaultExists(), "vault_dir": sm.VaultDir()}
			printJSON(j)
			return 0
		}
		fmt.Printf("Store: %s (%s), %s", mode, storeWhere(sm, mode), state)
		if sm.Saved() == "" {
			fmt.Print("  [default; nothing chosen yet]")
		}
		fmt.Println()
		if sysOK {
			fmt.Println("System keyring: available")
		} else {
			fmt.Printf("System keyring: not available (%s)\n", a.Redact(fmt.Sprint(sysErr)))
		}
		fmt.Printf("Vault: %s\n", map[bool]string{true: "exists at " + sm.VaultDir(), false: "not created yet"}[sm.VaultExists()])
		return 0
	}
	switch pos[0] {
	case "passphrase":
		if sm.Mode() != secrets.ModeVault {
			return fail("secrets", fmt.Errorf("the vault is not the active store; run `release secrets store vault` first"))
		}
		old, err := readPassphrase("Current vault passphrase")
		if err != nil {
			return fail("secrets", err)
		}
		if err := sm.Unlock(old); err != nil {
			return fail("secrets", err)
		}
		a.Engine().Redactor.Add(old)
		pw, err := readNewPassphrase("New vault passphrase")
		if err != nil {
			return fail("secrets", err)
		}
		if err := sm.ChangePassphrase(old, pw); err != nil {
			return fail("secrets", err)
		}
		fmt.Println("Vault passphrase changed.")
		return 0
	case "system", "vault":
		to := secrets.StoreMode(pos[0])
		pass := ""
		if (to == secrets.ModeVault || sm.Mode() == secrets.ModeVault) && !sm.Unlocked() {
			var err error
			if sm.VaultExists() {
				pass, err = readPassphrase("Vault passphrase")
			} else {
				pass, err = readNewPassphrase("Choose a vault passphrase")
			}
			if err != nil {
				return fail("secrets", err)
			}
		}
		n, err := sm.SwitchTo(to, pass)
		if err != nil {
			return fail("secrets", err)
		}
		fmt.Printf("Remembered values now live in the %s (%s). Moved %d value(s).\n", to, storeWhere(sm, to), n)
		return 0
	}
	return usageErr("secrets", "store takes system, vault or passphrase")
}

func storeWhere(sm *secrets.StoreManager, mode secrets.StoreMode) string {
	if mode == secrets.ModeVault {
		return "passphrase-protected file, " + sm.VaultDir()
	}
	return "desktop keyring: " + sm.Backend()
}
