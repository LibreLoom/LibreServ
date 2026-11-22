package secrets

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"aead.dev/minisign"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/feed"
)

// product is one signing key. EnvKey names env vars that may hold the
// (encrypted) key text or a path to it. There are no password variables: key
// passwords are only ever typed (Manager.Unlock).
type product struct {
	ID      ID
	Label   string
	PubFile string
	EnvKey  []string
}

var products = []product{
	{SolSigning, "Sol release signing key", "sol.minisign.pub",
		[]string{"SOL_RELEASE_MINISIG_PK", "MINISIGN_SECRET_KEY"}},
	{LunaSigning, "Luna release signing key", "luna.minisign.pub",
		[]string{"LUNA_RELEASE_MINISIG_PK", "MINISIGN_SECRET_KEY"}},
}

func productOf(id ID) (product, bool) {
	for _, p := range products {
		if p.ID == id {
			return p, true
		}
	}
	return product{}, false
}

// Signer signs in-process with a proven release key (no minisign CLI).
type Signer struct {
	ID    ID
	KeyID string // upper-case hex, as printed in the public key's comment
	key   minisign.PrivateKey
	pub   minisign.PublicKey
}

// Sign returns a .minisig for msg (hashed minisign format).
func (s *Signer) Sign(msg []byte) []byte { return minisign.Sign(s.key, msg) }

// SignWithComment signs msg in the prehashed "ED" form with a signed trusted
// comment, which is what feeds and SHA256SUMS.txt need (publish.Signer).
func (s *Signer) SignWithComment(msg []byte, trustedComment string) ([]byte, error) {
	return feed.Sign(s.key, msg, trustedComment)
}

// Verify checks a signature against the product's public key from keys/.
func (s *Signer) Verify(msg, sig []byte) bool { return minisign.Verify(s.pub, msg, sig) }

// wipe overwrites the decrypted key in place. A wiped Signer cannot sign
// (its signatures no longer verify).
func (s *Signer) wipe() { s.key = minisign.PrivateKey{} }

func keyIDString(id uint64) string { return fmt.Sprintf("%016X", id) }

type keyFile struct {
	Where []string
	Path  string // empty for env / keyring blobs
	Data  []byte
	Hash  string
}

type signState struct {
	m       *Manager
	pubs    map[ID]minisign.PublicKey
	pubErr  map[ID]error
	cands   map[ID][]Candidate
	shared  []Candidate // files that cannot be attributed to one product
	signers map[ID]*Signer
	plain   map[ID]bool             // the key used was not encrypted
	tried   map[string]map[int]bool // file hash -> index into Manager.passes
	done    map[string]bool         // file hash -> examined
	failed  []*keyFile              // encrypted, no password worked
	cache   cacheFile
	want    ID // the one key a caller needs; "" means both
}

func (st *signState) allProven() bool { return len(st.signers) == len(products) }

// satisfied is true when every key this resolve was asked for is proven.
func (st *signState) satisfied() bool {
	if st.want == "" {
		return st.allProven()
	}
	_, ok := st.signers[st.want]
	return ok
}

// resolveSigning proves the signing keys. want names the one a caller needs:
// only that key's files are asked about and only its result is remembered, so
// a Sol cut never stops to ask for the Luna key's password. "" proves both.
func (m *Manager) resolveSigning(ctx context.Context, want ID) {
	st := &signState{
		want: want,
		m:    m, pubs: map[ID]minisign.PublicKey{}, pubErr: map[ID]error{},
		cands: map[ID][]Candidate{}, signers: map[ID]*Signer{}, plain: map[ID]bool{},
		tried: map[string]map[int]bool{}, done: map[string]bool{},
		cache: m.loadCache(),
	}
	for _, p := range products {
		pk, err := minisign.PublicKeyFromFile(filepath.Join(m.opt.RepoRoot, "keys", p.PubFile))
		if err != nil {
			st.pubErr[p.ID] = err
			continue
		}
		st.pubs[p.ID] = pk
	}
	disc := m.fastSources()
	files := m.loadKeyFiles(sortedCands(disc.keys), st.cache)
	files = append(files, m.keyBlobs(ctx)...)
	st.examineAll(ctx, mergeKeyFiles(files))

	if !m.opt.NoHomeScan && (!st.satisfied() || m.opt.ForceScan || m.forceScanOnce) {
		before := len(disc.keys)
		m.scanHome(ctx, disc)
		if len(disc.keys) > before {
			st.examineAll(ctx, mergeKeyFiles(m.loadKeyFiles(sortedCands(disc.keys[before:]), st.cache)))
		}
	}
	st.promptLoop(ctx)

	for _, p := range products {
		r := st.finish(p)
		// Asking was limited to the wanted key: another key that is not
		// proven is not settled, so a later lookup for it asks properly.
		if want != "" && p.ID != want && r.status.State != Proven {
			continue
		}
		m.memo[p.ID] = r
	}
}

