package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"strings"

	"golang.org/x/term"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/app"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/secrets"
)

// terminalPrompter asks on the terminal, or is nil when there is none (the
// manager then reports missing secrets instead of asking).
func terminalPrompter() secrets.Prompter {
	if !term.IsTerminal(int(os.Stdin.Fd())) || !term.IsTerminal(int(os.Stderr.Fd())) {
		return nil
	}
	return &ttyPrompter{in: bufio.NewReader(os.Stdin), out: os.Stderr}
}

type ttyPrompter struct {
	in  *bufio.Reader
	out io.Writer
}

func (p *ttyPrompter) Ask(ctx context.Context, q secrets.Question) (secrets.Answer, error) {
	fmt.Fprintf(p.out, "\n%s\n", q.Label)
	if q.Hint != "" {
		fmt.Fprintf(p.out, "  %s\n", q.Hint)
	}
	fmt.Fprint(p.out, "  (leave empty to skip) > ")
	var val string
	if q.Secret {
		b, err := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Fprintln(p.out)
		if err != nil {
			return secrets.Answer{}, err
		}
		val = string(b)
	} else {
		line, err := p.in.ReadString('\n')
		if err != nil && line == "" {
			return secrets.Answer{}, err
		}
		val = strings.TrimRight(line, "\r\n")
	}
	if val == "" {
		return secrets.Answer{Skip: true}, nil
	}
	ans := secrets.Answer{Value: val}
	if q.Slot == app.KeyringPassphraseSlot {
		return ans, nil // never offered for storing
	}
	fmt.Fprint(p.out, "  Remember in the keyring? [y/N] ")
	line, _ := p.in.ReadString('\n')
	ans.Remember = strings.HasPrefix(strings.ToLower(strings.TrimSpace(line)), "y")
	return ans, nil
}

// readPassphrase asks for a passphrase on the terminal (never from a pipe).
func readPassphrase(prompt string) (string, error) {
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return "", fmt.Errorf("%s: this needs a terminal", prompt)
	}
	fmt.Fprintf(os.Stderr, "%s: ", prompt)
	b, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Fprintln(os.Stderr)
	if err != nil {
		return "", err
	}
	if len(b) == 0 {
		return "", fmt.Errorf("no passphrase given")
	}
	return string(b), nil
}

// readNewPassphrase asks twice.
func readNewPassphrase(prompt string) (string, error) {
	a, err := readPassphrase(prompt)
	if err != nil {
		return "", err
	}
	b, err := readPassphrase("Type it again to confirm")
	if err != nil {
		return "", err
	}
	if a != b {
		return "", fmt.Errorf("the two passphrases differ")
	}
	return a, nil
}
