# Release signing keys

LibreServ and Luna use **separate** minisign keypairs. Same release ritual
(`./release.sh`), different trust roots — a leaked Luna secret must not be able
to ship a trusted LibreServ update, and vice versa.

| Product | Public key (committed) | Secret (never in git) | Cloud Agent env |
|---------|------------------------|------------------------|-----------------|
| LibreServ (`v*`) | `keys/libreserv.minisign.pub` | `~/.minisign/libreserv.key` | `LIBRESERV_RELEASE_MINISIG_PK` + `LIBRESERV_RELEASE_MINISIG_PW` |
| Luna (`luna-v*`) | `keys/luna.minisign.pub` | `~/.minisign/luna.key` | `LSLUNA_RELEASE_MINISIG_PK` + `LSLUNA_RELEASE_MINISIG_PW` |

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
| `keys/luna.minisign.pub` | canonical Luna pub |
| `luna/crates/lunad/src/updates.rs` `PINNED_PUB` | Luna embed (`include_str!`) |

A LibreServ unit test fails if the embed drifts from `keys/libreserv.minisign.pub`.

## Key ceremony (Max-operated)

Do this on a trusted machine. Do **not** commit secret keys.

### Current state (post-split plumbing)

Both product pubs still hold the former shared key (`7AA9417DBF891F5E`) so
existing secrets (`~/.minisign/libreserv.key` / current `LSLUNA_*`) keep working
while the plumbing is product-specific. LibreServ signing must use
`LIBRESERV_RELEASE_MINISIG_*` or `~/.minisign/libreserv.key` — not `LSLUNA_*`.

### Create a Luna-only key (isolation)

```bash
mkdir -p ~/.minisign
minisign -G -p keys/luna.minisign.pub -s ~/.minisign/luna.key
```

1. Commit the new `keys/luna.minisign.pub`.
2. Dual-trust transition: put **two** `RW…` lines in `keys/luna.minisign.pub`
   (old shared key first, new Luna key second) so boxes that only trust the old
   key can still install one hop. `PINNED_PUB` follows that file.
3. Sign the next `luna-v*` release with the **new** Luna secret
   (`LSLUNA_RELEASE_MINISIG_PK` / `~/.minisign/luna.key`).
4. After fielded boxes are on a build that embeds the new key, drop the old
   shared `RW…` line from `keys/luna.minisign.pub` and the embed.

### Optional: rotate LibreServ to a fresh key

LibreServ has no signed field releases yet, so a clean cut is fine:

```bash
minisign -G -p keys/libreserv.minisign.pub -s ~/.minisign/libreserv.key
```

Then copy the pub into
`server/backend/internal/system/releases.minisign.pub` and the heredoc in
`install.sh`, and set `LIBRESERV_RELEASE_MINISIG_PK` / `_PW`.

### Recreate a public file from a secret

```bash
minisign -R -s ~/.minisign/libreserv.key -p keys/libreserv.minisign.pub
# or
minisign -R -s ~/.minisign/luna.key -p keys/luna.minisign.pub
```

## Verify checksums

```bash
# LibreServ release
minisign -Vm SHA256SUMS.txt -p keys/libreserv.minisign.pub

# Luna release
minisign -Vm SHA256SUMS.txt -p keys/luna.minisign.pub
```
