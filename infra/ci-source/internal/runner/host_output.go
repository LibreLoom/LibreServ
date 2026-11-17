package runner

import (
	"bufio"
	"io"
	"os/exec"
	"strings"
)

// streamHostCommand retains the exact combined output for the result while
// delivering complete lines during execution, including a final partial line.
func streamHostCommand(cmd *exec.Cmd, emit func(string)) (string, error) {
	reader, writer := io.Pipe()
	cmd.Stdout, cmd.Stderr = writer, writer
	var output strings.Builder
	done := make(chan struct{})
	go func() {
		defer close(done)
		lines := bufio.NewReader(reader)
		for {
			line, err := lines.ReadString('\n')
			if line != "" {
				output.WriteString(line)
				emit(strings.TrimRight(line, "\r\n"))
			}
			if err != nil {
				return
			}
		}
	}()
	err := cmd.Run()
	writer.Close()
	<-done
	reader.Close()
	return output.String(), err
}
