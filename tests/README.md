# Aegis Test Suite

This document describes how to run the aegis test suite.

## Test Layers

The test suite is organized into four layers, with native semantic variants for
the two supported sandbox kernels:

| Layer | Description | Where to Run |
|-------|-------------|--------------|
| Layer 1 | Unit tests (pure transforms) | Local |
| Layer 2 | CLI dry-run integration tests | Local |
| Layer 3 | Bwrap semantic tests | Docker only |
| Layer 3m | Seatbelt semantic tests that execute `sandbox-exec` | Native macOS |
| Layer 4 | E2E tests with real CLIs | Docker only |

## Quick Start

```bash
# Run the default local suite (L1/L2 plus the guarded L3m probe)
bun run test

# Run all tests (L1/L2 locally, L3m natively, L3/L4 in Docker)
bun run scripts/test.ts all

# Run only Docker tests (L3 + L4)
bun run scripts/test.ts docker

# Run native macOS kernel-enforcement tests
bun run test:layer3m
```

**Developing on macOS:** most of `tests/integration` asserts the bwrap argv and
therefore skips on a non-Linux host, so a green local run says nothing about
changes to the Linux backend. `bun run test:local-linux` re-runs the same L1/L2
suite inside the container CI uses, which is the cheapest way to find out before
pushing rather than after. It is part of `scripts/test.ts all`, and skips itself
on a Linux host, where the plain `local` run already covers it.

**Note:** Use `bun run test` (not `bun test`) to run the configured local suite. It includes L1/L2 and L3m; L3m records visible skips when native Seatbelt execution is unavailable. Direct `bun test` will attempt to run all test files including Docker-only tests.

## Running Tests

### Local Tests (L1/L2, plus guarded L3m)

These tests are safe to run locally and don't require Docker or special privileges.

```bash
# Run L1/L2 and probe L3m (which skips when Seatbelt is unavailable)
bun run test

# Run only unit tests
bun run test:unit

# Run only dry-run integration tests
bun run test:integration
```

Individual test files:
```bash
# Unit tests (L1)
bun test tests/unit/osRelease.test.ts      # OS release parsing
bun test tests/unit/argvNormalization.test.ts  # YOLO flag handling
bun test tests/unit/config.test.ts         # Config management
bun test tests/unit/paths.test.ts          # Path resolution
bun test tests/unit/bwrapArgs.test.ts      # Bwrap argv builder

# Integration tests (L2)
bun test tests/integration/dryRun.test.ts           # CLI dry-run behavior
bun test tests/integration/sandboxExecDryRun.test.ts # Seatbelt profile dry runs
bun test tests/integration/configPersistence.test.ts  # CLI flags not persisted
bun test tests/integration/metaCommands.test.ts     # init/tools meta-commands
```

### Native macOS Tests (L3m)

Layer 3m executes `sandbox-exec`; it does not merely inspect the generated SBPL
string. Run it from a plain macOS terminal:

```bash
bun run test:layer3m
```

If the process is already inside Seatbelt, a nested profile cannot widen access
denied by the outer profile. The suite probes an allow-default profile first,
prints a loud explanation, and records visible skips rather than reporting fake
kernel coverage. The usual symptom is:

```
sandbox-exec: sandbox_apply: Operation not permitted
```

The process exits 71. The confirmed nested-sandbox signature is that a profile
rule naming a **nonexistent** path applies successfully, while the same kind of
rule naming an **existing** path fails. Leave the assertions and
`sandbox-exec` execution intact; rerun from a plain terminal.

### Docker Tests (L3/L4)

Layer 3 and Layer 4 tests **must run inside Docker**. They have a Docker guard that prevents accidental execution outside of containers.

```bash
# Run L3 bwrap semantic tests
bun run scripts/test.ts layer3

# Run L4 e2e tests with real CLIs
bun run scripts/test.ts layer4

# Run both L3 and L4
bun run scripts/test.ts docker

# Run all tests with detailed output
bun run scripts/test.ts --logs all
```

**Note:** If you try to run L3/L4 tests directly outside Docker, you'll get an error:
```
Layer 3 (bwrap semantic) tests must run inside Docker.
Use 'bun run scripts/test.ts' or run directly in Docker container.
```

#### Host requirement: unprivileged user namespaces

bwrap needs unprivileged user namespaces, and `--privileged` on the container is
not sufficient — the restriction lives in the kernel running the Docker daemon.
Ubuntu 24.04+ and Debian 13+ ship an AppArmor policy that denies them, which
includes the VM images used by colima, Lima, and Rancher Desktop. Every L3 test
fails identically when this bites:

```
bwrap: setting up uid map: Permission denied
```

Check and relax it inside the VM (colima shown; `lima shell` for Lima):

