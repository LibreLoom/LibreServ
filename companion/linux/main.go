package main

import (
	_ "embed"
	"os"
	"os/exec"

	"github.com/diamondburned/gotk4-adwaita/pkg/adw"
	"github.com/diamondburned/gotk4/pkg/gdk/v4"
	"github.com/diamondburned/gotk4/pkg/gdkpixbuf/v2"
	"github.com/diamondburned/gotk4/pkg/gio/v2"
	"github.com/diamondburned/gotk4/pkg/gtk/v4"
)

//go:embed logo.svg
var logoSVG []byte

func main() {
	app := adw.NewApplication("net.plainskill.libreserv.companion", gio.ApplicationFlagsNone)
	app.Connect("activate", func() { onActivate(app) })

	if os.Getenv("LIBRESERV_SETUP_CODE") != "" {
		app.SetFlags(app.Flags() | gio.ApplicationNonUnique)
	}

	app.Run(os.Args)
}

func onActivate(app *adw.Application) {
	window := adw.NewApplicationWindow(&app.Application)
	window.SetTitle("LibreServ")
	window.SetDefaultSize(420, 600)

	logoPaintable := loadLogo()
	ble := newBLEClient()

	connectView := newConnectView(ble, logoPaintable, func(proxyAddr string) {
		url := "http://" + proxyAddr
		openBrowser(url)
		window.Close()
	})

	window.SetContent(connectView)
	window.SetVisible(true)
}

func loadLogo() *gtk.Picture {
	loader := gdkpixbuf.NewPixbufLoader()
	loader.Write(logoSVG)
	loader.Close()
	pixbuf := loader.Pixbuf()
	texture := gdk.NewTextureForPixbuf(pixbuf)
	pic := gtk.NewPictureForPaintable(texture)
	pic.SetSizeRequest(96, 96)
	pic.SetContentFit(gtk.ContentFitScaleDown)
	pic.SetCanShrink(true)
	return pic
}

func openBrowser(url string) error {
	cmd := exec.Command("xdg-open", url)
	return cmd.Start()
}
