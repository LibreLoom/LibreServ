# Sol performance measurements

Sol had no performance harness while Luna has `luna/perf`. This directory holds
the Sol side: a first-load size report for the web app and Go benchmarks for
the request paths that used to do the most work per call.

## Web first load

`server/frontend/scripts/bundle-report.js` reads the built app and reports the
bytes a first load downloads: the entry script, its modulepreloads, the CSS,
and the font faces that are actually fetched. A TTF next to a WOFF2 is a
fallback and is not counted. Route chunks are reported separately as `lazy`.

```sh
cd sol/server/frontend
npm ci
npm run build
npm run perf:bundle
```

`SOL_BUNDLE_REPORT=1 npm run build` writes the same report as part of the
build. Results land in `perf/results/` (gitignored); `bundle-latest.json` is
the most recent one.

## Backend hot paths

Two benchmarks cover the changes to per-request work. Both are standard Go
benchmarks, so `-benchtime` and `-count` work as usual.

```sh
cd sol/server/backend
go test -run '^$' -bench 'Benchmark(HealthCheck|IntegrityCheck)' ./internal/database
go test -run '^$' -bench 'BenchmarkIsComplete' ./internal/setup
```

`HealthCheck` is the cheap liveness query used by every probe.
`IntegrityCheck` is the full page walk it used to be; the benchmark shows what
a probe no longer pays. `IsComplete` shows the cached path against a forced
cache miss.

The browser journey budgets for both products live in `luna/perf/budgets.json`.
