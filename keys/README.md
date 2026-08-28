# Release signing keys

LibreServ and Luna use **separate** minisign keypairs. Same release ritual
(`./release.sh`), different trust roots — a leaked Luna secret must not be able
to ship a trusted LibreServ update, and vice versa.

| Product | Public key (committed) | Secret (never in git) | Cloud Agent env |
|---------|------------------------|------------------------|-----------------|
| LibreServ (`v*`) | `keys/libreserv.minisign.pub` | `~/.minisign/libreserv.key` | `LIBRESERV_RELEASE_MINISIG_PK` + `LIBRESERV_RELEASE_MINISIG_PW` |
| Luna (`luna-v*`) | `keys/lsluna.minisign.pub` | `~/.minisign/lsluna.key` | `LSLUNA_RELEASE_MINISIG_PK` + `LSLUNA_RELEASE_MINISIG_PW` |

Generic overrides for either product: `MINISIGN_SECRET_KEY` (path or key text)
and `MINISIGN_PASSPHRASE`.

`release.sh` picks the product pub from `--luna` / the tag, signs
`SHA256SUMS.txt`, and **refuses to publish** if the signature does not verify
against that pub.

## Where the public keys are baked in

Keep these identical to the committed files:

| File | Must match |
|------|------------|
| `keys/libreserv.minisign.pub` | canonical LibreServ pub |
| `server/backend/internal/system/releases.minisign.pub` | LibreServ embed (`go:embed`) |
| `install.sh` `RELEASE_MINISIGN_PUB` heredoc | LibreServ installer |
| `keys/lsluna.minisign.pub` | canonical Luna pub |
| `luna/crates/lunad/src/updates.rs` `PINNED_PUB` | Luna embed (`include_str!`) |

A LibreServ unit test fails if the embed drifts from `keys/libreserv.minisign.pub`.

## Ownership

**The existing production keypair (`7AA9417DBF891F5E`) is Luna’s.** It lives in
`keys/lsluna.minisign.pub` and is used with `LSLUNA_RELEASE_MINISIG_*` /
`~/.minisign/lsluna.key`. **Do not regenerate it.**

If the Luna secret is still at the old path `~/.minisign/libreserv.key`, rename
it:

```bash
mkdir -p ~/.minisign
mv ~/.minisign/libreserv.key ~/.minisign/lsluna.key
```

## Key ceremony — LibreServ only

LibreServ needs its **own** new keypair (no signed LibreServ field releases yet,
so a clean cut is fine). Do this on a trusted machine. Do **not** commit secret
keys.

```bash
mkdir -p ~/.minisign
minisign -G -p keys/libreserv.minisign.pub -s ~/.minisign/libreserv.key
```

Then:

1. Commit `keys/libreserv.minisign.pub`.
2. Copy it into `server/backend/internal/system/releases.minisign.pub` and the
   heredoc in `install.sh` (keep all three identical).
3. Set Cloud Agent secrets `LIBRESERV_RELEASE_MINISIG_PK` +
   `LIBRESERV_RELEASE_MINISIG_PW`.

Until that LibreServ ceremony is done, `keys/libreserv.minisign.pub` may still
temporarily match Luna’s pub from the pre-split era — replace it before the
first signed `v*` cut. Never sign LibreServ releases with `LSLUNA_*`.

### Recreate a public file from a secret

```bash
minisign -R -s ~/.minisign/lsluna.key -p keys/lsluna.minisign.pub
minisign -R -s ~/.minisign/libreserv.key -p keys/libreserv.minisign.pub
```

## Verify checksums

```bash
# Luna release
minisign -Vm SHA256SUMS.txt -p keys/lsluna.minisign.pub

# LibreServ release
minisign -Vm SHA256SUMS.txt -p keys/libreserv.minisign.pub
```
