# Sol performance measurements

Sol had no performance harness while Luna has `luna/perf`. This directory holds
the Sol side: a first-load size report for the web app and Go benchmarks for
the request paths that used to do the most work per call.

## Web first load

`server/frontend/scripts/bundle-report.js` reads the built app and reports the
entry script, its modulepreloads, the CSS, and every shipped font face. A TTF
next to a WOFF2 is a fallback and is not counted. Route chunks are reported
separately as `lazy`. Font faces are an upper bound on a first load: the
browser only downloads the faces the rendered page uses.

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

## Reproducing the font files

The WOFF2 files are generated from the committed TTFs with `fonttools`. Every
codepoint in the TTF `cmap` is kept in the regular and oblique faces. The two
bold faces are not used at any weight by the design, so they cover Latin and
common symbols only.

```sh
SRC=shared/ui/fonts
UNICODES='U+0020-007E,U+00A0-00FF,U+2000-206F,U+2190-21FF,U+2200-22FF,U+2500-257F,U+2600-26FF'
for f in FreeMono FreeMonoOblique; do
  pyftsubset "$SRC/$f.ttf" --unicodes='*' --flavor=woff2 --output-file="$SRC/$f.woff2"
done
for f in FreeMonoBold FreeMonoBoldOblique; do
  pyftsubset "$SRC/$f.ttf" --unicodes="$UNICODES" --flavor=woff2 --output-file="$SRC/$f.woff2"
done
cp "$SRC"/*.woff2 sol/server/frontend/public/fonts/
```

The same `shared/ui/fonts` directory is copied into Luna's build by
`shared/ui/vite/sharedFonts.js`.
