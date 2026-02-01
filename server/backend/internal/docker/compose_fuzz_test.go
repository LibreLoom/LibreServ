package docker

import (
	"testing"

	"gopkg.in/yaml.v3"
)

// FuzzComposeUnmarshal fuzz tests Docker Compose file parsing
// This tests the YAML unmarshaling used in RunCustomAppSafely
func FuzzComposeUnmarshal(f *testing.F) {
	// Seed corpus with valid compose files
	f.Add([]byte(`
version: '3.8'
services:
  web:
    image: nginx:latest
    ports:
      - "80:80"
`))
	f.Add([]byte(`
services:
  app:
    image: myapp
    environment:
      - DEBUG=true
    volumes:
      - ./data:/data
`))
	f.Add([]byte(`
version: '3'
services:
  db:
    image: postgres:15
    environment:
      POSTGRES_USER: admin
      POSTGRES_PASSWORD: secret
`))
	f.Add([]byte(`
# Empty compose file
services: {}
`))
	f.Add([]byte(`
services:
  web:
    image: nginx
    cap_drop:
      - ALL
    read_only: true
    security_opt:
      - no-new-privileges:true
`))
	f.Add([]byte(`invalid yaml content: [`))
	f.Add([]byte(`services: {malformed`))

	f.Fuzz(func(t *testing.T, data []byte) {
		// Test the same unmarshaling logic used in RunCustomAppSafely
		var compose map[string]interface{}

		// We expect yaml.Unmarshal to either succeed or return an error
		// Either is fine - we're testing that it doesn't panic or crash
		_ = yaml.Unmarshal(data, &compose)

		// If unmarshaling succeeded, try to access the services map
		// This mimics the security hardening logic
		if compose != nil {
			if services, ok := compose["services"].(map[string]interface{}); ok {
				for _, svc := range services {
					if s, ok := svc.(map[string]interface{}); ok {
						// These operations should not panic even with malformed input
						_ = s["cap_drop"]
						_ = s["read_only"]
						_ = s["security_opt"]
					}
				}
			}
		}
	})
}

// FuzzComposeMarshal fuzz tests Docker Compose file marshaling
// This tests the yaml.Marshal used after security hardening
func FuzzComposeMarshal(f *testing.F) {
	f.Add([]byte(`
version: '3.8'
services:
  web:
    image: nginx
`))

	f.Fuzz(func(t *testing.T, data []byte) {
		var compose map[string]interface{}
		if err := yaml.Unmarshal(data, &compose); err != nil {
			return // Skip invalid input
		}

		// Try to marshal it back - this should never panic
		_, _ = yaml.Marshal(compose)
	})
}
