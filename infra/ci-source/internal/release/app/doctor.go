package app

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"syscall"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/engine"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/secrets"
)

// MinFreeGB is the free space under which doctor warns.
const MinFreeGB = 20

// DoctorCheck is one line of the doctor report (State is a Check* constant).
type DoctorCheck struct {
	Name   string `json:"name"`
	State  string `json:"state"`
	Detail string `json:"detail"`
}

// DoctorSection groups checks under a title.
type DoctorSection struct {
	Title  string        `json:"title"`
	Checks []DoctorCheck `json:"checks"`
}

// DoctorReport is the result of Doctor.
type DoctorReport struct {
	Sections []DoctorSection `json:"sections"`
	// PodmanOK is false when podman itself failed (nothing else was checked).
	PodmanOK bool `json:"podman_ok"`

	// Summary values for one-line displays.
	PodmanVersion   string   `json:"podman_version,omitempty"`
	Rootless        bool     `json:"rootless"`
	FreeGB          float64  `json:"free_gb,omitempty"`
	ImagesCurrent   int      `json:"images_current"`
	ImagesTotal     int      `json:"images_total"`
	SecretsProven   int      `json:"secrets_proven"`
	SecretsTotal    int      `json:"secrets_total"`
	SecretsProblems []string `json:"secrets_problems,omitempty"`
}

// Failed reports whether any check failed.
func (r *DoctorReport) Failed() bool { return r.has(CheckFail) }

// Warned reports whether any check warned.
func (r *DoctorReport) Warned() bool { return r.has(CheckWarn) }

func (r *DoctorReport) has(state string) bool {
	for _, s := range r.Sections {
		for _, c := range s.Checks {
			if c.State == state {
				return true
			}
		}
	}
	return false
}

func (r *DoctorReport) add(title, state, name, detail string) {
	for i := range r.Sections {
		if r.Sections[i].Title == title {
			r.Sections[i].Checks = append(r.Sections[i].Checks, DoctorCheck{name, state, detail})
			return
		}
	}
	r.Sections = append(r.Sections, DoctorSection{Title: title, Checks: []DoctorCheck{{name, state, detail}}})
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

// Doctor checks podman (rootless, storage), caches, toolchain images and
// secrets. With includeSecrets=false the secrets are not proven (no prompts,
// no network).
func (a *App) Doctor(ctx context.Context, includeSecrets bool) *DoctorReport {
	r := &DoctorReport{}
	e := a.eng
	const pod, caches, imgs, sec = "Podman", "Caches", "Images", "Secrets"

	out, err := e.PodmanOutput(ctx, "info", "--format", "json")
	var info podmanInfo
	if err == nil {
		err = json.Unmarshal([]byte(out), &info)
	}
	if err != nil {
		r.add(pod, CheckFail, "podman", err.Error())
	} else {
		r.PodmanOK = true
		r.PodmanVersion = info.Version.Version
		r.add(pod, CheckOK, "podman", "version "+info.Version.Version+" ("+info.Host.Arch+")")
		if os.Geteuid() == 0 {
			r.add(pod, CheckFail, "not root", "running as root; the release tool must run as a normal user")
		} else {
			r.add(pod, CheckOK, "not root", fmt.Sprintf("uid %d", os.Geteuid()))
		}
		r.Rootless = info.Host.Security.Rootless
		if r.Rootless {
			r.add(pod, CheckOK, "rootless", "podman is running rootless")
		} else {
			r.add(pod, CheckFail, "rootless", "podman is not rootless; releases never use rootful podman")
		}
		var st syscall.Statfs_t
		if err := syscall.Statfs(info.Store.GraphRoot, &st); err != nil {
			r.add(pod, CheckWarn, "storage", info.Store.GraphRoot+": "+err.Error())
		} else {
			r.FreeGB = float64(st.Bavail) * float64(st.Bsize) / (1 << 30)
			detail := fmt.Sprintf("%s, %.0f GB free", info.Store.GraphRoot, r.FreeGB)
			if r.FreeGB < MinFreeGB {
				r.add(pod, CheckWarn, "storage", detail+fmt.Sprintf(" (under %d GB; builds may run out of space)", MinFreeGB))
			} else {
				r.add(pod, CheckOK, "storage", detail)
			}
		}
		a.doctorCaches(ctx, r, caches)
		a.doctorImages(ctx, r, imgs)
	}
	if includeSecrets {
		for _, s := range a.sec.List(ctx) {
			r.SecretsTotal++
			if s.State == secrets.Proven {
				r.SecretsProven++
				r.add(sec, CheckOK, s.Label, s.Summary)
			} else {
				r.SecretsProblems = append(r.SecretsProblems, s.Label)
				r.add(sec, CheckWarn, s.Label, string(s.State)+": "+s.Summary)
			}
		}
	}
	return r
}

func (a *App) doctorCaches(ctx context.Context, r *DoctorReport, title string) {
	e := a.eng
	out, err := e.PodmanOutput(ctx, "volume", "ls", "--format", "{{.Name}}", "--filter", "name="+engine.VolumePrefix)
	if err != nil {
		r.add(title, CheckWarn, "volumes", err.Error())
	} else {
		var names []string
		for _, n := range strings.Fields(out) {
			if strings.HasPrefix(n, engine.VolumePrefix) {
				names = append(names, strings.TrimPrefix(n, engine.VolumePrefix))
			}
		}
		if len(names) == 0 {
			r.add(title, CheckOK, "volumes", "none yet (created on first build)")
		} else {
			r.add(title, CheckOK, "volumes", fmt.Sprintf("%d cache volumes: %s", len(names), strings.Join(names, ", ")))
		}
	}
	if err := os.MkdirAll(e.CacheDir(), 0o755); err != nil {
		r.add(title, CheckFail, "source cache", err.Error())
		return
	}
	r.add(title, CheckOK, "source cache", e.CacheDir())
}

func (a *App) doctorImages(ctx context.Context, r *DoctorReport, title string) {
	e := a.eng
	imgs, err := e.ListImages()
	if err != nil {
		r.add(title, CheckFail, "images", err.Error())
		return
	}
	current := map[string]bool{}
	for _, img := range imgs {
		current[img.Ref()] = true
		r.ImagesTotal++
		if e.ImageExists(ctx, img.Ref()) {
			r.ImagesCurrent++
			r.add(title, CheckOK, img.Name, "up to date ("+img.Hash+")")
		} else {
			r.add(title, CheckWarn, img.Name, "not built yet ("+img.Hash+"); `release images` builds it")
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
		r.add(title, CheckWarn, "stale images", fmt.Sprintf("%d old tags can be removed with `podman rmi`: %s", len(stale), strings.Join(stale, " ")))
	}
}
