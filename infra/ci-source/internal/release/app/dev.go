package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/feed"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/publish"
)

// DevServeOptions configure the dev server.
type DevServeOptions struct {
	// Addr is the listen address (default ":8099").
	Addr string
	// Host is the host name or IP receivers use to reach this machine; it is
	// written into the feed URLs (default: this machine's first LAN address).
	Host string
	// Dist is the build root to serve (default the app's OutRoot).
	Dist string
}

// DevServer serves dist/ and test-key feeds.
type DevServer struct {
	// URL is what receivers use, e.g. http://192.168.1.20:8099.
	URL string
	// FeedBase is the update feed base URL for Luna (LUNA_UPDATES_FEED).
	FeedBase string
	Key      *DevKey
	srv      *http.Server
	ln       net.Listener
}

// Close stops the server.
func (d *DevServer) Close() error {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return d.srv.Shutdown(ctx)
}

// Wait blocks until the server stops.
func (d *DevServer) Wait(ctx context.Context) error {
	done := make(chan error, 1)
	go func() { done <- d.srv.Serve(d.ln) }()
	select {
	case <-ctx.Done():
		d.Close()
		return nil
	case err := <-done:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

// StartDev opens the listener and builds the handler. Call Wait to serve.
func (a *App) StartDev(opt DevServeOptions) (*DevServer, error) {
	if opt.Addr == "" {
		opt.Addr = ":8099"
	}
	if opt.Dist == "" {
		opt.Dist = a.cfg.OutRoot
	}
	key, err := a.DevKey()
	if err != nil {
		return nil, err
	}
	ln, err := net.Listen("tcp", opt.Addr)
	if err != nil {
		return nil, err
	}
	host := opt.Host
	if host == "" {
		host = lanHost()
	}
	_, port, _ := net.SplitHostPort(ln.Addr().String())
	base := "http://" + net.JoinHostPort(host, port)
	h := a.DevHandler(opt.Dist, base, key)
	return &DevServer{URL: base, FeedBase: base + "/feeds", Key: key, ln: ln,
		srv: &http.Server{Handler: h, ReadHeaderTimeout: 10 * time.Second}}, nil
}

func lanHost() string {
	addrs, _ := net.InterfaceAddrs()
	for _, ad := range addrs {
		if ipn, ok := ad.(*net.IPNet); ok && !ipn.IP.IsLoopback() && ipn.IP.To4() != nil && ipn.IP.IsPrivate() {
			return ipn.IP.String()
		}
	}
	return "127.0.0.1"
}

// DevHandler serves:
//
//	/feeds/<unit>/<channel>.json(.minisig)   feed of the newest build in dist/, signed with the test key
//	/files/<unit>/<version>/<file>           the build output
//	/index.json                              units, versions and channels served
//
// base is the public URL written into the feeds.
func (a *App) DevHandler(dist, base string, key *DevKey) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/files/", http.StripPrefix("/files/", http.FileServer(http.Dir(dist))))
	mux.HandleFunc("/feeds/", func(w http.ResponseWriter, r *http.Request) {
		rel := strings.TrimPrefix(r.URL.Path, "/feeds/")
		unit, file, ok := strings.Cut(rel, "/")
		if !ok {
			http.NotFound(w, r)
			return
		}
		name, sig := strings.CutSuffix(file, ".minisig")
		channel, isJSON := strings.CutSuffix(name, ".json")
		if !isJSON || !validChannel(channel) || strings.ContainsAny(unit, "/\\.") {
			http.NotFound(w, r)
			return
		}
		files, err := a.devFeed(r.Context(), dist, base, unit, channel, key)
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		for _, f := range files {
			if f.Path == publish.FeedPath(unit, channel)+map[bool]string{true: ".minisig", false: ""}[sig] {
				w.Header().Set("Cache-Control", "no-store")
				w.Write(f.Data)
				return
			}
		}
		http.NotFound(w, r)
	})
	mux.HandleFunc("/index.json", func(w http.ResponseWriter, r *http.Request) {
		type entry struct {
			Unit, Version string
		}
		var out []entry
		for _, u := range devUnits(dist) {
			if v, _ := newestVersion(dist, u); v != "" {
				out = append(out, entry{u, v})
			}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"public_key": key.PublicLine(), "units": out})
	})
	return mux
}

