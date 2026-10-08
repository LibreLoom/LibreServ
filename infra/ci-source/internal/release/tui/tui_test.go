package tui

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/secrets"
)

// show prints the view when TUI_SHOW is set (the plain screenshots in the report).
func show(t *testing.T, name, v string) {
	if os.Getenv("TUI_SHOW") != "" {
		fmt.Printf("\n===== %s =====\n%s\n", name, v)
	}
}

func TestHomeShowsUnitsFeedsAndUnfinished(t *testing.T) {
	h := newHarness(t)
	h.start()
	v := h.wantView("LibreServ release", "main · fe58182 · clean", "sol", "0.9.2", "14 commits", "0.4.1-beta.2",
		"Unfinished cuts", "luna 0.4.1-beta.3 (beta) stopped before upload", "Secrets", "2/4 ready", "Podman", "5.6.1 rootless", "system keyring")
	show(t, "home", v)
	if !strings.Contains(v, "b build") {
		t.Fatal("actions missing")
	}
}

func TestVaultAskedOnceAtStart(t *testing.T) {
	h := newHarness(t)
	h.be.store.mode, h.be.store.exists, h.be.store.pass = secrets.ModeVault, true, "correct"
	h.start()
	h.wantView("Unlock the vault", "Passphrase")
	// Secrets are not checked while locked.
	h.typ("wrong")
	h.key("enter")
	h.wantView("That passphrase is wrong")
	h.typ("correct")
	h.key("enter")
	v := h.wantView("LibreServ release", "2/4 ready", "passphrase vault, unlocked")
	if strings.Contains(v, "Unlock the vault") {
		t.Fatal("still asking")
	}
}

func TestVaultCreateAsksTwice(t *testing.T) {
	h := newHarness(t)
	h.be.store.mode = secrets.ModeVault
	h.start()
	h.wantView("Create the vault", "Once more")
	h.typ("abc")
	h.key("tab")
	h.typ("abd")
	h.key("enter")
	h.wantView("two passphrases differ")
	h.typ("abc")
	h.key("tab")
	h.typ("abc")
	h.key("enter")
	h.wantView("LibreServ release")
	if !h.be.store.unlocked {
		t.Fatal("vault not created")
	}
}

func TestPrompterInlineFlow(t *testing.T) {
	h := newHarness(t)
	h.start()
	allow := h.br.AllowAsk()
	got := make(chan secrets.Answer, 1)
	go func() {
		a, _ := h.br.Ask(context.Background(), secrets.Question{Slot: secrets.SlotMinisignPassword, Label: "Password for ~/.minisign/lsluna.key", Secret: true, Hint: "The password you chose."})
		got <- a
	}()
	var ask tea_msg
	deadline := time.After(2 * time.Second)
	for ask == nil {
		h.mu.Lock()
		for _, m := range h.q {
			if _, ok := m.(askMsg); ok {
				ask = m
			}
		}
		h.mu.Unlock()
		select {
		case <-deadline:
			t.Fatal("no question arrived")
		case <-time.After(5 * time.Millisecond):
		}
	}
	h.pump()
	v := h.wantView("Password for ~/.minisign/lsluna.key", "[x] Remember", "enter use it")
	show(t, "inline question", v)
	h.typ(secretValue)
	v = h.wantView("•••••")
	if strings.Contains(v, "hunter") {
		t.Fatal("typed text visible")
	}
	h.key("tab")
	h.wantView("[ ] Remember")
	h.key("tab")
	h.key("enter")
	a := <-got
	if a.Value != secretValue || !a.Remember || a.Skip {
		t.Fatalf("%+v", a)
	}
	// Skipping.
	go func() {
		a, _ := h.br.Ask(context.Background(), secrets.Question{Slot: secrets.SlotForgejoToken, Label: "Forgejo token", Secret: true})
		got <- a
	}()
	time.Sleep(50 * time.Millisecond)
	h.pump()
	h.key("esc")
	if a := <-got; !a.Skip {
		t.Fatalf("%+v", a)
	}
	// The vault passphrase is never asked through the prompter, and nothing is
	// asked while asking is off.
	if _, err := h.br.Ask(context.Background(), secrets.Question{Slot: "keyring-passphrase"}); err == nil {
		t.Fatal("passphrase question must fail")
	}
	allow()
	if a, _ := h.br.Ask(context.Background(), secrets.Question{Slot: secrets.SlotForgejoToken}); !a.Skip {
		t.Fatal("must skip when asking is off")
	}
}

type tea_msg = any

