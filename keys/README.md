# Release signing keys

`releases.minisign.pub` is the public key baked into lunad, LibreServ, and
`install.sh`. Anyone can see it. It proves a `SHA256SUMS.txt` file came from us.

The matching **secret** is never in git. It lives at `~/.minisign/libreserv.key`
(password-protected). `release.sh` uses `MINISIGN_SECRET_KEY` if set, otherwise
that file. The secret you sign with **must** match this public key or boxes will
refuse the update.

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
