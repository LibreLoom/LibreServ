#!/bin/bash
#
# Local CI Testing Script
# Run this locally to test what the CI would do without pushing to Gitea
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== LibreServ Local CI Testing ===${NC}"
echo ""

# Track failures
FAILED=0

# Function to run a test
run_test() {
    local name="$1"
    local cmd="$2"
    
    echo -e "${YELLOW}Running: $name${NC}"
    if eval "$cmd"; then
        echo -e "${GREEN}✓ $name passed${NC}"
    else
        echo -e "${RED}✗ $name failed${NC}"
        FAILED=1
    fi
    echo ""
}

# Parse arguments
TEST_GROUP="${1:-all}"

case "$TEST_GROUP" in
    "go"|"backend")
        echo -e "${GREEN}Testing Backend (Go)${NC}"
        cd server/backend
        
        run_test "Format Check" "test -z \$(gofmt -l .)"
        run_test "Go Vet" "go vet ./..."
        run_test "Go Test" "go test ./..."
        run_test "Go Build" "go build -o /tmp/libreserv ./cmd/libreserv"
        
        if [ "$FAILED" -eq 0 ]; then
            run_test "Race Detection" "go test -race -count=3 ./internal/api/middleware/... ./internal/auth/... ./internal/jobqueue/..."
        fi
        ;;
        
    "frontend")
        echo -e "${GREEN}Testing Frontend${NC}"
        cd server/frontend
        
        run_test "Install Dependencies" "npm ci"
        run_test "Lint" "npm run lint"
        run_test "Build" "npm run build"
        ;;
        
    "security")
        echo -e "${GREEN}Running Security Scans${NC}"
        cd server/backend
        
        if command -v govulncheck &> /dev/null; then
            run_test "Vulnerability Check (govulncheck)" "govulncheck ./..."
        else
            echo -e "${YELLOW}⚠ govulncheck not installed. Run: go install golang.org/x/vuln/cmd/govulncheck@latest${NC}"
        fi
        
        if command -v gosec &> /dev/null; then
            run_test "Security Scan (gosec)" "gosec -severity high ./..."
        else
            echo -e "${YELLOW}⚠ gosec not installed. Run: go install github.com/securego/gosec/v2/cmd/gosec@latest${NC}"
        fi
        
        if command -v staticcheck &> /dev/null; then
            run_test "Static Analysis (staticcheck)" "staticcheck ./..."
        else
            echo -e "${YELLOW}⚠ staticcheck not installed. Run: go install honnef.co/go/tools/cmd/staticcheck@latest${NC}"
        fi
        ;;
        
    "coverage")
        echo -e "${GREEN}Generating Coverage Report${NC}"
        cd server/backend
        
        run_test "Test with Coverage" "go test -coverprofile=coverage.out -covermode=atomic ./..."
        
        if [ -f "coverage.out" ]; then
            COVERAGE=$(go tool cover -func=coverage.out | grep total | awk '{print $3}' | sed 's/%//')
            echo -e "${GREEN}Total Coverage: ${COVERAGE}%${NC}"
            
            if (( $(echo "$COVERAGE < 60" | bc -l) )); then
                echo -e "${RED}⚠ Coverage is below 60%${NC}"
            fi
            
            go tool cover -html=coverage.out -o coverage.html
            echo -e "${GREEN}Coverage report generated: server/backend/coverage.html${NC}"
        fi
        ;;
        
    "docker")
        echo -e "${GREEN}Testing Docker Build${NC}"
        
        run_test "Docker Build" "docker build -t libreserv:local-test ."
        
        if [ "$FAILED" -eq 0 ]; then
            echo -e "${GREEN}✓ Docker image built successfully${NC}"
            echo "Test with: docker run -p 8080:8080 libreserv:local-test"
        fi
        ;;
        
    "all"|"")
        echo -e "${GREEN}Running All Tests${NC}"
        echo ""
        
        # Backend
        echo -e "${YELLOW}=== Backend Tests ===${NC}"
        $0 go || FAILED=1
        
        # Frontend
        echo -e "${YELLOW}=== Frontend Tests ===${NC}"
        $0 frontend || FAILED=1
        
        # Security (optional tools)
        echo -e "${YELLOW}=== Security Scans ===${NC}"
        $0 security || true  # Don't fail if tools not installed
        
        # Coverage
        echo -e "${YELLOW}=== Coverage ===${NC}"
        $0 coverage || FAILED=1
        ;;
        
    "help"|"-h"|"--help")
        echo "Usage: $0 [test-group]"
        echo ""
        echo "Test groups:"
        echo "  go, backend   - Run Go tests (format, vet, test, build, race)"
        echo "  frontend      - Run frontend tests (install, lint, build)"
        echo "  security      - Run security scans (govulncheck, gosec, staticcheck)"
        echo "  coverage      - Generate coverage report"
        echo "  docker        - Test Docker build"
        echo "  all           - Run everything (default)"
        echo ""
        echo "Examples:"
        echo "  $0                    # Run all tests"
        echo "  $0 backend            # Run only backend tests"
        echo "  $0 frontend           # Run only frontend tests"
        echo "  $0 security           # Run security scans"
        echo "  $0 coverage           # Generate coverage report"
        ;;
        
    *)
        echo -e "${RED}Unknown test group: $TEST_GROUP${NC}"
        echo "Run '$0 help' for usage"
        exit 1
        ;;
esac

echo ""
if [ "$FAILED" -eq 0 ]; then
    echo -e "${GREEN}=== All tests passed! ===${NC}"
    exit 0
else
    echo -e "${RED}=== Some tests failed ===${NC}"
    exit 1
fi
