# Release signing keys

`releases.minisign.pub` is the public key baked into lunad, LibreServ, and
`install.sh`. Anyone can see it. It proves a `SHA256SUMS.txt` file came from us.

The matching **secret** is never in git. It lives at `~/.minisign/libreserv.key`
(password-protected). `release.sh` uses, in order:

1. `MINISIGN_SECRET_KEY` — path to a key file, or the raw key / full key file text
2. `LSLUNA_RELEASE_MINISIG_PK` — raw secret key line (Cloud Agent secret); pair with
   `LSLUNA_RELEASE_MINISIG_PW` for the password
3. `~/.minisign/libreserv.key`

`MINISIGN_PASSPHRASE` also works instead of `LSLUNA_RELEASE_MINISIG_PW`.

## Recreate the public file from the secret

```bash
distrobox enter dev -- minisign -R \
  -s ~/.minisign/libreserv.key \
  -p keys/releases.minisign.pub
```

Then copy `keys/releases.minisign.pub` into
`server/backend/internal/system/releases.minisign.pub` and the heredoc in
`install.sh` so all three stay identical.

## Verify an ISO or checksums file

```bash
minisign -Vm SHA256SUMS.txt -p keys/releases.minisign.pub
```