func devUnits(dist string) []string {
	ents, _ := os.ReadDir(dist)
	var out []string
	for _, e := range ents {
		if e.IsDir() {
			out = append(out, e.Name())
		}
	}
	return out
}

// newestVersion is the highest version dir of a unit that holds signed sums.
func newestVersion(dist, unit string) (string, error) {
	ents, err := os.ReadDir(filepath.Join(dist, unit))
	if err != nil {
		return "", err
	}
	var vers []string
	for _, e := range ents {
		if e.IsDir() && publish.ValidSemver(e.Name()) {
			if _, err := os.Stat(filepath.Join(dist, unit, e.Name(), publish.SumsName)); err == nil {
				vers = append(vers, e.Name())
			}
		}
	}
	if len(vers) == 0 {
		return "", fmt.Errorf("no builds of %s in %s", unit, dist)
	}
	sort.Slice(vers, func(i, j int) bool { c, _ := publish.CompareSemver(vers[i], vers[j]); return c < 0 })
	return vers[len(vers)-1], nil
}

// devFeed builds and signs the feed of unit/channel from the newest build.
func (a *App) devFeed(ctx context.Context, dist, base, unit, channel string, key *DevKey) ([]publish.FeedFile, error) {
	ver, err := newestVersion(dist, unit)
	if err != nil {
		return nil, err
	}
	dir := versionDir(dist, unit, ver)
	_, files, err := publish.Sums(dir)
	if err != nil {
		return nil, err
	}
	st, err := os.Stat(filepath.Join(dir, publish.SumsName))
	if err != nil {
		return nil, err
	}
	rel := publish.Release{Unit: unit, Version: ver, Channel: channel, Notes: "Dev build " + ver,
		Published: st.ModTime().UTC().Format(feed.TimeLayout)}
	specs := a.cfg.FeedSpecs(unit)
	if len(specs) == 0 {
		for n := range files {
			rel.Parts = append(rel.Parts, publish.PartSpec{Name: n, OS: "any", Arch: "any", File: n})
		}
		sort.Slice(rel.Parts, func(i, j int) bool { return rel.Parts[i].File < rel.Parts[j].File })
	} else {
		rel.Parts = devParts(specs, channel, files)
	}
	if unit == "luna" {
		rel.API, _ = lunaAPI(ctx, a.cfg.Repo, "HEAD")
	}
	urlFor := func(v, f string) string { return fmt.Sprintf("%s/files/%s/%s/%s", base, unit, v, f) }
	f, err := publish.BuildFeed(rel, channel, files, urlFor)
	if err != nil {
		return nil, err
	}
	return publish.SignFeeds([]publish.FeedOut{{Channel: channel, Feed: f}}, key.Signer)
}

// devParts picks the files a dev feed lists: what is present, preferring the
// channel's own file when a part has one per channel (luna-desktop).
func devParts(specs []FileSpec, channel string, files map[string]publish.FileInfo) []publish.PartSpec {
	chosen := map[string]publish.PartSpec{}
	var order []string
	for pass := 0; pass < 2; pass++ {
		for _, s := range specs {
			if _, ok := files[s.File]; !ok {
				continue
			}
			own := s.Channel == "" || s.Channel == channel
			if (pass == 0) != own {
				continue
			}
			k := s.Name + "|" + s.OS + "|" + s.Arch
			if _, done := chosen[k]; done {
				continue
			}
			p := s.PartSpec
			p.Channel = ""
			chosen[k] = p
			order = append(order, k)
		}
	}
	out := make([]publish.PartSpec, 0, len(order))
	for _, k := range order {
		out = append(out, chosen[k])
	}
	return out
}
