package secrets

import (
	"context"
	"crypto/x509"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"software.sslmate.com/src/go-pkcs12"
)

// Keystore is a proven Android release keystore. The engine mounts Path
// read-only into the gradle job (Materialize writes Data out when the keystore
// came from env or the keyring).
type Keystore struct {
	Path          string // "" when the keystore only exists in memory
	Data          []byte
	Alias         string
	StorePassword string
	KeyPassword   string
	CertSHA256    string // hex, lower case
}

// Materialize returns a file path for the keystore, writing Data into dir
// (mode 0600) when it has no file of its own.
func (k *Keystore) Materialize(dir string) (string, error) {
	if k.Path != "" {
		return k.Path, nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	p := filepath.Join(dir, "release.keystore")
	return p, os.WriteFile(p, k.Data, 0o600)
}

type ksCand struct {
	Where string
	Path  string
	Data  []byte
	Hash  string
}

func (m *Manager) keystoreCandidates(ctx context.Context, withScan bool, disc *discovered) []*ksCand {
	var out []*ksCand
	seen := map[string]*ksCand{}
	add := func(where, path string, data []byte) {
		h := fullHash(data)
		if e, ok := seen[h]; ok {
			e.Where += ", " + where
			if e.Path == "" {
				e.Path = path
			}
			return
		}
		c := &ksCand{Where: where, Path: path, Data: data, Hash: h}
		seen[h] = c
		out = append(out, c)
	}
	for _, f := range sortedCands(disc.keystores) {
		if st, err := os.Stat(f.Path); err != nil || st.Size() > maxKeystoreFileSize {
			continue
		}
		if b, err := os.ReadFile(f.Path); err == nil {
			add(f.Where, f.Path, b)
		}
	}
	// env: NAME / NAME_FILE / NAME_CMD hold a path; NAME_B64 holds the bytes.
	for _, f := range m.env(ctx, "LUNA_ANDROID_KEYSTORE") {
		if strings.HasSuffix(f.Where, "_B64") {
			m.redact(f.Value)
			add(f.Where, "", []byte(f.Value))
			continue
		}
		p := m.expand(f.Value)
		if b, err := os.ReadFile(p); err == nil {
			add(f.Where+" -> "+m.tilde(p), p, b)
		}
	}
	for _, f := range m.stored(ctx, SlotAndroidKeystore) {
		if b, err := decodeB64(f.Value); err == nil {
			add(f.Where, "", b)
		}
	}
	return out
}

func (m *Manager) androidPasswords(ctx context.Context) (store, key []found, aliases []string) {
	store = append(m.env(ctx, "LUNA_ANDROID_STORE_PASSWORD"), m.stored(ctx, SlotAndroidStorePW)...)
	key = append(m.env(ctx, "LUNA_ANDROID_KEY_PASSWORD"), m.stored(ctx, SlotAndroidKeyPW)...)
	for _, f := range m.env(ctx, "LUNA_ANDROID_KEY_ALIAS") {
		aliases = append(aliases, f.Value)
	}
	for _, f := range m.stored(ctx, SlotAndroidAlias) {
		aliases = append(aliases, f.Value)
	}
	if a := m.loadConfig().AndroidAlias; a != "" {
		aliases = append(aliases, a)
	}
	aliases = append(aliases, "luna")
	return
}

type ksResult struct {
	c     Candidate
	ok    bool
	value *Keystore
}

func (m *Manager) resolveAndroid(ctx context.Context) *resolved {
	s := Status{ID: AndroidKeystore, Label: "Android release keystore"}
	cfg := m.loadConfig()
	pin := normFingerprint(cfg.AndroidCertSHA256)
	disc := m.fastSources()
	cands := m.keystoreCandidates(ctx, false, disc)
	storePW, keyPW, aliases := m.androidPasswords(ctx)

	var results []ksResult
	tried := map[string]bool{}
	var needPW []*ksCand
	test := func(c *ksCand) {
		if tried[c.Hash] {
			return
		}
		res, opened := m.openKeystore(c, storePW, keyPW, aliases, pin)
		if !opened {
			needPW = append(needPW, c)
			return
		}
		tried[c.Hash] = true
		results = append(results, res)
	}
	for _, c := range cands {
		test(c)
	}
	proven := func() int {
		n := 0
		for _, r := range results {
			if r.ok {
				n++
			}
		}
		return n
	}
	if (proven() == 0 || m.opt.ForceScan || m.forceScanOnce) && !m.opt.NoHomeScan {
		before := len(disc.keystores)
		m.scanHome(ctx, disc)
		if len(disc.keystores) > before {
			sub := &discovered{keystores: disc.keystores[before:]}
			for _, c := range m.keystoreCandidates(ctx, true, sub) {
				dup := false
				for _, e := range cands {
					if e.Hash == c.Hash {
						dup = true
					}
				}
				if !dup {
					cands = append(cands, c)
					test(c)
				}
			}
		}
	}
	if proven() == 0 && m.opt.Prompter != nil {
		for _, c := range append([]*ksCand(nil), needPW...) {
			pw := m.ask(ctx, Question{
				Slot: SlotAndroidStorePW, Label: "Password for the Android keystore " + m.tilde(coalesce(c.Path, "from "+c.Where)), Secret: true,
				Hint: "The store password you chose when running keytool -genkeypair.",
			})
			if pw == "" {
				continue
			}
			res, opened := m.openKeystore(c, []found{{Where: "typed password", Value: pw}}, keyPW, aliases, pin)
			if opened {
				results = append(results, res)
				tried[c.Hash] = true
				needPW = removeKS(needPW, c)
			}
		}
	}
	for _, c := range needPW {
		if !tried[c.Hash] {
			results = append(results, ksResult{c: Candidate{Where: c.Where, Ref: refOf(c.Hash), Outcome: Unusable,
				Reason: fmt.Sprintf("none of the %d known passwords opens it", len(storePW))}})
		}
	}

	var okIdx []int
	for i, r := range results {
		if r.ok {
			okIdx = append(okIdx, i)
		}
	}
	chosen := -1
	if len(okIdx) == 1 {
		chosen = okIdx[0]
	} else if len(okIdx) > 1 {
		for _, i := range okIdx {
			if results[i].c.Ref == cfg.Choices[AndroidKeystore] {
				chosen = i
			}
		}
	}
	for i, r := range results {
		c := r.c
		if r.ok {
			c.Outcome = Valid
			if i == chosen {
				c.Outcome = Used
			} else if chosen < 0 {
				c.Reason = "also valid; pick one with Choose"
			} else {
				c.Reason = "also valid, but another keystore was chosen"
			}
		}
		s.Candidates = append(s.Candidates, c)
	}
	switch {
	case chosen >= 0:
		k := results[chosen].value
		s.State = Proven
		if pin == "" {
			s.Summary = "Opens, alias " + k.Alias + " exists, certificate SHA-256 " + colonHex(k.CertSHA256) + ". Not pinned yet: pin it to detect a swapped keystore."
		} else {
			s.Summary = "Opens, alias " + k.Alias + " exists, certificate matches the pinned fingerprint."
		}
		return &resolved{status: s, value: k}
	case len(okIdx) > 1:
		s.State = Conflict
		s.Summary = fmt.Sprintf("%d different keystores all open. Choose which one releases use.", len(okIdx))
	case len(results) > 0:
		s.State = Failed
		s.Summary = "Found keystores, but none opened with a known password, alias and certificate."
	default:
		s.State = Missing
		s.Summary = "No Android keystore found. Add the folder holding the .jks file, or paste it."
	}
	return &resolved{status: s}
}

func removeKS(l []*ksCand, c *ksCand) []*ksCand {
	out := l[:0]
	for _, x := range l {
		if x != c {
			out = append(out, x)
		}
	}
	return out
}

func coalesce(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// openKeystore tries every store password. opened=false means no password
// opened it (so a prompt may help); otherwise res says whether it fully proved.
func (m *Manager) openKeystore(c *ksCand, storePW, keyPW []found, aliases []string, pin string) (res ksResult, opened bool) {
	res.c = Candidate{Where: c.Where, Ref: refOf(c.Hash)}
	jks := len(c.Data) >= 4 && c.Data[0] == 0xFE && c.Data[1] == 0xED && c.Data[2] == 0xFE && c.Data[3] == 0xED
	for _, sp := range storePW {
		var (
			cert  *x509.Certificate
			alias string
			err   error
			kp    string
		)
		if jks {
			cert, alias, kp, err = tryJKS(c.Data, sp.Value, keyPW, aliases)
		} else {
			cert, alias, kp, err = tryP12(c.Data, sp.Value, aliases)
		}
		if errors.Is(err, errJKSPassword) || errors.Is(err, pkcs12.ErrIncorrectPassword) {
			continue
		}
		if err != nil && cert == nil {
			// Opened (or not a keystore at all) but unusable.
			if isNotKeystore(err) {
				res.c.Outcome = Rejected
				res.c.Reason = err.Error()
				return res, true
			}
			res.c.Outcome = Rejected
			res.c.Reason = "opened with " + sp.Where + ", but " + err.Error()
			return res, true
		}
		fp := fullHash(cert.Raw)
		res.c.Detail = "alias " + alias + ", SHA-256 " + colonHex(fp)
		if pin != "" && pin != fp {
			res.c.Outcome = Rejected
			res.c.Reason = "certificate does not match the pinned fingerprint " + colonHex(pin)
			return res, true
		}
		res.ok = true
		res.value = &Keystore{Path: c.Path, Data: c.Data, Alias: alias, StorePassword: sp.Value, KeyPassword: kp, CertSHA256: fp}
		return res, true
	}
	return res, false
}

type notKeystoreErr struct{ error }

func isNotKeystore(err error) bool { var n notKeystoreErr; return errors.As(err, &n) }

func tryJKS(data []byte, storePW string, keyPW []found, aliases []string) (*x509.Certificate, string, string, error) {
	entries, err := parseJKS(data, storePW)
	if err != nil {
		return nil, "", "", err
	}
	for _, a := range aliases {
		for _, e := range entries {
			if !e.IsKey || !strings.EqualFold(e.Alias, a) {
				continue
			}
			var kp string
			var kerr error = errors.New("wrong key password")
			for _, cand := range append(keyPW, found{Value: storePW}) {
				if kerr = jksCheckKeyPassword(e.Protected, cand.Value); kerr == nil {
					kp = cand.Value
					break
				}
			}
			if kerr != nil {
				return nil, "", "", fmt.Errorf("alias %s: %w", e.Alias, kerr)
			}
			if len(e.Chain) == 0 {
				return nil, "", "", fmt.Errorf("alias %s has no certificate", e.Alias)
			}
			cert, err := x509.ParseCertificate(e.Chain[0])
			if err != nil {
				return nil, "", "", fmt.Errorf("alias %s: certificate unreadable", e.Alias)
			}
			return cert, e.Alias, kp, nil
		}
	}
	return nil, "", "", fmt.Errorf("none of the aliases %s exists in it", strings.Join(aliases, ", "))
}

// tryP12 opens a PKCS#12 keystore. Go cannot read friendly names, so the
// alias is not checked; keytool writes one key with the store password.
func tryP12(data []byte, storePW string, aliases []string) (*x509.Certificate, string, string, error) {
	key, cert, _, err := pkcs12.DecodeChain(data, storePW)
	if err != nil {
		if errors.Is(err, pkcs12.ErrIncorrectPassword) {
			return nil, "", "", err
		}
		return nil, "", "", notKeystoreErr{fmt.Errorf("not a readable keystore (%v)", err)}
	}
	_ = key
	return cert, aliases[0], storePW, nil
}
