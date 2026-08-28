# Release signing keys

LibreServ and Luna use **separate** minisign keypairs. Same release ritual
(`./release.sh`), different trust roots — a leaked Luna secret must not be able
to ship a trusted LibreServ update, and vice versa.

| Product | Public key (committed) | Secret (never in git) | Cursor / Cloud Agent secrets |
|---------|------------------------|------------------------|------------------------------|
| LibreServ (`v*`) | `keys/libreserv.minisign.pub` (`48EB64CB69EA36CD`) | `~/.minisign/libreserv.key` | `LIBRESERV_RELEASE_MINISIG_PK` + `LIBRESERV_RELEASE_MINISIG_PW` |
| Luna (`luna-v*`) | `keys/lsluna.minisign.pub` (`7AA9417DBF891F5E`) | `~/.minisign/lsluna.key` | `LSLUNA_RELEASE_MINISIG_PK` + `LSLUNA_RELEASE_MINISIG_PW` |

Also used for non-interactive cuts: `FORGEJO_TOKEN`.

Generic overrides for either product: `MINISIGN_SECRET_KEY` (path or key text)
and `MINISIGN_PASSPHRASE`.

`release.sh` picks the product pub from `--luna` / the tag, signs
`SHA256SUMS.txt`, and **refuses to publish** if the signature does not verify
against that pub.

## Cursor secret names

Save these in Cursor (runtime / Cloud Agent secrets):

| Secret name | What to paste |
|-------------|---------------|
| `LIBRESERV_RELEASE_MINISIG_PK` | LibreServ minisign **secret** key line (starts with `RWRT…`), or the full secret-key file text |
| `LIBRESERV_RELEASE_MINISIG_PW` | Password that encrypts that LibreServ secret |
| `LSLUNA_RELEASE_MINISIG_PK` | Luna minisign **secret** key line (or full file text) |
| `LSLUNA_RELEASE_MINISIG_PW` | Password that encrypts that Luna secret |
| `FORGEJO_TOKEN` | Forgejo API token with `write:repository` / `write:release` |

Public keys are committed in git — do **not** put `.pub` contents in Cursor secrets.

## Ownership

- **Luna** owns `7AA9417DBF891F5E` (`keys/lsluna.minisign.pub`). Do not regenerate it.
- **LibreServ** owns `48EB64CB69EA36CD` (`keys/libreserv.minisign.pub`).

If the Luna secret is still at the old path `~/.minisign/libreserv.key`, rename it:

```bash
mkdir -p ~/.minisign
mv ~/.minisign/libreserv.key ~/.minisign/lsluna.key
```

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

## Recreate a public file from a secret

```bash
minisign -R -s ~/.minisign/libreserv.key -p keys/libreserv.minisign.pub
minisign -R -s ~/.minisign/lsluna.key -p keys/lsluna.minisign.pub
```

After regenerating LibreServ’s pub, copy it into
`server/backend/internal/system/releases.minisign.pub` and the heredoc in
`install.sh`.

## Verify checksums

```bash
# LibreServ release
minisign -Vm SHA256SUMS.txt -p keys/libreserv.minisign.pub

# Luna release
minisign -Vm SHA256SUMS.txt -p keys/lsluna.minisign.pub
```
