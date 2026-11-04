# Tailscale release verification

This is a maintainer protocol, not a record of a completed live test.
Mock tests and source inspection cannot establish actual Serve/Funnel behavior.

Pending live verification:

- [ ] Serve forwarding headers and private reachability at pinned 1.104.2
- [ ] Funnel forwarding headers and reachability outside the tailnet
- [ ] Headscale HTTPS certificate and private reachability
- [ ] Real reboot restores the selected mode
- Android client: not verified, waived by the user.

Current PR209 status: the user authorized an isolated test, then paused it
because a disposable test tailnet is not available. Both unenrolled nodes and
the dummy supervisor have stopped, their identity directories were removed,
and the assigned ports were verified free. No Serve/Funnel activation or live
tailnet request occurred. Generate fresh device links only when the user asks;
do not reuse the earlier links. The live gate remains pending user availability.
There is no distinct newer official stable candidate beyond pinned 1.104.2,
so candidate-version verification is also deferred, not passed.

## Permission and isolation

Enrollment, enabling Funnel, and changing an account or node are separate from
the read-only observations below. Do not perform them until the user explicitly
approves the bounded test plan. No secret belongs in chat or this document.

The approved plan must name disposable product instances and data directories,
the test account, test clients, permitted public exposure and its duration, and
the cleanup owner. Use no production or daily-driver instance. Reserve free
ports in 19700–19719 for this thread's listeners; record each actual bound port.
Use an isolated browser profile and test credentials only. Keep the existing
published branch and version pins unchanged while this external gate is pending.

## Evidence manifest

Record the product commit, platform/architecture, test start/end times, binary
versions and SHA-256 digests, node identities, actual web ports and proxy socket paths, and each
private/public URL. Redact credentials and node keys. Record the test client's
tailnet IP and, separately, its public source IP when known. Do not assume the
Funnel client IP equals its tailnet IP.

Run the observation matrix below for both Luna and Sol at the pinned version,
then repeat it with an explicitly chosen, checksum-verified candidate version
on the disposable instances. Record the exact candidate version, not "latest."
Keep baseline and candidate artifacts separate. Do not change repository pins
merely to conduct this experiment.

## Read-only observation matrix

The operator first performs only the separately approved enrollment and UI
mode changes. The observer then makes GET requests and reads status/logs:

1. With private Serve selected, read the product status response and the
   managed CLI's `status --json` and `serve status --json`. Record exit status,
   `BackendState`, `Self.DNSName`, `Web`, `Handlers`, `Proxy`, and `AllowFunnel`.
   Verify that the product's private URL describes a configured handler targeting
   this process generation's exact private Unix socket target, and its public URL is empty.
2. From a second node on the test tailnet, GET that private URL using normal
   certificate verification, without cookies or credentials. Record HTTP status
   and a nonsecret response fingerprint matching the disposable product's local
   response. Record a separate client's inability to reach the private service
   without tailnet access. A login page alone proves reachability, not login.
3. On the disposable host only, observe the HTTP request arriving at the private Unix socket using an approved disposable instrumented listener or equivalent capture method. Send a GET
   with deliberately forged `X-Forwarded-For`, `X-Real-IP`,
   `CF-Connecting-IP`, `X-Forwarded-Host`, and `Forwarded` values from the test client. Confirm
   Serve replaces the source header with exactly one parseable IP and sets the forwarded host to the requested authority, with no client-supplied chain. Preserve only the relevant redacted header evidence;
   do not capture authenticated traffic. Compare Luna's accepted source with
   the captured single IP and the known client address where applicable.
4. After the separately approved UI Funnel confirmation, repeat status reads,
   Unix-socket header observations, and GET requests through the public URL from
   a client outside the tailnet. Verify `AllowFunnel` is true for the configured
   listener and the response belongs to the disposable product. Record any
   approval, policy, beta restriction, or service-side rejection exactly as
   observed. Never claim public reachability from local status alone.
5. After the approved operator turns web access off, repeat external GETs and
   inspect Serve status. After shutdown and cleanup, repeat the public GET and
   verify owned processes and listeners are gone. Record residual reachability,
   DNS caching, propagation delay, or uncertainty explicitly. Do not delete
   identity evidence while a listener's ownership or shutdown is uncertain.

