# aegis

Sandboxed runner for AI CLI tools. Wraps tools like Claude Code, Codex, Gemini CLI, and others inside an OS sandbox so they can only see what you allow — [bubblewrap](https://github.com/containers/bubblewrap) on Linux, `sandbox-exec` (Seatbelt) on macOS. The backend is selected automatically by platform; the same model, config, and flags apply to both.

## Why

AI coding assistants run with broad filesystem access. aegis constrains them using Linux namespaces via bubblewrap:

- The entire filesystem is mounted **read-only** by default
- The current working directory is mounted **read-write**
- Tool config/auth paths (e.g. `~/.claude`) are mounted **read-write**
- `--hide-home` replaces `$HOME` with an empty tmpfs, hiding `~/.ssh`, `~/.aws`, `~/.gnupg`, etc.
- `--hide <dir>` makes specific directories invisible inside the sandbox
- Each tool's YOLO/auto-approve flag is injected automatically

## Requirements

- [Bun](https://bun.sh) runtime
- **Linux:** [bubblewrap](https://github.com/containers/bubblewrap) installed
- **macOS:** no extra install — `sandbox-exec` ships with the OS

### macOS notes

The macOS backend enforces the same model (read-only root, writable cwd + tool config, hidden credential dirs) as a Seatbelt (SBPL) policy rather than a mount namespace. Because it's a policy engine, not a virtual filesystem, a few behaviors differ from the Linux backend:

- **File-content overrides are not supported.** A masking override (`"secrets/"`) works — the path is denied. A substitution override (`{ "target": ".env", "override": ".env.sandbox" }`) cannot be honored, because Seatbelt can deny or allow a path but not swap its contents. aegis detects these and exits with a clear error rather than silently ignoring them.
- **`--hide-home` denies reads under `$HOME`** (re-allowing tool config) instead of mounting an empty tmpfs. Hidden paths fail with "operation not permitted" rather than appearing empty — equivalent protection, slightly different semantics.
- **`/tmp` is not isolated.** Linux gets a private tmpfs `/tmp`; macOS shares the real `/tmp` (still writable).
- **No PID/IPC isolation.** macOS provides filesystem confinement only; the sandboxed tool shares the host process space.

### Installing bubblewrap (Linux)

aegis detects your distro and suggests the right command, but here are the common ones:

| Distro | Command |
|--------|---------|
| Debian/Ubuntu | `sudo apt install bubblewrap` |
| Fedora | `sudo dnf install bubblewrap` |
| Arch | `sudo pacman -S bubblewrap` |
| openSUSE | `sudo zypper install bubblewrap` |
| Alpine | `sudo apk add bubblewrap` |

## Install

```bash
bun install
```

## Usage

```
aegis <tool> [flags] [tool-args...]
```

### Supported Tools

| Tool | Name | YOLO flag (auto-injected) |
|------|------|--------------------------|
| Claude Code | `claude` | `--dangerously-skip-permissions` |
| Codex | `codex` | `--dangerously-bypass-approvals-and-sandbox` |
| Gemini CLI | `gemini` | `--yolo` |
| Crush | `crush` | `--yolo` |
| Auggie | `auggie` | *(none)* |
| OpenCode | `opencode` | *(none)* |

### Flags

| Flag | Description |
|------|-------------|
| `--dry-run` | Print the sandbox command as JSON without executing it (bwrap argv on Linux, `sandbox-exec -p <profile>` on macOS) |
| `--hide-home` | Replace `$HOME` with an empty tmpfs, preserving only the tool's config paths |
| `--hide <dir>` | Hide a specific directory inside the sandbox (repeatable, supports `--hide=<dir>`) |
| `-w, --writable <dir>` | Allow write access to a directory beyond cwd and tool config (repeatable, supports `--writable=<dir>`). CLI counterpart of the `extraWritable` config key — useful for build/compiler caches a tool writes outside the project |

Aegis flags are consumed by aegis and **not** forwarded to the wrapped tool. Everything else is passed through.

### Examples

```bash
# Run Claude in a sandbox
aegis claude "explain this codebase"

# Hide your home directory (SSH keys, AWS creds, etc.)
aegis claude --hide-home "write a test for main.ts"

# Hide specific directories
aegis gemini --hide ~/.ssh --hide ~/.aws "refactor the auth module"

# Allow write access to a build cache outside the project
aegis codex -w ~/.cargo/registry --writable ~/Library/Caches/go-build "build it"

# Preview the bwrap command without running it
aegis codex --dry-run --hide-home

# Tool flags are passed through as-is
aegis claude --hide-home --version
```

## Configuration

Config is stored at `$XDG_CONFIG_HOME/aegis/config.json` (defaults to `~/.config/aegis/config.json`). The file is parsed as **[JSON5](https://json5.org)**, so `//` and `/* */` comments and trailing commas are allowed — plain JSON still works unchanged. The same goes for per-project `.aegis.json` override files. On first run aegis writes a commented template you can edit in place.

```json5
{
  // Replace $HOME with an empty view on every run (same as --hide-home).
  "hideHomeAlways": false,
  // Directories made invisible inside the sandbox. Supports ~.
  "hide": [],
  // Extra dirs to keep writable beyond cwd + tool config. Supports ~.
  "extraWritable": [],
}
```

| Field | Type | Description |
|-------|------|-------------|
| `hideHomeAlways` | `boolean` | When `true`, always apply `--hide-home` behavior |
| `hide` | `string[]` | Directories to always hide (merged with CLI `--hide` flags) |
| `extraWritable` | `string[]` | Extra directories to keep writable beyond cwd + tool config. Supports `~`. Opt-in escape hatch for tools that write outside the project — build/compiler caches such as `~/Library/Caches`, `~/Library/Developer`, `~/.cargo`, `~/.npm`, `~/go/pkg`. **Security note:** these often live under `$HOME` and may hold credentials, so nothing here is writable unless you add it. Empty by default. |

> **When do you need `extraWritable`?** If a sandboxed tool fails with "operation not permitted" while writing *outside* your project (a compiler populating its cache, a package manager, etc.), add that directory here. Writes to cwd, the tool's own config, `/tmp`/`$TMPDIR`, and the standard device nodes (`/dev/null`, `/dev/urandom`, ptys, …) already work without configuration.

#### Common `extraWritable` paths (macOS)

Build toolchains write their caches outside the project. Copy the lines for the toolchains you use into `extraWritable` — there's no harm in listing a path you don't have (it's just an allow rule for a dir that never gets touched).

> **Security:** `extraWritable` lives under `$HOME`. Some of these dirs hold credentials, not just cache (flagged ⚠ below). Prefer the narrowest subpath that fixes your write failure — e.g. `~/.cargo/registry` instead of all of `~/.cargo` — and widen only if a write still fails.

Since `config.json` is JSON5, you can paste this block — comments and trailing commas included — straight into the file.

```json5
{
  "extraWritable": [
    // General / Apple
    "~/Library/Caches",                          // OS-wide cache (broad; prefer subdirs below)
    "~/Library/Developer/Xcode/DerivedData",     // Xcode / xcodebuild build products
    "~/Library/Developer/CoreSimulator",         // iOS Simulator
    "~/Library/Caches/org.swift.swiftpm",        // Swift Package Manager cache
    "~/.swiftpm",                                 // SwiftPM config/cache

    // Node / JS
    "~/.npm",                                     // npm cache
    "~/.bun/install/cache",                       // Bun
    "~/Library/pnpm", "~/.local/share/pnpm",      // pnpm store
    "~/.cache/node/corepack",                     // Corepack
    "~/Library/Caches/Yarn",                      // Yarn 1

    // Rust
    "~/.cargo/registry",                          // Cargo registry + build cache
    "~/.rustup",                                  // toolchains
    // "~/.cargo",                                // ⚠ whole dir also holds credentials.toml

    // Go
    "~/go/pkg/mod",                               // module cache
    "~/Library/Caches/go-build",                  // build cache

    // Python
    "~/Library/Caches/pip",                       // pip
    "~/.cache/uv",                                // uv (also ~/Library/Caches/uv)
    "~/Library/Caches/pypoetry",                  // Poetry

    // Java / Kotlin
    "~/.m2/repository",                           // Maven (⚠ ~/.m2/settings.xml holds repo passwords)
    "~/.gradle/caches",                           // Gradle (⚠ ~/.gradle/gradle.properties holds signing keys)

    // C/C++ / Bazel
    "~/.ccache",                                  // ccache
    "~/.cache/bazel"                              // Bazel
  ]
}
```

CLI flags are merged with config at runtime but **never persisted** back to config.

## How It Works

aegis selects a backend by platform (`bwrap` on Linux, `sandbox-exec` on macOS) and feeds both the same resolved options.

### Linux (bubblewrap)

aegis builds a bubblewrap command with these mount layers (in order):

1. **Read-only root** — `--ro-bind / /` makes the entire filesystem visible but read-only
2. **Device and proc** — `--dev /dev` and `--proc /proc` for basic system functionality
3. **Tmpfs for /tmp** — isolated temp directory
4. **Read-write cwd** — `--bind $CWD $CWD` so the tool can edit your project
5. **Read-write tool config** — tool-specific paths like `~/.claude`, `~/.config/opencode`
6. **Read-write extras** — (if `extraWritable`) `--bind` for each existing configured directory
7. **Hide-home overlay** — (if `--hide-home`) replaces `$HOME` with tmpfs, then re-binds tool config paths on top
8. **Hide overlays** — (if `--hide`) makes specified directories appear empty
9. **Process isolation** — `--die-with-parent` ensures the sandbox dies with aegis

(`/dev` is provided whole via `--dev /dev`, so device nodes like `/dev/null` are writable as usual on Linux.)

The tool binary is then executed inside this sandbox with `--chdir` set to the original working directory.

### macOS (sandbox-exec)

aegis emits a Seatbelt (SBPL) profile expressing the same intent as allow/deny rules, in last-match-wins order:

1. **Read-only root** — `(allow default)` then `(deny file-write*)`: everything readable, nothing writable
2. **Privilege-escalation guard** — denies exec of `sudo`/`su`/`login`/`doas`/`pkexec`
3. **Device nodes** — re-allows writes to the standard scratch devices (`/dev/null`, `/dev/zero`, `/dev/urandom`, `/dev/tty`, `/dev/fd/*`, ptys, …) that the global deny would otherwise block. Block devices (raw disks) are not included.
4. **Read-write cwd + tool config** — `(allow file-read* file-write* (subpath …))` for the cwd and paths like `~/.claude`
5. **Read-write extras** — (if `extraWritable`) an allow rule per configured directory (matched by prefix, so it works even before the dir exists)
6. **Hidden credential dirs** — `(deny file-read* file-write* (subpath …))` for `--hide` paths
7. **Hide-home** — (if `--hide-home`) `(deny file-read* (subpath $HOME))`, with tool config re-allowed afterward
8. **Tool binary carve-out** — keeps the harness binary readable/executable even under a denied subtree

The profile is passed inline via `sandbox-exec -p`, so `--dry-run` shows it verbatim. See the [macOS notes](#macos-notes) for behavioral differences.

## Project Structure

```
src/
├── main.ts              # Entrypoint
├── cli/                 # CLI argument parsing
├── config/config.ts     # Config loading, parsing, validation
├── fs/paths.ts          # Path resolution and validation
├── os/osRelease.ts      # Distro detection and install hints
├── sandbox/types.ts     # Backend-neutral sandbox options
├── sandbox/backend.ts   # Platform → backend selection (bwrap | sandbox-exec)
├── sandbox/bwrap.ts     # Linux: bwrap argument builder and executor
├── sandbox/sandboxExec.ts # macOS: SBPL profile builder and executor
├── tools/               # Per-tool specs (exe name, YOLO flag, config paths)
│   ├── tool.ts          # Shared types and arg normalization
│   ├── claude.ts
│   ├── codex.ts
│   ├── gemini.ts
│   ├── crush.ts
│   ├── auggie.ts
│   └── opencode.ts
├── ui/color.ts          # Terminal colors
└── util/envPaths.ts     # XDG path resolution
```

## Testing

Tests are organized into four layers:

| Layer | Description | Run with | Requires |
|-------|-------------|----------|----------|
| L1 | Unit tests (pure functions) | `bun run test:unit` | Nothing |
| L2 | CLI dry-run integration | `bun run test:integration` | Nothing |
| L3 | Bwrap sandbox semantics | `bun run test:layer3` | Docker |
| L4 | E2E with real CLIs | `bun run test:layer4` | Docker |

```bash
# Run L1 + L2 locally (no Docker needed)
bun run test

# Run all layers
bun run test:all

# Run Docker tests only
bun run test:docker
```

See [tests/README.md](tests/README.md) for full details.

## License

TBD