```bash
colima ssh -- sysctl -n kernel.apparmor_restrict_unprivileged_userns   # 1 = will fail
colima ssh -- sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

`sysctl -w` does not persist, so this has to be redone after the VM restarts. On
a Linux host running Docker natively, apply the same sysctl to the host. If
*every* L3 test fails rather than a specific few, check this before assuming a
regression.

## Unified Test Runner

The `scripts/test.ts` script orchestrates all test layers:

```bash
bun run scripts/test.ts [options] [layers...]
```

### Options

| Option | Description |
|--------|-------------|
| `--logs` | Show detailed test output (including failures) |
| `--help`, `-h` | Show help |

### Layers

| Layer | Description |
|-------|-------------|
| `local` | Run L1/L2 tests locally (default) |
| `local-linux` | Run L1/L2 on Linux in Docker (skipped on a Linux host) |
| `layer3` | Run L3 bwrap semantic tests in Docker |
| `layer3m` | Run L3m sandbox-exec semantic tests natively |
| `layer4` | Run L4 e2e tests in Docker |
| `docker` | Run L3 + L4 in Docker |
| `all` | Run all layers (local + local-linux + L3m + docker) |

### Examples

```bash
bun run scripts/test.ts              # Run L1/L2 locally
bun run scripts/test.ts all          # Run all tests
bun run scripts/test.ts --logs all   # Run all with detailed output
bun run scripts/test.ts layer3       # Run only L3 in Docker
bun run scripts/test.ts layer3m      # Run only L3m natively
bun run scripts/test.ts docker       # Run L3 + L4 in Docker
bun run scripts/test.ts local-linux  # Re-run L1/L2 on Linux before pushing
```

## NPM Scripts

For convenience, common test commands are available as npm scripts:

```bash
bun run test           # Run L1/L2 plus the guarded L3m probe
bun run test:unit      # Run only unit tests
bun run test:integration # Run local integration tests
bun run test:all       # Run all layers
bun run test:docker    # Run L3 + L4 in Docker
bun run test:local-linux # Re-run L1/L2 on Linux in Docker
bun run test:layer3    # Run L3 in Docker
bun run test:layer3m   # Run L3m natively on macOS
bun run test:layer4    # Run L4 in Docker
```

## Manual Docker Commands

If you need to run Docker containers manually:

```bash
# Build and run Layer 3 (requires --privileged for bwrap)
docker build -f tests/docker/Dockerfile.layer3 -t aegis-layer3-tests .
docker run --rm --privileged aegis-layer3-tests

# Build and run Layer 4 (installs all CLIs, requires --privileged)
docker build -f tests/docker/Dockerfile.layer4 -t aegis-layer4-tests .
docker run --rm --privileged aegis-layer4-tests
```

**Note:** Layer 4 builds may take several minutes on first run as it installs all CLI tools from npm.

## Supported CLI Tools (Layer 4)

| Tool | NPM Package | Binary Name |
|------|-------------|-------------|
| Claude Code | `@anthropic-ai/claude-code` | `claude` |
| Codex (OpenAI) | `openai-codex-cli` | `codex` |
| Gemini CLI | `@google/generative-ai-cli` | `gemini` |
| Auggie (Augment CLI) | `augment-cli` | `augment` |
| OpenCode | `opencode-ai` | `opencode` |
| Crush | `@charmbracelet/crush` | `crush` |

## Test Structure

```
tests/
├── unit/                      # Layer 1: Unit tests
│   ├── osRelease.test.ts
│   ├── argvNormalization.test.ts
│   ├── config.test.ts
│   ├── paths.test.ts
│   └── bwrapArgs.test.ts
├── integration/               # Layer 2 + semantic integration tests
│   ├── dryRun.test.ts         # L2: CLI dry-run tests (local)
│   ├── configPersistence.test.ts  # L2: Config persistence tests (local)
│   ├── bwrapSemantic.test.ts  # L3: Real bwrap tests (Docker only)
│   └── seatbeltSemantic.test.ts # L3m: Real sandbox-exec tests (macOS)
├── e2e/                       # Layer 4: End-to-end tests (Docker only)
│   └── dockerSmoke.test.ts
├── fixtures/                  # Test fixtures
│   ├── bin-tools/             # Fake CLI binaries (claude, codex, gemini, etc.)
│   │   ├── claude             # ls-based fake CLI for visibility tests
│   │   ├── codex              # Fake codex CLI
│   │   ├── gemini             # Fake gemini CLI
│   │   ├── augment            # Fake augment CLI (for aegis "auggie")
│   │   ├── opencode           # Fake opencode CLI
│   │   └── crush              # Fake crush CLI
│   ├── bin-bwrap/             # Fake bwrap sentinel (separate to avoid PATH shadowing)
│   │   └── bwrap              # Sentinel script for dry-run tests
│   └── projects/
│       └── sample/
├── utils/                     # Test utilities
│   ├── dockerGuard.ts         # Docker environment detection
│   ├── seatbeltGuard.ts       # Native Seatbelt capability probe
│   └── semanticOutput.ts      # Shared behavioral fixture parser
├── docker/                    # Docker configuration
│   ├── Dockerfile             # Layer 1+2 runner
│   ├── Dockerfile.layer3      # Layer 3 runner
│   └── Dockerfile.layer4      # Layer 4 runner
└── README.md                  # This file
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `AEGIS_TEST_PROJECT_DIR` | Project directory for `--hide` flag tests (set by Dockerfile.layer3) |
| `XDG_CONFIG_HOME` | Override config directory (used in tests) |
| `HOME` | Override home directory (used in tests) |

## Writing Tests

### Conventions

- Tests use `bun:test` framework
- Use temp directories via `fs.mkdtemp` for isolation
- Set `XDG_CONFIG_HOME` to temp dir to avoid touching real config
- L3/L4 tests automatically guard against non-Docker execution

### Example Test

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("myFeature", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aegis-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("does something", () => {
    // Test implementation
  });
});
```

## Troubleshooting

### Bwrap tests fail with permission errors

Bubblewrap requires user namespaces. In Docker, use `--privileged` flag:
```bash
docker run --rm --privileged aegis-layer3-tests
```

On bare metal, check if user namespaces are enabled:
```bash
cat /proc/sys/kernel/unprivileged_userns_clone

# Enable if needed (requires root)
sudo sysctl -w kernel.unprivileged_userns_clone=1
```

### Tests timeout

Increase the timeout for slow tests:
```bash
bun test --timeout 60000
```

### L3/L4 tests error "must run inside Docker"

This is expected! L3/L4 tests have a Docker guard that prevents accidental execution outside containers. Use the unified test runner:
```bash
bun run scripts/test.ts layer3  # Runs L3 in Docker
bun run scripts/test.ts layer4  # Runs L4 in Docker
```
