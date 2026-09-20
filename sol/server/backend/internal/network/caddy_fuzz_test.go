package network

import (
	"bytes"
	"strings"
	"testing"
	"text/template"
)

// FuzzCaddyfileTemplate fuzz tests the Caddyfile template generation
// This tests that the template doesn't panic with various inputs
func FuzzCaddyfileTemplate(f *testing.F) {
	// Seed corpus with various inputs
	f.Add("", false, "", "", "", "example.com", "localhost:8080", false, "", "")
	f.Add("admin@example.com", true, "file", "json", "INFO", "app.example.com", "10.0.0.1:3000", true, "/certs/cert.pem", "/certs/key.pem")
	f.Add("test@test.com", false, "", "", "", "<script>alert('xss')</script>", "backend:80", false, "", "")
	f.Add("user@domain.org", true, "stdout", "console", "DEBUG", "test.local", "127.0.0.1:9000", true, "", "")
	f.Add("", true, "", "", "", "", "", false, "", "")
	f.Add("a@b.c", true, "file", "json", "ERROR", "very.long.domain.name.example.com", "192.168.1.1:8080", true, "cert.pem", "key.pem")

	f.Fuzz(func(t *testing.T, email string, autoHTTPS bool, logOutput, logFormat, logLevel, domain, backend string, ssl bool, tlsCert, tlsKey string) {
		// Create template data
		data := struct {
			Email          string
			AutoHTTPS      bool
			HasRealDomains bool
			LogOutput      string
			LogFormat      string
			LogLevel       string
			Routes         []routeView
		}{
			Email:          email,
			AutoHTTPS:      autoHTTPS,
			HasRealDomains: domain != "" && domain != "localhost" && !strings.HasPrefix(domain, "127."),
			LogOutput:      logOutput,
			LogFormat:      logFormat,
			LogLevel:       logLevel,
			Routes: []routeView{
				{
					ID:         "test-route",
					FullDomain: domain,
					Backend:    backend,
					SSL:        ssl,
					Enabled:    true,
					TLSCert:    tlsCert,
					TLSKey:     tlsKey,
				},
			},
		}

		// Test template parsing and execution
		tmpl := `# LibreServ Caddyfile
{
	{{if .Email}}email {{.Email}}{{end}}
	{{if not .AutoHTTPS}}auto_https off{{end}}
}

{{if and .AutoHTTPS .HasRealDomains}}
http:// {
	redir https://{host}{uri} 308
}
{{end}}

{{range .Routes}}
{{if .Enabled}}
{{.FullDomain}} {
	reverse_proxy {{.Backend}}
	{{if .SSL}}
	{{if .TLSCert}}
	tls {{.TLSCert}} {{.TLSKey}}
	{{else if $.AutoHTTPS}}
	tls {
		on_demand
	}
	{{end}}
	{{end}}

	header {
		X-Content-Type-Options nosniff
		X-Frame-Options DENY
		Referrer-Policy strict-origin-when-cross-origin
	}

	{{if $.LogOutput}}log {
		output {{$.LogOutput}}
		{{if $.LogFormat}}format {{$.LogFormat}}{{end}}
		{{if $.LogLevel}}level {{$.LogLevel}}{{end}}
	}{{end}}
}
{{end}}
{{end}}
`

		template, err := template.New("caddyfile").Parse(tmpl)
		if err != nil {
			t.Fatalf("template parsing failed: %v", err)
		}

		var buf bytes.Buffer
		// Execution should never panic
		_ = template.Execute(&buf, data)
	})
}

// FuzzRouteViewDomain fuzz tests route domain validation
func FuzzRouteViewDomain(f *testing.F) {
	f.Add("example.com")
	f.Add("sub.domain.example.com")
	f.Add("localhost")
	f.Add("127.0.0.1")
	f.Add("::1")
	f.Add("192.168.1.1")
	f.Add("")
	f.Add("<script>alert('xss')</script>")
	f.Add("test..domain.com")
	f.Add("-invalid.com")
	f.Add("very-long-domain-name-that-might-cause-issues-if-not-handled.example.com")

	f.Fuzz(func(t *testing.T, domain string) {
		// Test the hasRealDomain logic
		_ = hasRealDomain([]routeView{
			{FullDomain: domain},
		})

		// Test IP regex
		_ = ipRegex.MatchString(domain)
	})
}

// FuzzBackendURL fuzz tests backend URL handling
func FuzzBackendURL(f *testing.F) {
	f.Add("localhost:8080")
	f.Add("10.0.0.1:3000")
	f.Add("unix:/var/run/app.sock")
	f.Add("http://backend:80")
	f.Add("https://secure:443")
	f.Add("")
	f.Add("invalid:999999")
	f.Add("::1:8080")

	f.Fuzz(func(t *testing.T, backend string) {
		// Create route view with backend
		rv := routeView{
			ID:         "test",
			FullDomain: "test.com",
			Backend:    backend,
			Enabled:    true,
		}

		// Test template execution with this backend
		tmpl := `{{.FullDomain}} {
	reverse_proxy {{.Backend}}
}`

		template, err := template.New("test").Parse(tmpl)
		if err != nil {
			t.Fatalf("template parsing failed: %v", err)
		}

		var buf bytes.Buffer
		_ = template.Execute(&buf, rv)
	})
}
