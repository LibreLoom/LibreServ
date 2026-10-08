# Release signing keys

Sol and Luna use **separate** minisign keypairs. Same release ritual
(`./release`), different trust roots — a leaked Luna secret must not be able
to ship a trusted Sol update, and vice versa.

| Product | Public key (committed) | Secret (never in git) | Cursor / Cloud Agent secrets |
|---------|------------------------|------------------------|------------------------------|
| Sol (`v*`) | `keys/sol.minisign.pub` (`48EB64CB69EA36CD`) | `~/.minisign/sol.key` | `SOL_RELEASE_MINISIG_PK` + `SOL_RELEASE_MINISIG_PW` |
| Luna (`luna-v*`) | `keys/lsluna.minisign.pub` (`7AA9417DBF891F5E`) | `~/.minisign/lsluna.key` | `LSLUNA_RELEASE_MINISIG_PK` + `LSLUNA_RELEASE_MINISIG_PW` |

Also used for non-interactive cuts: `FORGEJO_TOKEN`.

Generic overrides for either product: `MINISIGN_SECRET_KEY` (path or key text)
and `MINISIGN_PASSPHRASE`.

`./release` picks the product pub from the unit, signs
`SHA256SUMS.txt`, and **refuses to publish** if the signature does not verify
against that pub.

## Cursor secret names

Save these in Cursor (runtime / Cloud Agent secrets):

| Secret name | What to paste |
|-------------|---------------|
| `SOL_RELEASE_MINISIG_PK` | Sol minisign **secret** key line (starts with `RWRT…`), or the full secret-key file text |
| `SOL_RELEASE_MINISIG_PW` | Password that encrypts that Sol secret |
| `LSLUNA_RELEASE_MINISIG_PK` | Luna minisign **secret** key line (or full file text) |
| `LSLUNA_RELEASE_MINISIG_PW` | Password that encrypts that Luna secret |
| `FORGEJO_TOKEN` | Forgejo API token with `write:repository` / `write:release` |

Public keys are committed in git — do **not** put `.pub` contents in Cursor secrets.

## Ownership

- **Luna** owns `7AA9417DBF891F5E` (`keys/lsluna.minisign.pub`). Do not regenerate it.
- **Sol** owns `48EB64CB69EA36CD` (`keys/sol.minisign.pub`).

If the Luna secret is still at the old path `~/.minisign/sol.key`, rename it:

```bash
mkdir -p ~/.minisign
mv ~/.minisign/sol.key ~/.minisign/lsluna.key
```

## Where the public keys are baked in

Keep these identical to the committed files:

| File | Must match |
|------|------------|
| `keys/sol.minisign.pub` | canonical Sol pub |
| `sol/server/backend/internal/system/releases.minisign.pub` | Sol embed (`go:embed`) |
| `sol/install.sh` `RELEASE_MINISIGN_PUB` heredoc | Sol installer |
| `keys/lsluna.minisign.pub` | canonical Luna pub |
| `luna/crates/lunad/src/system/updates.rs` `PINNED_PUB` | Luna embed (`include_str!`) |

A Sol unit test fails if the embed drifts from `keys/sol.minisign.pub`.

## Recreate a public file from a secret

```bash
minisign -R -s ~/.minisign/sol.key -p keys/sol.minisign.pub
minisign -R -s ~/.minisign/lsluna.key -p keys/lsluna.minisign.pub
```

After regenerating Sol’s pub, copy it into
`sol/server/backend/internal/system/releases.minisign.pub` and the heredoc in
`sol/install.sh`.

## Verify checksums

```bash
# Sol release
minisign -Vm SHA256SUMS.txt -p keys/sol.minisign.pub

# Luna release
minisign -Vm SHA256SUMS.txt -p keys/lsluna.minisign.pub
```
