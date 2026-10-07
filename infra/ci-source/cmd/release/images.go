package main

import (
	"flag"
	"fmt"
	"os"
	"strings"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/engine"
)

func cmdImages(args []string) int {
	fs := flag.NewFlagSet("images", flag.ExitOnError)
	pull := fs.Bool("pull", false, "refresh base images and rebuild every image")
	rebuild := fs.Bool("rebuild", false, "rebuild every image without layer cache")
	statusOnly := fs.Bool("status", false, "only show status, build nothing")
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, "Usage: release images [--status] [--pull] [--rebuild] [name...]")
		fs.PrintDefaults()
	}
	fs.Parse(args)

	e, err := newEngine()
	if err != nil {
		fmt.Fprintln(os.Stderr, "release images:", err)
		return 1
	}
	imgs, err := e.ListImages()
	if err != nil {
		fmt.Fprintln(os.Stderr, "release images:", err)
		return 1
	}
	if names := fs.Args(); len(names) > 0 {
		want := map[string]bool{}
		for _, n := range names {
			want[n] = true
		}
		var sel []engine.Image
		for _, img := range imgs {
			if want[img.Name] {
				sel = append(sel, img)
				delete(want, img.Name)
			}
		}
		for n := range want {
			fmt.Fprintf(os.Stderr, "release images: no image %q in %s\n", n, e.Config().ImagesDir)
			return 2
		}
		imgs = sel
	}

	ctx, stop := signalContext()
	defer stop()
	opts := engine.BuildOpts{Pull: *pull, NoCache: *rebuild}
	failed := false
	for _, img := range imgs {
		present := e.ImageExists(ctx, img.Ref())
		if !*statusOnly && (!present || opts.Pull || opts.NoCache) {
			_, err := e.EnsureImage(ctx, img.Name, opts, func(l string) { fmt.Printf("  [%s] %s\n", img.Name, l) })
			if err != nil {
				fmt.Fprintf(os.Stderr, "release images: %v\n", err)
				failed = true
				continue
			}
			present = true
		}
		state := "missing (built on first use)"
		if present {
			state = "ready"
		}
		extra := ""
		if len(img.RunOpts) > 0 {
			extra = "  [" + strings.Join(img.RunOpts, " ") + "]"
		}
		fmt.Printf("%-16s %s  %s%s\n", img.Name, img.Ref(), state, extra)
	}
	if failed {
		return 1
	}
	return 0
}