// loadKeyFiles reads the candidate files; cached key IDs of release keys come first.
func (m *Manager) loadKeyFiles(cs []fileCand, cache cacheFile) []*keyFile {
	var out []*keyFile
	for _, c := range cs {
		data, err := os.ReadFile(c.Path)
		if err != nil || !isMinisignSecretText(data) {
			continue
		}
		m.redact(string(trimSecretLine(data)))
		out = append(out, &keyFile{Where: []string{c.Where}, Path: c.Path, Data: data, Hash: fullHash(data)})
	}
	sort.SliceStable(out, func(i, j int) bool {
		return cachedRelease(cache, out[i]) && !cachedRelease(cache, out[j])
	})
	return out
}

func cachedRelease(c cacheFile, f *keyFile) bool {
	e, ok := lookupCache(c, f.Path, f.Hash)
	if !ok {
		return false
	}
	return e.KeyID != "" && e.KeyID != "other"
}

func lookupCache(c cacheFile, path, hash string) (CacheEntry, bool) {
	for _, e := range c.Keys {
		if e.Path == path && e.SHA256 == hash {
			return e, true
		}
	}
	return CacheEntry{}, false
}

func trimSecretLine(data []byte) []byte {
	lines := splitLines(data)
	if len(lines) > 1 && len(lines[0]) > 0 && string(lines[0][:min(len(lines[0]), 18)]) == "untrusted comment:" {
		return lines[1]
	}
	return lines[0]
}

func splitLines(b []byte) [][]byte {
	var out [][]byte
	start := 0
	for i, c := range b {
		if c == '\n' {
			out = append(out, trimCR(b[start:i]))
			start = i + 1
		}
	}
	if start < len(b) {
		out = append(out, trimCR(b[start:]))
	}
	if len(out) == 0 {
		out = [][]byte{nil}
	}
	return out
}

func trimCR(b []byte) []byte {
	if n := len(b); n > 0 && b[n-1] == '\r' {
		return b[:n-1]
	}
	return b
}

// keyBlobs collects key text from env (NAME forms hold text or a path) and
// from remembered slots.
func (m *Manager) keyBlobs(ctx context.Context) []*keyFile {
	var out []*keyFile
	seenEnv := map[string]bool{}
	add := func(f found) {
		if isMinisignSecretText(append([]byte(nil), []byte(f.Value)...)) {
			out = append(out, &keyFile{Where: []string{f.Where}, Data: []byte(f.Value), Hash: fullHash([]byte(f.Value))})
			return
		}
		// A path to a key file.
		p := m.expand(f.Value)
		if data, ok := readMinisignSecret(p); ok {
			m.redact(string(trimSecretLine(data)))
			out = append(out, &keyFile{Where: []string{f.Where + " -> " + m.tilde(p)}, Path: p, Data: data, Hash: fullHash(data)})
		}
	}
	for _, p := range products {
		for _, n := range p.EnvKey {
			if seenEnv[n] {
				continue
			}
			seenEnv[n] = true
			for _, f := range m.env(ctx, n) {
				add(f)
			}
		}
		for _, f := range m.stored(ctx, SlotKey(p.ID)) {
			add(f)
		}
	}
	for _, f := range out {
		m.redact(string(trimSecretLine(f.Data)))
	}
	return out
}

func mergeKeyFiles(in []*keyFile) []*keyFile {
	var out []*keyFile
	byHash := map[string]*keyFile{}
	for _, f := range in {
		if e, ok := byHash[f.Hash]; ok {
			e.Where = append(e.Where, f.Where...)
			if e.Path == "" {
				e.Path = f.Path
			}
			continue
		}
		byHash[f.Hash] = f
		out = append(out, f)
	}
	return out
}

func (st *signState) examineAll(ctx context.Context, files []*keyFile) {
	for _, f := range files {
		if ctx.Err() != nil {
			return
		}
		if st.done[f.Hash] {
			continue
		}
		st.examine(ctx, f)
	}
}

func (st *signState) where(f *keyFile) string {
	w := f.Where[0]
	for _, x := range f.Where[1:] {
		w += ", " + x
	}
	return w
}

