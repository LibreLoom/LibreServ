package main

import (
	"flag"
	"fmt"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/app"
	"os"
)

func cmdServeDev(args []string) int {
	fs := flag.NewFlagSet("serve-dev", flag.ContinueOnError)
	port := fs.Int("port", 8099, "port to listen on")
	host := fs.String("host", "", "address to listen on and put in the feed URLs (default 127.0.0.1, this machine only; use your LAN address, or 0.0.0.0, to let other machines in)")
	dist := fs.String("dist", "", "build root to serve (default <repo>/dist)")
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, "Usage: release serve-dev [--port N] [--host ADDR] [--dist DIR]")
		fmt.Fprintln(os.Stderr, "Serves dist/ and a feed per unit and channel signed with the local TEST key, so a dev box can update from this laptop.")
		fs.PrintDefaults()
	}
	if _, err := parseInterspersed(fs, args); err != nil {
		if err == flag.ErrHelp {
			return 0
		}
		return 2
	}
	a, err := newApp(appOpts{outRoot: absOut(*dist)})
	if err != nil {
		return fail("serve-dev", err)
	}
	srv, err := a.StartDev(devOpts(*port, *host, *dist))
	if err != nil {
		return fail("serve-dev", err)
	}
	fmt.Printf("Serving %s on %s (listening on %s)\n", a.OutRoot(), srv.URL, srv.Listening)
	fmt.Printf("Feeds:      %s/feeds/<unit>/<stable|beta>.json  (signed with the test key %s)\n", srv.URL, srv.Key.ID)
	fmt.Printf("Test key:   %s\n", srv.Key.PublicLine())
	fmt.Printf("Index:      %s/index.json\n\n", srv.URL)
	fmt.Println("Point a receiver at it:")
	fmt.Printf("  Luna (lunad): set LUNA_UPDATES_FEED=%s  (and LUNA_UPDATES_CHANNEL=stable|beta),\n", srv.FeedBase)
	fmt.Println("                or in Luna: Settings -> Updates -> Update source -> Edit update source:")
	fmt.Printf("                feed address %s, and add the test key above under signing keys.\n", srv.FeedBase)
	fmt.Printf("  Sol:          LIBRESERV_UPDATES_FEED_URL=%s/sol sets the feed, but Sol only trusts its built-in\n", srv.FeedBase)
	fmt.Println("                key (no runtime override), so a dev Sol must be built with the test key.")
	fmt.Println("  Desktop, Android: feed address and key are compiled in; they cannot be pointed at it.")
	fmt.Println("\nCtrl-C to stop.")
	ctx, stop := signalContext()
	defer stop()
	if err := srv.Wait(ctx); err != nil {
		return fail("serve-dev", err)
	}
	return 0
}

func devOpts(port int, host, dist string) app.DevServeOptions {
	return app.DevServeOptions{Addr: fmt.Sprintf(":%d", port), Host: host, Dist: absOut(dist)}
}
