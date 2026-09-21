package notify

import (
	"fmt"
	"os/exec"
	"runtime"
)

func Send(title, message string) error {
	var cmd *exec.Cmd

	switch runtime.GOOS {
	case "linux":
		cmd = exec.Command("notify-send", title, message)
	case "darwin":
		cmd = exec.Command("osascript", "-e", fmt.Sprintf(`display notification "%s" with title "%s"`, message, title))
	default:
		return fmt.Errorf("unsupported platform")
	}

	return cmd.Run()
}