func TestBuildFlow(t *testing.T) {
	h := newHarness(t)
	h.start()
	h.key("down") // luna
	h.key("b")
	v := h.wantView("Build", "[x] luna", "Which version of the code", "Ref", "HEAD")
	show(t, "build setup", v)
	h.key("down")
	h.key("down") // luna-android is third unit; move to ref
	h.key("down")
	h.key("down") // parts
	h.key("space")
	h.key("enter")
	v = h.wantView("Build luna · HEAD", "web", "rootfs", "Installing chrony", "Alpine rootfs")
	show(t, "build running", v)
	if len(h.be.builds) != 1 || h.be.builds[0].Unit != "luna" || len(h.be.builds[0].Parts) == 0 {
		t.Fatalf("%+v", h.be.builds)
	}
}

func TestBuildCtrlCAsks(t *testing.T) {
	h := newHarness(t)
	h.start()
	h.key("b")
	h.m.top().(*buildScreen).phase = bpRunning
	h.key("ctrl+c")
	h.wantView("Stop the build?", "y stop")
	h.key("n")
	if strings.Contains(h.view(), "Stop the build?") {
		t.Fatal("confirm should be gone")
	}
}

func TestCutHappyPathWithFix(t *testing.T) {
	h := newHarness(t)
	h.start()
	h.key("down") // luna
	h.key("c")
	v := h.wantView("Cut luna", "Version", "Channel", "Bump", "patch 0.4.1", "Dry run", "0.4.1 on stable")
	show(t, "cut setup", v)
	h.key("enter")
	h.wantView("Release notes", "feat(luna): faster uploads")
	h.key("ctrl+s")
	v = h.wantView("Cut luna 0.4.1", "✗ Luna release signing key", "none of the 3 known passwords opens it", "e fix this")
	show(t, "cut preflight", v)
	// Enter a password on the fix menu.
	h.key("e")
	h.wantView("Enter the key's password", "Paste the secret key")
	h.key("enter")
	h.typ(secretValue)
	h.wantView("[x] Remember")
	h.key("enter")
	v = h.wantView("Everything is ready")
	if got := h.be.sec.values; len(got) != 1 || !strings.Contains(got[0], "minisign-password:lsluna-signing remember=true") {
		t.Fatalf("%v", got)
	}
	h.key("enter")
	// The cut finished synchronously in the harness.
	v = h.wantView("Released luna 0.4.1 on stable", "luna/v0.4.1", "feeds/luna/stable.json", "1 file")
	show(t, "cut done", v)
	if len(h.be.cuts) != 1 || !strings.Contains(h.be.cuts[0].Notes, "faster uploads") || h.be.cuts[0].Bump != "patch" {
		t.Fatalf("%+v", h.be.cuts)
	}
}

func TestCutAndroidShowsVersionCode(t *testing.T) {
	h := newHarness(t)
	h.start()
	h.key("down")
	h.key("down") // luna-android
	h.key("c")
	h.wantView("Cut luna-android", "Android versionCode 40199")
	h.key("down")
	h.key("down")
	h.key("down")
	h.key("space") // dry run
	h.wantView("Dry run   [x]")
	h.key("up")
	h.key("up")
	h.key("right") // channel -> beta
	h.wantView("‹ beta ›", "[beta 0.4.1-beta.1]", "versionCode 40101")
}

func TestCutResumeFromHome(t *testing.T) {
	h := newHarness(t)
	h.start()
	h.key("down") // luna has the unfinished cut
	h.key("r")
	h.wantView("Cut luna 0.4.1-beta.3", "Release notes")
}

func TestCutCtrlCExplainsResume(t *testing.T) {
	h := newHarness(t)
	h.start()
	h.key("c")
	c := h.m.top().(*cutScreen)
	c.phase, c.cancel = cpRun, func() {}
	h.sh().run.bumpDone = true
	h.key("ctrl+c")
	v := h.wantView("Stop the cut?", "Steps already done stay done", "Resume it later from Home")
	show(t, "stop cut", v)
	h.key("y")
	if !c.stopping {
		t.Fatal("did not stop")
	}
	h.sh().run.bumpDone = false
	h.key("ctrl+c")
	h.wantView("Nothing has been pushed yet")
}

func (h *harness) sh() *shared { return h.m.sh }

func TestSecretsScreens(t *testing.T) {
	h := newHarness(t)
	h.start()
	h.key("s")
	v := h.wantView("Secrets", "Luna release signing key", "✗ failed", "✓ ready", "· missing", "remembered in: system keyring")
	show(t, "secrets", v)
	h.key("down")
	h.key("enter")
	v = h.wantView("Luna release signing key", "must match keys/lsluna.minisign.pub", "none of the 3 known passwords opens it", "matches no public key", "e enter or paste")
	show(t, "secret details", v)
	h.key("e")
	h.key("down") // paste the secret key
	h.key("enter")
	h.wantView("Paste the whole key file")
	h.typ("RW" + strings.Repeat("a", 210))
	v = h.wantView("212 characters")
	_ = v
	h.key("esc")
	h.key("esc")
	h.key("esc")
	h.wantView("Secrets")
}

