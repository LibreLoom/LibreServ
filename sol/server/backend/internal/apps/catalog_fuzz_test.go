package apps

import (
	"testing"

	"gopkg.in/yaml.v3"
)

// FuzzAppDefinitionUnmarshal fuzz tests App Catalog YAML parsing
// This tests the unmarshaling used in loadAppDefinition
func FuzzAppDefinitionUnmarshal(f *testing.F) {
	// Seed corpus with valid app definitions
	f.Add([]byte(`
id: test-app
name: Test App
description: A test application
category: productivity
deployment:
  image: nginx:latest
  port: 80
`))
	f.Add([]byte(`
id: complex-app
name: Complex Application
description: |
  Multi-line description
  with special characters: <>&"'
category: development
deployment:
  compose_file: docker-compose.yml
  environment:
    - DEBUG=true
    - API_KEY=secret
  volumes:
    - data:/data
health_check:
  http:
    url: http://localhost:8080/health
    method: GET
    expected_status: 200
updates:
  strategy: manual
`))
	f.Add([]byte(`
id: minimal
name: Minimal
description: Test
`))
	f.Add([]byte(`
# Invalid - missing required fields
id: partial-app
`))
	f.Add([]byte(`
id: special-chars
name: "App with \"quotes\" and 'apostrophes'"
description: "Test <script>alert('xss')</script>"
`))
	f.Add([]byte(`
id: edge-case
name: ""
description: ""
deployment: {}
`))

	f.Fuzz(func(t *testing.T, data []byte) {
		var app AppDefinition

		// Test unmarshaling - should not panic
		_ = yaml.Unmarshal(data, &app)

		// Try to validate if unmarshaling succeeded
		// This mimics the validateAppDefinition logic
		if app.Name != "" {
			// App has a name, check other fields
			_ = app.ID
			_ = app.Description
			_ = app.Category
		}
	})
}

// FuzzScriptActionUnmarshal fuzz tests script action parsing
func FuzzScriptActionUnmarshal(f *testing.F) {
	f.Add([]byte(`
name: install
label: Install
script: |
  echo "Installing..."
`))
	f.Add([]byte(`
name: backup
label: Backup Application
script: backup.sh
icon: backup
confirm:
  enabled: true
  message: Are you sure?
options:
  - name: target
    label: Backup Target
    type: string
    required: true
`))
	f.Add([]byte(`
name: minimal
label: Minimal
script: echo "done"
execution:
  timeout: 60
  stream_output: true
`))
	f.Add([]byte(`invalid yaml content`))
	f.Add([]byte(`name: test`))

	f.Fuzz(func(t *testing.T, data []byte) {
		var action ScriptAction
		_ = yaml.Unmarshal(data, &action)

		// Access fields to ensure no panic
		_ = action.Name
		_ = action.Label
		_ = action.Script
		_ = action.Icon
	})
}
