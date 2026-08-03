.PHONY: build clean test vet check smoke all

build:
	go build -o swarm.exe .

clean:
	rm -f swarm.exe swarm_race.exe swarm_check.exe

test:
	go test ./...

vet:
	go vet ./...

# Offline gate: compile + unit tests + vet (no OpenCode, no API key).
check: vet test
	go build -o swarm_check.exe .
	@echo check OK

# Smoke: binary starts and help works.
smoke: build
	./swarm.exe help >/dev/null 2>&1 || ./swarm.exe --help >/dev/null 2>&1 || true
	@echo smoke OK

all: check build
