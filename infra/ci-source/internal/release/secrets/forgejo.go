package secrets

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ForgejoCreds is a proven token.
type ForgejoCreds struct {
	BaseURL string
	Token   string
	User    string
}

type tokenCand struct {
	Where string
	Value string
}

func (m *Manager) forgejoHost() string {
	u, err := url.Parse(m.opt.ForgejoURL)
	if err != nil {
		return ""
	}
	return u.Hostname()
}

// forgejoCandidates gathers every token from every source, deduplicated by
// value (the first place found is shown, the rest are appended to its label).
func (m *Manager) forgejoCandidates(ctx context.Context) ([]tokenCand, []Candidate) {
	var raw []tokenCand
	var notes []Candidate
	add := func(where, v string) {
		v = strings.TrimSpace(v)
		if v != "" {
			m.redact(v)
			raw = append(raw, tokenCand{where, v})
		}
	}
	host := m.forgejoHost()

	// fj CLI login.
	for _, p := range m.fjKeyFiles() {
		toks, skipped := readFJKeys(p, host)
		for _, t := range toks {
			add("fj CLI login ("+m.tilde(p)+")", t)
		}
		for _, s := range skipped {
			notes = append(notes, Candidate{Where: "fj CLI login (" + m.tilde(p) + ")", Outcome: Rejected, Reason: s})
		}
	}
	// git credential helper.
	if tok := m.gitCredential(ctx, host); tok != "" {
		add("git credential helper for "+host, tok)
	}
	// tea.
	for _, p := range []string{filepath.Join(m.opt.Home, ".config", "tea", "config.yml"), xdgConfig(m, "tea", "config.yml")} {
		for _, t := range readTeaConfig(p, host) {
			add("tea config ("+m.tilde(p)+")", t)
		}
	}
	// .netrc
	for _, t := range readNetrc(filepath.Join(m.opt.Home, ".netrc"), host) {
		add("~/.netrc", t)
	}
	// env, keyring, other sources.
	for _, f := range m.env(ctx, "FORGEJO_TOKEN") {
		add(f.Where, f.Value)
	}
	for _, f := range m.stored(ctx, SlotForgejoToken) {
		add(f.Where, f.Value)
	}

	var out []tokenCand
	idx := map[string]int{}
	for _, c := range raw {
		if i, ok := idx[c.Value]; ok {
			out[i].Where += ", " + c.Where
			continue
		}
		idx[c.Value] = len(out)
		out = append(out, c)
	}
	return out, notes
}

func xdgConfig(m *Manager, parts ...string) string {
	base := m.opt.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		base = filepath.Join(m.opt.Home, ".config")
	}
	return filepath.Join(append([]string{base}, parts...)...)
}

func (m *Manager) fjKeyFiles() []string {
	data := m.opt.Getenv("XDG_DATA_HOME")
	if data == "" {
		data = filepath.Join(m.opt.Home, ".local", "share")
	}
	return []string{filepath.Join(data, "forgejo-cli", "keys.json")}
}

// readFJKeys reads fj's keys.json: {"hosts": {"<host>": {"type": "Application",
// "token": "..."}}, "aliases": {...}}. Only Application logins are tokens we
// can use; other types are reported.
func readFJKeys(path, host string) (tokens []string, skipped []string) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, nil
	}
	var doc struct {
		Hosts   map[string]json.RawMessage `json:"hosts"`
		Aliases map[string]string          `json:"aliases"`
	}
	if json.Unmarshal(b, &doc) != nil {
		return nil, []string{"keys.json could not be read"}
	}
	names := []string{host}
	for alias, target := range doc.Aliases {
		if strings.Split(alias, ":")[0] == host {
			names = append(names, target)
		}
	}
	for _, n := range names {
		raw, ok := doc.Hosts[n]
		if !ok {
			continue
		}
		var e struct {
			Type  string `json:"type"`
			Token string `json:"token"`
		}
		if json.Unmarshal(raw, &e) != nil {
			continue
		}
		if e.Type != "Application" {
			skipped = append(skipped, fmt.Sprintf("login type %q is not an API token", e.Type))
			continue
		}
		if e.Token != "" {
			tokens = append(tokens, e.Token)
		}
	}
	return
}

func (m *Manager) gitCredential(ctx context.Context, host string) string {
	if host == "" {
		return ""
	}
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	out, err := m.opt.Run(cctx, "protocol=https\nhost="+host+"\n\n",
		[]string{"GIT_TERMINAL_PROMPT=0", "GCM_INTERACTIVE=never", "GIT_ASKPASS=true", "SSH_ASKPASS=true"},
		"git", "credential", "fill")
	if err != nil {
		return ""
	}
	sc := bufio.NewScanner(strings.NewReader(string(out)))
	for sc.Scan() {
		if v, ok := strings.CutPrefix(sc.Text(), "password="); ok {
			return v
		}
	}
	return ""
}

