package main

import (
	"fmt"

	"github.com/diamondburned/gotk4/pkg/gtk/v4"
)

// connectView is the initial screen: logo, setup code entry, connect button, status.
type connectView struct {
	*gtk.Box

	ble         *bleClient
	logo        *gtk.Picture
	onConnected func(proxyAddr string)

	codeEntry   *gtk.Entry
	connectBtn  *gtk.Button
	statusLabel *gtk.Label
}

func newConnectView(ble *bleClient, logo *gtk.Picture, onConnected func(string)) *connectView {
	v := &connectView{
		ble:         ble,
		logo:        logo,
		onConnected: onConnected,
	}

	v.Box = gtk.NewBox(gtk.OrientationVertical, 0)
	v.SetMarginTop(48)
	v.SetMarginBottom(48)
	v.SetMarginStart(36)
	v.SetMarginEnd(36)
	v.SetVAlign(gtk.AlignCenter)
	v.SetHAlign(gtk.AlignCenter)

	// Title
	title := gtk.NewLabel("LibreServ")
	title.AddCSSClass("title-1")
	title.SetMarginBottom(4)

	// Subtitle
	subtitle := gtk.NewLabel("Connect to your LibreServ device over Bluetooth")
	subtitle.AddCSSClass("dim-label")
	subtitle.SetWrap(true)
	subtitle.SetMarginBottom(32)

	// Code entry
	v.codeEntry = gtk.NewEntry()
	v.codeEntry.SetPlaceholderText("Enter the 6-character code from your device")
	v.codeEntry.SetMaxLength(6)
	v.codeEntry.SetHAlign(gtk.AlignFill)
	v.codeEntry.SetMarginBottom(8)
	v.codeEntry.Connect("changed", v.onCodeChanged)

	// Why explanation
	whyLabel := gtk.NewLabel("This code is printed on your device. It confirms that only you can connect over Bluetooth.")
	whyLabel.AddCSSClass("dim-label")
	whyLabel.AddCSSClass("caption")
	whyLabel.SetWrap(true)
	whyLabel.SetMarginBottom(24)

	// Connect button
	v.connectBtn = gtk.NewButtonWithLabel("Connect")
	v.connectBtn.AddCSSClass("suggested-action")
	v.connectBtn.AddCSSClass("pill")
	v.connectBtn.SetHAlign(gtk.AlignCenter)
	v.connectBtn.SetSensitive(false)
	v.connectBtn.Connect("clicked", v.onConnect)

	// Status
	v.statusLabel = gtk.NewLabel("")
	v.statusLabel.SetWrap(true)
	v.statusLabel.SetMarginTop(16)

	// Layout
	v.Append(logo)
	logo.SetMarginBottom(24)
	v.Append(title)
	v.Append(subtitle)
	v.Append(v.codeEntry)
	v.Append(whyLabel)
	v.Append(v.connectBtn)
	v.Append(v.statusLabel)

	return v
}

func (v *connectView) onCodeChanged() {
	text := v.codeEntry.Text()
	v.connectBtn.SetSensitive(len(text) == 6)
}

func (v *connectView) onConnect() {
	code := v.codeEntry.Text()
	if len(code) != 6 {
		return
	}

	v.connectBtn.SetSensitive(false)
	v.codeEntry.SetSensitive(false)
	v.statusLabel.SetText("Scanning for your LibreServ device…")

	go func() {
		v.ble.connect(code, func(status connectStatus, msg string) {
			glibIdleAdd(func() {
				v.onBLEStatus(status, msg)
			})
		})
	}()
}

func (v *connectView) onBLEStatus(status connectStatus, msg string) {
	switch status {
	case statusScanning:
		v.statusLabel.SetText("Scanning for your LibreServ device…")
	case statusFound:
		v.statusLabel.SetText(fmt.Sprintf("Found %s — connecting…", msg))
	case statusConnected:
		v.statusLabel.SetText("Connected — authenticating…")
	case statusAuthed:
		v.statusLabel.SetText("Connected! Opening your LibreServ…")
		proxyAddr := v.ble.startProxy()
		v.onConnected(proxyAddr)
	case statusFailed:
		v.statusLabel.SetText(msg)
		v.connectBtn.SetSensitive(true)
		v.codeEntry.SetSensitive(true)
	case statusLost:
		v.statusLabel.SetText(msg)
		v.connectBtn.SetSensitive(true)
		v.codeEntry.SetSensitive(true)
	}
}
