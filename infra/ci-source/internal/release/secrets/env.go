package secrets

import (
	"context"
	"encoding/base64"
	"os"
	"strings"
	"time"
)

// found is one value discovered from some place.
type found struct {
	Where string
	Value string
}

// env reads NAME, NAME_B64 (base64-decoded), NAME_FILE (file contents) and
// NAME_CMD (command output; 10 s timeout, one retry) for each name.
func (m *Manager) env(ctx context.Context, names ...string) []found {
	var out []found
	for _, n := range names {
		if c, ok := m.envMemo[n]; ok {
			out = append(out, c...)
			continue
		}
		c := m.envForms(ctx, n)
		m.envMemo[n] = c
		out = append(out, c...)
	}
	return out
}

func (m *Manager) envForms(ctx context.Context, name string) []found {
	var out []found
	add := func(where, v string) {
		v = strings.TrimRight(v, "\r\n")
		if v != "" {
			out = append(out, found{Where: where, Value: v})
		}
	}
	g := m.opt.Getenv
	if v := g(name); v != "" {
		m.redact(v)
		add("env "+name, v)
	}
	if v := g(name + "_B64"); v != "" {
		m.redact(v)
		if b, err := decodeB64(v); err == nil {
			add("env "+name+"_B64", string(b))
		}
	}
	if p := g(name + "_FILE"); p != "" {
		if b, err := os.ReadFile(m.expand(p)); err == nil {
			m.redact(strings.TrimRight(string(b), "\r\n"))
			add("env "+name+"_FILE", string(b))
		}
	}
	if c := g(name + "_CMD"); c != "" {
		var b []byte
		var err error
		for try := 0; try < 2; try++ {
			cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			b, err = m.opt.Run(cctx, "", nil, "sh", "-c", c)
			cancel()
			if err == nil {
				break
			}
		}
		if err == nil {
			m.redact(strings.TrimRight(string(b), "\r\n"))
			add("env "+name+"_CMD", string(b))
		}
	}
	return out
}

func decodeB64(s string) ([]byte, error) {
	s = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == ' ' || r == '\t' {
			return -1
		}
		return r
	}, s)
	if b, err := base64.StdEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	if b, err := base64.RawStdEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	if b, err := base64.URLEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	return base64.RawURLEncoding.DecodeString(s)
}