// readTeaConfig reads logins from tea's config.yml (simple "- name:/url:/token:"
// blocks; no YAML dependency).
func readTeaConfig(path, host string) []string {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var out []string
	var url_, tok string
	flush := func() {
		if tok != "" && urlHost(url_) == host {
			out = append(out, tok)
		}
		url_, tok = "", ""
	}
	for _, line := range strings.Split(string(b), "\n") {
		t := strings.TrimSpace(line)
		t = strings.TrimPrefix(t, "- ")
		switch {
		case strings.HasPrefix(t, "name:"):
			flush()
		case strings.HasPrefix(t, "url:"):
			url_ = unquote(strings.TrimSpace(strings.TrimPrefix(t, "url:")))
		case strings.HasPrefix(t, "token:"):
			tok = unquote(strings.TrimSpace(strings.TrimPrefix(t, "token:")))
		}
	}
	flush()
	return out
}

func urlHost(s string) string {
	u, err := url.Parse(s)
	if err != nil {
		return ""
	}
	return u.Hostname()
}

func unquote(s string) string { return strings.Trim(s, `"'`) }

// readNetrc returns passwords for machine <host> (or default).
func readNetrc(path, host string) []string {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	f := strings.Fields(string(b))
	var out []string
	match := false
	for i := 0; i < len(f); i++ {
		switch f[i] {
		case "machine":
			if i+1 < len(f) {
				match = f[i+1] == host
				i++
			}
		case "default":
			match = true
		case "password":
			if match && i+1 < len(f) {
				out = append(out, f[i+1])
			}
			i++
		case "login", "account":
			i++
		}
	}
	return out
}

func (m *Manager) resolveForgejo(ctx context.Context) *resolved {
	s := Status{ID: ForgejoToken, Label: "Forgejo token"}
	cands, notes := m.forgejoCandidates(ctx)
	s.Candidates = append(s.Candidates, notes...)

	type proof struct {
		c    Candidate
		user string
		tok  string
		ok   bool
	}
	var proofs []proof
	prove := func(tc tokenCand) {
		user, err := m.proveForgejo(ctx, tc.Value)
		c := Candidate{Where: tc.Where, Ref: refOf(tc.Value)}
		if err != nil {
			c.Outcome, c.Reason = Rejected, err.reason
			if err.unreachable {
				c.Outcome = Unusable
			}
		} else {
			c.Detail = "user " + user
		}
		proofs = append(proofs, proof{c, user, tc.Value, err == nil})
	}
	for _, tc := range cands {
		prove(tc)
	}
	anyOK := func() bool {
		for _, p := range proofs {
			if p.ok {
				return true
			}
		}
		return false
	}
	if !anyOK() {
		if v := m.ask(ctx, Question{
			Slot: SlotForgejoToken, Label: "Forgejo token", Secret: true,
			Hint: "Create one on " + m.opt.ForgejoURL + " under Settings → Applications, with write access to repositories and packages.",
		}); v != "" {
			prove(tokenCand{"typed token", v})
		}
	}

	var okIdx []int
	for i, p := range proofs {
		if p.ok {
			okIdx = append(okIdx, i)
		}
	}
	chosen := -1
	switch {
	case len(okIdx) == 1:
		chosen = okIdx[0]
	case len(okIdx) > 1:
		pick := m.loadConfig().Choices[ForgejoToken]
		for _, i := range okIdx {
			if proofs[i].c.Ref == pick {
				chosen = i
			}
		}
	}
	for i := range proofs {
		c := proofs[i].c
		if proofs[i].ok {
			c.Outcome = Valid
			if i == chosen {
				c.Outcome = Used
			} else if chosen < 0 {
				c.Reason = "also valid; pick one with Choose"
			} else {
				c.Reason = "also valid, but another token was chosen"
			}
		}
		s.Candidates = append(s.Candidates, c)
	}
	switch {
	case chosen >= 0:
		s.State = Proven
		s.Summary = "Token for user " + proofs[chosen].user + " can push to " + m.opt.Repo + "."
		return &resolved{status: s, value: &ForgejoCreds{BaseURL: m.opt.ForgejoURL, Token: proofs[chosen].tok, User: proofs[chosen].user}}
	case len(okIdx) > 1:
		s.State = Conflict
		s.Summary = fmt.Sprintf("%d different tokens all work. Choose which one releases use.", len(okIdx))
	case len(proofs) > 0:
		s.State = Failed
		s.Summary = "Found tokens, but " + m.forgejoHost() + " did not accept any of them for " + m.opt.Repo + "."
	default:
		s.State = Missing
		s.Summary = "No Forgejo token found. Paste one, or sign in with the fj command."
	}
	return &resolved{status: s}
}

