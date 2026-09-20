.PHONY: build run lint test fmt fmt-check vet clean frontend-build

BINARY := bin/luna-connect
MAIN := ./cmd/server

build:
	@go build -o $(BINARY) $(MAIN)

run: build
	@./$(BINARY)

test:
	@go test -v ./...

fmt:
	@gofmt -w .

fmt-check:
	@if [ -n "$$(gofmt -l .)" ]; then \
		echo "Files need formatting:"; \
		gofmt -l .; \
		exit 1; \
	fi

vet:
	@go vet ./...

lint: fmt-check vet

frontend-build:
	@cd web && npm install && npm run build

clean:
	@rm -rf bin/