func (st *signState) examine(ctx context.Context, f *keyFile) {
	if !minisign.IsEncrypted(f.Data) {
		var k minisign.PrivateKey
		if err := k.UnmarshalText(f.Data); err != nil {
			st.done[f.Hash] = true
			st.shared = append(st.shared, Candidate{Where: st.where(f), Ref: shortHash([]byte(f.Hash)), Outcome: Rejected, Reason: "not a valid minisign key"})
			return
		}
		st.done[f.Hash] = true
		st.handleKey(f, k, "")
		return
	}
	if hint, cached := lookupCache(st.cache, f.Path, f.Hash); cached && hint.KeyID == "other" {
		st.done[f.Hash] = true
		st.shared = append(st.shared, Candidate{Where: st.where(f), Ref: refOf(f.Hash), Outcome: Rejected, Reason: "belongs to a different key, not a release key (remembered from an earlier run)"})
		return
	}
	if st.satisfied() {
		st.done[f.Hash] = true
		st.shared = append(st.shared, Candidate{Where: st.where(f), Ref: refOf(f.Hash), Outcome: Unusable, Reason: "not tried: the release key was already proven"})
		return
	}
	tried := st.tried[f.Hash]
	if tried == nil {
		tried = map[int]bool{}
		st.tried[f.Hash] = tried
	}
	for i, pw := range st.m.passes {
		if tried[i] {
			continue
		}
		if ctx.Err() != nil {
			return
		}
		tried[i] = true
		k, err := minisign.DecryptKey(string(pw.Value), f.Data)
		if err != nil {
			continue
		}
		st.done[f.Hash] = true
		st.handleKey(f, k, pw.Where)
		return
	}
	st.failedAdd(f)
}

func (st *signState) failedAdd(f *keyFile) {
	for _, x := range st.failed {
		if x == f {
			return
		}
	}
	st.failed = append(st.failed, f)
}

// handleKey attributes a decrypted/plain key to a product and proves it.
func (st *signState) handleKey(f *keyFile, k minisign.PrivateKey, pwWhere string) {
	id := keyIDString(k.ID())
	st.removeFailed(f)
	var owner ID
	for _, p := range products {
		if pk, ok := st.pubs[p.ID]; ok && pk.ID() == k.ID() {
			owner = p.ID
		}
	}
	if f.Path != "" {
		kid := id
		if owner == "" {
			kid = "other"
		}
		e := CacheEntry{Path: f.Path, SHA256: f.Hash, KeyID: kid}
		st.m.cacheStore(e)
		st.cache.Keys = append(st.cache.Keys, e)
	}
	c := Candidate{Where: st.where(f), Ref: refOf(f.Hash), Detail: "key ID " + id}
	if owner == "" {
		c.Outcome = Rejected
		c.Reason = "key ID " + id + " is not a release key (no file in keys/ has it)"
		st.shared = append(st.shared, c)
		return
	}
	if err := proveSigning(k, st.pubs[owner]); err != nil {
		c.Outcome = Rejected
		c.Reason = err.Error()
		st.cands[owner] = append(st.cands[owner], c)
		return
	}
	if pwWhere != "" {
		c.Detail += ", opened with the " + pwWhere
	} else {
		c.Detail += ", not encrypted"
	}
	if _, ok := st.signers[owner]; ok {
		c.Outcome = Valid
		c.Reason = "same key as the one in use"
	} else {
		c.Outcome = Used
		st.signers[owner] = &Signer{ID: owner, KeyID: id, key: k, pub: st.pubs[owner]}
		st.plain[owner] = pwWhere == ""
	}
	st.cands[owner] = append(st.cands[owner], c)
}

func (st *signState) removeFailed(f *keyFile) {
	out := st.failed[:0]
	for _, x := range st.failed {
		if x != f {
			out = append(out, x)
		}
	}
	st.failed = out
}

// proveSigning signs a test message and verifies it against the public key.
func proveSigning(k minisign.PrivateKey, pub minisign.PublicKey) error {
	var nonce [8]byte
	_, _ = rand.Read(nonce[:])
	msg := []byte("libreserv-release preflight " + hex.EncodeToString(nonce[:]))
	sig := minisign.Sign(k, msg)
	if !minisign.Verify(pub, msg, sig) {
		return fmt.Errorf("a test signature did not verify against the public key in keys/")
	}
	return nil
}