type forgejoErr struct {
	reason      string
	unreachable bool
}

func (e *forgejoErr) Error() string { return e.reason }

// proveForgejo checks the token authenticates and can push to the repo.
func (m *Manager) proveForgejo(ctx context.Context, token string) (string, *forgejoErr) {
	body, code, err := m.forgejoGet(ctx, token, "/api/v1/user")
	if err != nil {
		return "", &forgejoErr{reason: "could not reach " + m.opt.ForgejoURL + ": " + err.Error(), unreachable: true}
	}
	if code == http.StatusUnauthorized {
		return "", &forgejoErr{reason: "the forge rejected this token (401)"}
	}
	if code != http.StatusOK {
		return "", &forgejoErr{reason: fmt.Sprintf("the forge answered %d when asked who this token is", code)}
	}
	var u struct {
		Login string `json:"login"`
	}
	_ = json.Unmarshal(body, &u)

	body, code, err = m.forgejoGet(ctx, token, "/api/v1/repos/"+m.opt.Repo)
	if err != nil {
		return "", &forgejoErr{reason: "could not reach " + m.opt.ForgejoURL + ": " + err.Error(), unreachable: true}
	}
	switch {
	case code == http.StatusNotFound || code == http.StatusForbidden:
		return "", &forgejoErr{reason: fmt.Sprintf("user %s cannot see %s (token scope or access too narrow)", u.Login, m.opt.Repo)}
	case code != http.StatusOK:
		return "", &forgejoErr{reason: fmt.Sprintf("the forge answered %d for %s", code, m.opt.Repo)}
	}
	var r struct {
		Permissions struct {
			Push bool `json:"push"`
		} `json:"permissions"`
	}
	_ = json.Unmarshal(body, &r)
	if !r.Permissions.Push {
		return "", &forgejoErr{reason: fmt.Sprintf("user %s can only read %s, not push", u.Login, m.opt.Repo)}
	}
	return u.Login, nil
}

func (m *Manager) forgejoGet(ctx context.Context, token, path string) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, m.opt.ForgejoURL+path, nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Authorization", "token "+token)
	req.Header.Set("Accept", "application/json")
	resp, err := m.opt.HTTP.Do(req)
	if err != nil {
		return nil, 0, scrub(err, token)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return b, resp.StatusCode, nil
}

func scrub(err error, secret string) error {
	if err == nil || secret == "" {
		return err
	}
	return fmt.Errorf("%s", strings.ReplaceAll(err.Error(), secret, "***"))
}

// ProbeUpload is the optional, explicit write test: it uploads a tiny file to
// a scratch generic package and deletes it again. It proves the token has the
// package write scope, which /api/v1/user cannot show.
func (m *Manager) ProbeUpload(ctx context.Context, c *ForgejoCreds) error {
	owner, _, _ := strings.Cut(m.opt.Repo, "/")
	ver := fmt.Sprintf("probe-%d", time.Now().UnixNano())
	base := fmt.Sprintf("%s/api/packages/%s/generic/release-probe/%s", c.BaseURL, owner, ver)
	do := func(method, u string, body io.Reader) (int, error) {
		req, err := http.NewRequestWithContext(ctx, method, u, body)
		if err != nil {
			return 0, err
		}
		req.Header.Set("Authorization", "token "+c.Token)
		resp, err := m.opt.HTTP.Do(req)
		if err != nil {
			return 0, scrub(err, c.Token)
		}
		defer resp.Body.Close()
		_, _ = io.Copy(io.Discard, resp.Body)
		return resp.StatusCode, nil
	}
	code, err := do(http.MethodPut, base+"/probe.txt", strings.NewReader("release tool probe\n"))
	if err != nil {
		return fmt.Errorf("probe upload: %w", err)
	}
	if code != http.StatusCreated && code != http.StatusOK {
		return fmt.Errorf("probe upload refused (%d): token needs the write:package scope", code)
	}
	code, err = do(http.MethodDelete, base, nil)
	if err != nil {
		return fmt.Errorf("probe delete: %w", err)
	}
	if code != http.StatusNoContent && code != http.StatusOK {
		return fmt.Errorf("probe uploaded but could not be deleted (%d): remove package release-probe %s by hand", code, ver)
	}
	return nil
}
