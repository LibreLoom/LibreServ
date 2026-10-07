package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"syscall"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/engine"
)

type checker struct {
	failed bool
	warned bool
}

func (c *checker) ok(name, detail string) { fmt.Printf("  ok    %-18s %s\n", name, detail) }
func (c *checker) warn(name, detail string) {
	c.warned = true
	fmt.Printf("  warn  %-18s %s\n", name, detail)
}
func (c *checker) fail(name, detail string) {
	c.failed = true
	fmt.Printf("  FAIL  %-18s %s\n", name, detail)
}

const minFreeGB = 20

func cmdDoctor(args []string) int {
	fs := flag.NewFlagSet("doctor", flag.ExitOnError)
	fs.Parse(args)
	ctx, stop := signalContext()
	defer stop()

	e, err := newEngine()
	if err != nil {
		fmt.Fprintln(os.Stderr, "release doctor:", err)
		return 1
	}
	c := &checker{}
	fmt.Println("Podman")
	if !checkPodman(ctx, e, c) {
		fmt.Println("\nPodman is required; fix it and run doctor again.")
		return 1
	}
	fmt.Println("Caches")
	checkCaches(ctx, e, c)
	fmt.Println("Images")
	checkImages(ctx, e, c)
	fmt.Println("Secrets")
	if a, err := newApp(appOpts{keyring: true}); err != nil {
		c.warn("secrets", err.Error())
	} else {
		secretsSummary(ctx, a, c)
	}

	switch {
	case c.failed:
		fmt.Println("\nProblems found.")
		return 1
	case c.warned:
		fmt.Println("\nOK, with warnings.")
	default:
		fmt.Println("\nAll good.")
	}
	return 0
}

type podmanInfo struct {
	Host struct {
		Security struct {
			Rootless bool `json:"rootless"`
		} `json:"security"`
		Arch string `json:"arch"`
	} `json:"host"`
	Store struct {
		GraphRoot string `json:"graphRoot"`
	} `json:"store"`
	Version struct {
		Version string `json:"Version"`
	} `json:"version"`
}

func checkPodman(ctx context.Context, e *engine.Engine, c *checker) bool {
	out, err := e.PodmanOutput(ctx, "info", "--format", "json")
	if err != nil {
		c.fail("podman", err.Error())
		return false
	}
	var info podmanInfo
	if err := json.Unmarshal([]byte(out), &info); err != nil {
		c.fail("podman", "cannot read `podman info`: "+err.Error())
		return false
	}
	c.ok("podman", "version "+info.Version.Version+" ("+info.Host.Arch+")")
	if os.Geteuid() == 0 {
		c.fail("not root", "running as root; the release tool must run as a normal user")
	} else {
		c.ok("not root", fmt.Sprintf("uid %d", os.Geteuid()))
	}
	if info.Host.Security.Rootless {
		c.ok("rootless", "podman is running rootless")
	} else {
		c.fail("rootless", "podman is not rootless; releases never use rootful podman")
	}
	var st syscall.Statfs_t
	if err := syscall.Statfs(info.Store.GraphRoot, &st); err != nil {
		c.warn("storage", info.Store.GraphRoot+": "+err.Error())
	} else {
		freeGB := float64(st.Bavail) * float64(st.Bsize) / (1 << 30)
		detail := fmt.Sprintf("%s, %.0f GB free", info.Store.GraphRoot, freeGB)
		if freeGB < minFreeGB {
			c.warn("storage", detail+fmt.Sprintf(" (under %d GB; builds may run out of space)", minFreeGB))
		} else {
			c.ok("storage", detail)
		}
	}
	return true
}

func checkCaches(ctx context.Context, e *engine.Engine, c *checker) {
	out, err := e.PodmanOutput(ctx, "volume", "ls", "--format", "{{.Name}}", "--filter", "name="+engine.VolumePrefix)
	if err != nil {
		c.warn("volumes", err.Error())
	} else {
		var names []string
		for _, n := range strings.Fields(out) {
			if strings.HasPrefix(n, engine.VolumePrefix) {
				names = append(names, strings.TrimPrefix(n, engine.VolumePrefix))
			}
		}
		if len(names) == 0 {
			c.ok("volumes", "none yet (created on first build)")
		} else {
			c.ok("volumes", fmt.Sprintf("%d cache volumes: %s", len(names), strings.Join(names, ", ")))
		}
	}
	if err := os.MkdirAll(e.CacheDir(), 0o755); err != nil {
		c.fail("source cache", err.Error())
		return
	}
	c.ok("source cache", e.CacheDir())
}

func checkImages(ctx context.Context, e *engine.Engine, c *checker) {
	imgs, err := e.ListImages()
	if err != nil {
		c.fail("images", err.Error())
		return
	}
	current := map[string]bool{}
	for _, img := range imgs {
		current[img.Ref()] = true
		if e.ImageExists(ctx, img.Ref()) {
			c.ok(img.Name, "up to date ("+img.Hash+")")
		} else {
			c.warn(img.Name, "not built yet ("+img.Hash+"); `release images` builds it")
		}
	}
	out, err := e.PodmanOutput(ctx, "images", "--format", "{{.Repository}}:{{.Tag}}", "--filter", "reference="+engine.ImageRepo+"/*")
	if err != nil {
		return
	}
	var stale []string
	for _, ref := range strings.Fields(out) {
		if !current[ref] {
			stale = append(stale, ref)
		}
	}
	if len(stale) > 0 {
		c.warn("stale images", fmt.Sprintf("%d old tags can be removed with `podman rmi`: %s", len(stale), strings.Join(stale, " ")))
	}
}
