package main

import "github.com/diamondburned/gotk4/pkg/glib/v2"

// glibIdleAdd schedules fn on the GLib main loop thread.
func glibIdleAdd(fn func()) {
	glib.IdleAdd(func() bool {
		fn()
		return false
	})
}
