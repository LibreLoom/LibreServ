package runner

import (
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/tests"
)

func TestIsNpmTestMatchesNonNodeImages(t *testing.T) {
	e2e := &tests.Test{Container: "mcr.microsoft.com/playwright:v1.64.1-noble", Command: "npm run test:e2e:recovery"}
	if !isNpmTest(e2e) {
		t.Fatal("the Playwright e2e test runs npm but said it does not")
	}
	unit := &tests.Test{Container: "node:26-alpine", Command: "npm test -- --run"}
	if !isNpmTest(unit) {
		t.Fatal("a node-image npm test said it does not run npm")
	}
	goTest := &tests.Test{Container: "golang:1.27-alpine", Command: "go test ./..."}
	if isNpmTest(goTest) {
		t.Fatal("a go test said it runs npm")
	}
}
