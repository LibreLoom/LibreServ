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
	case "windows":
		cmd = exec.Command("powershell", "-Command", fmt.Sprintf(`[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); $textNodes = $template.GetElementsByTagName("text"); $textNodes.Item(0).AppendChild($template.CreateTextNode("%s")) | Out-Null; $textNodes.Item(1).AppendChild($template.CreateTextNode("%s")) | Out-Null; $toast = [Windows.UI.Notifications.ToastNotification]::new($template); [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("CI").Show($toast)`, title, message))
	default:
		return fmt.Errorf("unsupported platform")
	}

	return cmd.Run()
}
