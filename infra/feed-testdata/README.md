# feed-testdata

Signed **test** feeds that every receiver (Sol in Go, lunad in Rust, bash
scripts) tests against. Spec: `../docs/RELEASE-PLAN.md`.

**TEST ONLY.** `test-key.pub` belongs to a throwaway key derived from a public
seed, so anyone can sign with it. Never copy it into `keys/` and never trust it
in a production build. Tests inject it through the receiver's key-override hook.

## Regenerate

```
(cd infra/ci-source && go run ./cmd/feedgen)   # or -out DIR
```

Output is deterministic (fixed key seed, fixed times, fixed trusted comment):
re-running must change nothing. `go test ./internal/feed` checks this.

## Files

- `cases.json` — every case; loop over it. `expect` is one of `update`,
  `no-update`, `reject:<reason>`, `download-ok`, `download-fail:<reason>`.
  Reasons: `bad-signature`, `wrong-unit`, `wrong-channel`, `unknown-format`,
  `replayed`, `missing-part`, `size-mismatch`, `sha-mismatch`,
  `all-urls-failed`.
- `<name>.json` + `.json.minisig` — feeds. A case's `sig` may name another
  file (wrong key, or the signature of a different feed).
- `files/` — payloads the parts point at, plus `SHA256SUMS.txt` (+ `.minisig`)
  with decoy lines for the exact-file-name rule (`cases.json` → `sums`).
- `cases.json` → `semver` — `ascending` must parse and sort in that order;
  every `invalid` entry must be rejected.

## Request fields

`unit`, `channel`, `os`, `arch`, `part` are what the receiver asks for;
`installed_version` is what it runs; `newest_published_seen` is the stored
newest `published` for that unit + channel (`""` = none). Check order: signature,
format, unit, channel, replay, part, then version.

## Download cases

URLs use the host `http://feed-test.invalid` (`url_base`). After verifying and
parsing, rewrite that prefix on the parsed struct to your local test server.
That server serves `files/` at its root; any path under `/missing/` returns 404.
Never rewrite before verification (the signature covers the original bytes).
