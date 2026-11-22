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
// read-only into the APK signing step, never into gradle (Materialize writes
// Data out when the keystore came from env or the keyring). The passwords are
// the passphrases typed at Unlock; Manager.Wipe zeroes them.
type Keystore struct {
	Path          string // "" when the keystore only exists in memory
	Data          []byte
	Alias         string
	StorePassword []byte
	KeyPassword   []byte
	CertSHA256    string // hex, lower case
}

// Wipe zeroes the passwords.
func (k *Keystore) Wipe() {
	wipeBytes(k.StorePassword)
	wipeBytes(k.KeyPassword)
	k.StorePassword, k.KeyPassword = nil, nil
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

// androidAliases lists the key aliases to look for. The store and key
// passwords are only ever the passphrases typed at Unlock.
func (m *Manager) androidAliases(ctx context.Context) (aliases []string) {
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
	aliases := m.androidAliases(ctx)

	var results []ksResult
	tried := map[string]bool{}
	var needPW []*ksCand
	why := map[string]string{} // why a keystore in needPW is still closed
	test := func(c *ksCand) {
		if tried[c.Hash] {
			return
		}
		res, opened := m.openKeystore(c, aliases, pin)
		if !opened {
			if res.c.Reason != "" {
				why[c.Hash] = res.c.Reason
			}
			if !containsKS(needPW, c) {
				needPW = append(needPW, c)
			}
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
	if proven() == 0 && len(needPW) > 0 && m.unlocking && m.opt.Prompter != nil && m.askReleasePassphrase(ctx) {
		for _, c := range append([]*ksCand(nil), needPW...) {
			test(c)
			if tried[c.Hash] {
				needPW = removeKS(needPW, c)
			}
		}
		for _, c := range append([]*ksCand(nil), needPW...) {
			if proven() > 0 {
				break
			}
			name := "the Android release keystore (" + m.tilde(coalesce(c.Path, "from "+c.Where)) + ")"
			for try := 0; try < maxPassphraseTries && !tried[c.Hash]; try++ {
				label := "The release passphrase does not open " + name + " or the key inside it. Type its passphrase"
				if try > 0 {
					label = "That passphrase does not open " + name + " either. Try again"
				}
				if !m.askKeyPassphrase(ctx, coalesce(c.Path, c.Where), label,
					"The keystore's password (also tried as the key's own password). It is used for this run only and never saved.") {
					break
				}
				test(c)
			}
			if tried[c.Hash] {
				needPW = removeKS(needPW, c)
			}
		}
	}
	for _, c := range needPW {
		if !tried[c.Hash] {
			r := noPasswordReason(len(m.passes))
			if why[c.Hash] != "" {
				r = why[c.Hash]
			}
			results = append(results, ksResult{c: Candidate{Where: c.Where, Ref: refOf(c.Hash), Outcome: Unusable, Reason: r}})
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
	case len(results) > 0 && len(needPW) == len(results) && len(m.passes) == 0:
		s.State = Locked
		s.NeedsPassword = true
		s.Summary = "Found the Android keystore. It is opened with the release passphrase, which is asked in the terminal when a cut is about to sign."
	case len(results) > 0:
		s.State = Failed
		s.Summary = "Found keystores, but none opened with the passphrase typed, the alias and the pinned certificate."
		s.NeedsPassword = len(needPW) > 0 && len(results) == len(needPW)
	default:
		s.State = Missing
		s.Summary = "No Android keystore found. Add the folder holding the .jks file, or paste it."
	}
	return &resolved{status: s}
}

func containsKS(l []*ksCand, c *ksCand) bool {
	for _, x := range l {
		if x == c {
			return true
		}
	}
	return false
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

// openKeystore tries every passphrase typed this run as the store password
// (and each, plus the store password, as the key password). opened=false
// means none opened it, or none opened the key inside (so a prompt may help);
// otherwise res says whether it fully proved.
func (m *Manager) openKeystore(c *ksCand, aliases []string, pin string) (res ksResult, opened bool) {
	res.c = Candidate{Where: c.Where, Ref: refOf(c.Hash)}
	jks := len(c.Data) >= 4 && c.Data[0] == 0xFE && c.Data[1] == 0xED && c.Data[2] == 0xFE && c.Data[3] == 0xED
	for _, sp := range m.passes {
		var (
			cert  *x509.Certificate
			alias string
			err   error
			kp    []byte
		)
		if jks {
			cert, alias, kp, err = tryJKS(c.Data, sp.Value, m.passes, aliases)
		} else {
			cert, alias, kp, err = tryP12(c.Data, sp.Value, aliases)
		}
		if errors.Is(err, errJKSKeyPassword) {
			res.c.Reason = "the store opens with the " + sp.Where + ", but no passphrase typed opens the key inside it (wrong key password)"
			continue
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
			res.c.Reason = "opened with the " + sp.Where + ", but " + err.Error()
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
		res.c.Reason = ""
		// The keystore shares the typed passphrase bytes, so Wipe clears both.
		res.value = &Keystore{Path: c.Path, Data: c.Data, Alias: alias, StorePassword: sp.Value, KeyPassword: kp, CertSHA256: fp}
		return res, true
	}
	return res, false
}

type notKeystoreErr struct{ error }

func isNotKeystore(err error) bool { var n notKeystoreErr; return errors.As(err, &n) }

// errJKSKeyPassword: the store opened, but no passphrase opens the key.
var errJKSKeyPassword = errors.New("wrong key password")

func tryJKS(data []byte, storePW []byte, keyPW []passphrase, aliases []string) (*x509.Certificate, string, []byte, error) {
	entries, err := parseJKS(data, string(storePW))
	if err != nil {
		return nil, "", nil, err
	}
	for _, a := range aliases {
		for _, e := range entries {
			if !e.IsKey || !strings.EqualFold(e.Alias, a) {
				continue
			}
			var kp []byte
			kerr := errJKSKeyPassword
			for _, cand := range append([][]byte{storePW}, passValues(keyPW)...) {
				if err := jksCheckKeyPassword(e.Protected, string(cand)); err == nil {
					kp, kerr = cand, nil
					break
				} else if !errors.Is(err, errJKSKeyPassword) {
					kerr = err
					break
				}
			}
			if kerr != nil {
				if errors.Is(kerr, errJKSKeyPassword) {
					return nil, "", nil, kerr
				}
				return nil, "", nil, fmt.Errorf("alias %s: %w", e.Alias, kerr)
			}
			if len(e.Chain) == 0 {
				return nil, "", nil, fmt.Errorf("alias %s has no certificate", e.Alias)
			}
			cert, err := x509.ParseCertificate(e.Chain[0])
			if err != nil {
				return nil, "", nil, fmt.Errorf("alias %s: certificate unreadable", e.Alias)
			}
			return cert, e.Alias, kp, nil
		}
	}
	return nil, "", nil, fmt.Errorf("none of the aliases %s exists in it", strings.Join(aliases, ", "))
}

func passValues(ps []passphrase) [][]byte {
	out := make([][]byte, 0, len(ps))
	for _, p := range ps {
		out = append(out, p.Value)
	}
	return out
}

// tryP12 opens a PKCS#12 keystore. Go cannot read friendly names, so the
// alias is not checked; keytool writes one key with the store password.
func tryP12(data []byte, storePW []byte, aliases []string) (*x509.Certificate, string, []byte, error) {
	_, cert, _, err := pkcs12.DecodeChain(data, string(storePW))
	if err != nil {
		if errors.Is(err, pkcs12.ErrIncorrectPassword) {
			return nil, "", nil, err
		}
		return nil, "", nil, notKeystoreErr{fmt.Errorf("not a readable keystore (%v)", err)}
	}
	return cert, aliases[0], storePW, nil
}

// noPasswordReason explains why a protected file stayed closed.
func noPasswordReason(tried int) string {
	if tried == 0 {
		return "Not opened yet: the release passphrase is asked when a cut is about to sign"
	}
	return fmt.Sprintf("none of the %d passphrases typed opens it", tried)
}
