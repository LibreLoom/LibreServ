package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"strings"

	"golang.org/x/term"

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
	fmt.Fprint(p.out, "  Remember in the keyring? [y/N] ")
	line, _ := p.in.ReadString('\n')
	ans.Remember = strings.HasPrefix(strings.ToLower(strings.TrimSpace(line)), "y")
	return ans, nil
}