// promptLoop asks for the release passphrase, and then for the passphrase of
// each key file it does not open, naming the file. It only asks while
// Manager.Unlock runs (a cut about to sign) and a wanted key is unproven.
func (st *signState) promptLoop(ctx context.Context) {
	m := st.m
	if !m.unlocking || m.opt.Prompter == nil || st.satisfied() || len(st.failed) == 0 {
		return
	}
	if !m.askReleasePassphrase(ctx) {
		return
	}
	st.retryFailed(ctx)
	for _, f := range append([]*keyFile(nil), st.failed...) {
		if st.satisfied() || ctx.Err() != nil {
			return
		}
		owner := st.knownOwner(f)
		if owner == "other" || (st.want != "" && owner != "" && owner != string(st.want)) {
			continue // remembered as another key: not needed here
		}
		name := "the signing key in " + st.where(f)
		if p, ok := productOf(ID(owner)); ok {
			name = "the " + p.Label + " (" + st.where(f) + ")"
		} else if p, ok := productOf(st.want); ok {
			name += ", which may be the " + p.Label
		}
		for try := 0; try < maxPassphraseTries && st.isFailed(f); try++ {
			label := "The release passphrase does not open " + name + ". Type the passphrase for this key"
			if try > 0 {
				label = "That passphrase does not open " + name + " either. Try again"
			}
			if !m.askKeyPassphrase(ctx, coalesce(f.Path, st.where(f)), label,
				"The passphrase this key file is encrypted with. It is used for this run only and never saved.") {
				break
			}
			st.retryFailed(ctx)
		}
	}
}

// retryFailed tries the passphrases typed so far on every file still closed.
func (st *signState) retryFailed(ctx context.Context) {
	for _, g := range append([]*keyFile(nil), st.failed...) {
		if !st.done[g.Hash] {
			st.examine(ctx, g)
		}
	}
}

func (st *signState) isFailed(f *keyFile) bool {
	for _, x := range st.failed {
		if x == f {
			return true
		}
	}
	return false
}

func (st *signState) finish(p product) *resolved {
	s := Status{ID: p.ID, Label: p.Label}
	s.Candidates = append(s.Candidates, st.cands[p.ID]...)
	s.Candidates = append(s.Candidates, st.shared...)
	for _, f := range st.failed {
		s.Candidates = append(s.Candidates, Candidate{
			Where: st.where(f), Ref: refOf(f.Hash), Outcome: Unusable,
			Reason: noPasswordReason(len(st.m.passes)),
		})
	}
	if err := st.pubErr[p.ID]; err != nil {
		s.State = Failed
		s.Summary = "Cannot read keys/" + p.PubFile + ": " + err.Error()
		return &resolved{status: s}
	}
	if sg, ok := st.signers[p.ID]; ok {
		s.State = Proven
		s.Summary = "Signs as key " + sg.KeyID + ", matching keys/" + p.PubFile + "."
		if st.plain[p.ID] {
			s.Summary += " Warning: this key file is not encrypted, so anything running as you can read it. Encrypt it with the release passphrase."
		}
		return &resolved{status: s, value: sg}
	}
	if len(st.failed) > 0 {
		s.NeedsPassword = true
		if len(st.m.passes) == 0 {
			s.State = Locked
			s.Summary = "Found encrypted key files. They are opened with the release passphrase, which is asked in the terminal when a cut is about to sign."
			for _, f := range st.failed {
				if st.knownOwner(f) == string(p.ID) {
					s.Summary = "Found the key file (" + st.where(f) + "). It is opened with the release passphrase, which is asked in the terminal when a cut is about to sign."
				}
			}
			return &resolved{status: s}
		}
		s.State = Failed
		s.Summary = "The passphrase typed does not open any key file found for this key."
		return &resolved{status: s}
	}
	s.State = Missing
	s.Summary = fmt.Sprintf("No file with key ID %s found. Add the folder holding it, or paste the key.", keyIDString(st.pubs[p.ID].ID()))
	return &resolved{status: s}
}

// knownOwner says which release key a file is, from the pairing cache:
// a product ID, "other" (not a release key) or "" (not known).
func (st *signState) knownOwner(f *keyFile) string {
	e, ok := lookupCache(st.cache, f.Path, f.Hash)
	if !ok || e.KeyID == "" {
		return ""
	}
	if e.KeyID == "other" {
		return "other"
	}
	for _, p := range products {
		if pk, ok := st.pubs[p.ID]; ok && keyIDString(pk.ID()) == e.KeyID {
			return string(p.ID)
		}
	}
	return ""
}