Each version/product/mode row needs actual timestamped request and status
evidence. An unavailable test client, missing permission, or unsuccessful public
request is an unfinished or failed row, never a mocked pass. The observer must
not activate services, enroll nodes, change ACLs, or clear state to obtain a pass.

Use the exact managed binary and socket from the evidence manifest for these
read-only CLI observations. Replace the placeholders; do not use the host's
default Tailscale socket:

```sh
"<managed-cli>" version
"<managed-cli>" --socket "<disposable-socket>" status --json
"<managed-cli>" --socket "<disposable-socket>" serve status --json
```

For each approved private/public URL, make a fresh GET with no cookies, no
credentials, no redirects followed, and certificate verification enabled:

```sh
curl --silent --show-error --max-time 20 --dump-header - \
  --header 'X-Forwarded-For: 192.0.2.123, 127.0.0.1' \
  --header 'X-Real-IP: 127.0.0.1' \
  --header 'CF-Connecting-IP: 127.0.0.1' \
  --header 'Forwarded: for=127.0.0.1' \
  '<approved-disposable-url>/'
```

Record the curl exit code as well as the HTTP status. Repeat without the four
forged headers as a control. These GETs cannot establish the Unix-ingress header
value by themselves; that row still requires the separately approved passive
observation. Do not turn TLS verification off to make a request succeed.

## Version-bump checklist

- Inspect the candidate's proxy forwarding-header implementation and compare
  it with the pinned release. Source inspection supplements the live matrix.
  Luna's boundary requires exactly one valid source IP; keep failure closed
  if that assumption changes. Do not silently accept forwarded chains.
- Verify the candidate's real `serve status --json` shape and Funnel policy
  behavior against the URL parsers. Verify its FileStore format before relying
  on offline removal of `_serve/` entries, preserving node identity.
- After the live matrix passes and a version change is separately authorized,
  update `shared/scripts/tailscale-bake.sh` and `sol/install.sh` version and
  architecture-specific archive digests together, and update Sol's
  `TailscaleVersion`. Review the pinned-version comments in both backends and
  `luna/crates/lunad/src/net/tailscale_proxy.rs` against the observed behavior.
- Run only the repository CI entry point, `./ci run -profile tailscale`, in the
  coordinated shared queue. Record its real exit code and every failed check.
  Archive integrity, mock parsing, and packaging checks do not replace live
  header or public-request evidence.
- Attach the evidence manifest and completed matrix to the review record only
  with authorization. A successful cleanup and a reviewer decision must be
  recorded separately from engineering checks. Do not claim live verification merely because this checklist or its mock tests exist.

## Generation socket verification (pending)

The isolated packaging check uses a finite 64-task container limit. On the
diagnostic host, Podman 4.9.3's Docker compatibility API passed an explicit
zero PID limit into OCI ([compat handler](https://github.com/containers/podman/blob/v4.9.3/pkg/api/handlers/compat/containers_create.go),
[spec generation](https://github.com/containers/podman/blob/v4.9.3/pkg/specgenutil/specgen.go)).
The installed runc 1.5.2 used opencontainers/cgroups 0.1.0, whose
[systemd driver](https://github.com/opencontainers/cgroups/blob/v0.1.0/systemd/v2.go)
maps explicit zero to `TasksMax=1`. The owned container's scope showed
`pids.max=1` while its parent had no limit. Whether 64 tasks suffice remains
pending a successful packaging check; this does not alter shared host caps.

The supported installation starts with the Unix-generation transport. Earlier
experimental TCP-target state is not migrated. If an existing managed daemon
or its target cannot be verified, preserve its state and report uncertainty;
do not start a listener that it may still reach or report public access off.

Confirm Serve and Funnel target the current `unix:` generation path, and that a stale generation cannot reach a replacement product or a service on the previous TCP port. Check the pinned daemon's actual forwarded client address and authority, Secure cookies, CSRF, and remote setup restrictions through the Unix listener. A dead socket target does not prove the daemon or public endpoint stopped. Record unverified launch or stop state separately and do not mark remote access off until verified. Headscale HTTPS certificates and public Funnel behavior remain unverified until tested on authorized disposable services.