func TestStoreSwitchAndPassphraseScreen(t *testing.T) {
	h := newHarness(t)
	h.start()
	h.key("s")
	h.key("s")
	v := h.wantView("Where remembered values live", "System keyring", "← in use", "Passphrase vault", "no vault yet")
	show(t, "store", v)
	h.key("down")
	h.key("enter")
	h.wantView("Vault passphrase", "Once more")
	h.typ("pw1")
	h.key("tab")
	h.typ("pw1")
	h.key("enter")
	v = h.wantView("Now using the vault", "Moved 3 values")
	if h.be.store.mode != secrets.ModeVault || h.be.store.saved != secrets.ModeVault {
		t.Fatal("not switched")
	}
	h.key("p")
	h.wantView("Current passphrase", "New passphrase")
	h.typ("pw1")
	h.key("tab")
	h.typ("pw2")
	h.key("tab")
	h.typ("pw2")
	h.key("enter")
	h.wantView("Vault passphrase changed")
	if h.be.store.pass != "pw2" {
		t.Fatal("passphrase not changed")
	}
}

func TestProtonScreen(t *testing.T) {
	h := newHarness(t)
	h.start()
	h.key("s")
	h.key("p")
	h.wantView("Proton Pass", "Read secrets from Proton Pass")
	h.key("space")
	if !h.be.sec.proton.Enabled {
		t.Fatal("not enabled")
	}
	h.key("down")
	h.key("enter")
	h.typ("pass://Release/Forgejo/token")
	h.key("enter")
	if h.be.sec.proton.Refs[secrets.SlotForgejoToken] != "pass://Release/Forgejo/token" {
		t.Fatalf("%+v", h.be.sec.proton)
	}
}

func TestProtonScreenRejectsPastedValue(t *testing.T) {
	h := newHarness(t)
	h.start()
	h.key("s")
	h.key("p")
	h.key("down")
	h.key("enter")
	h.typ("hunter2hunter2")
	h.key("enter")
	if len(h.be.sec.proton.Refs) != 0 {
		t.Fatalf("saved a non-reference: %+v", h.be.sec.proton)
	}
	if v := h.wantView("must look like pass://"); strings.Contains(v, "hunter2hunter2") {
		t.Fatal("the pasted value is still on screen")
	}
}

func TestProtonScreenTest(t *testing.T) {
	h := newHarness(t)
	h.be.sec.checks = []secrets.ProtonCheck{{Slot: secrets.SlotForgejoToken, Ref: "pass://V/I/f", Err: "proton pass: not signed in"}}
	h.start()
	h.key("s")
	h.key("p")
	h.key("t")
	h.wantView("✗ proton pass: not signed in")
}

func TestDoctorAndHelp(t *testing.T) {
	h := newHarness(t)
	h.start()
	h.key("d")
	h.wantView("Doctor", "rootless")
	h.key("esc")
	h.key("?")
	h.wantView("Help")
}

func TestTinyTerminal(t *testing.T) {
	h := newHarness(t)
	h.m.Update(tea_size(60, 14))
	h.start()
	h.view()
	h.key("c")
	h.view()
}

func TestFooterKeepsQuitAndStoreHintIsRight(t *testing.T) {
	h := newHarness(t)
	h.start()
	v := h.wantView("q quit", "change: s, then s")
	for _, l := range strings.Split(v, "\n") {
		if lw(l) > 80 {
			t.Fatalf("line wider than the screen: %q", l)
		}
	}
}

func TestWrapAndMiddleCut(t *testing.T) {
	if got := fitMid("/home/me/very/long/folder/name/file.key", 20); lw(got) > 20 || !strings.HasSuffix(got, "file.key") || !strings.Contains(got, "…") {
		t.Fatalf("fitMid = %q", got)
	}
	for _, l := range wrapText("Switching copies every remembered value to the new place, checks it, then removes the old copy.", 40) {
		if lw(l) > 40 {
			t.Fatalf("wrapped line too long: %q", l)
		}
	}
}

func TestStoppedBuildIsNotReportedAsBuilt(t *testing.T) {
	h := newHarness(t)
	h.start()
	s := newBuild(h.sh(), "luna")
	s.phase, s.err, s.started, s.ended = bpDone, fmt.Errorf("luna/lunad: %w", context.Canceled), h.sh().now(), h.sh().now()
	out := strings.Join(s.resultLines(80), "\n")
	if !strings.Contains(out, "Stopped") || strings.Contains(out, "Built") {
		t.Fatalf("result: %s", out)
	}
}
