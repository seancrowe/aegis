# aegis

Bubblewrap-sandboxed runner for AI CLI tools. Wraps tools like Claude Code, Codex, Gemini CLI, and others inside a [bubblewrap](https://github.com/containers/bubblewrap) sandbox so they can only see what you allow.

## Why

AI coding assistants run with broad filesystem access. aegis constrains them using Linux namespaces via bubblewrap:

- The entire filesystem is mounted **read-only** by default
- The current working directory is mounted **read-write**
- Tool config/auth paths (e.g. `~/.claude`) are mounted **read-write**
- `--hide-home` replaces `$HOME` with an empty tmpfs, hiding `~/.ssh`, `~/.aws`, `~/.gnupg`, etc.
- `--hide <dir>` makes specific directories invisible inside the sandbox
- Each tool's YOLO/auto-approve flag is injected automatically

## Requirements

- Linux with [bubblewrap](https://github.com/containers/bubblewrap) installed
- [Bun](https://bun.sh) runtime

### Installing bubblewrap

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
| `--dry-run` | Print the bwrap command as JSON without executing it |
| `--hide-home` | Replace `$HOME` with an empty tmpfs, preserving only the tool's config paths |
| `--hide <dir>` | Hide a specific directory inside the sandbox (repeatable, supports `--hide=<dir>`) |

Aegis flags are consumed by aegis and **not** forwarded to the wrapped tool. Everything else is passed through.

### Examples

```bash
# Run Claude in a sandbox
aegis claude "explain this codebase"

# Hide your home directory (SSH keys, AWS creds, etc.)
aegis claude --hide-home "write a test for main.ts"

# Hide specific directories
aegis gemini --hide ~/.ssh --hide ~/.aws "refactor the auth module"

# Preview the bwrap command without running it
aegis codex --dry-run --hide-home

# Tool flags are passed through as-is
aegis claude --hide-home --version
```

## Configuration

Config is stored at `$XDG_CONFIG_HOME/aegis/config.json` (defaults to `~/.config/aegis/config.json`):

```json
{
  "hideHomeAlways": false,
  "hide": []
}
```

| Field | Type | Description |
|-------|------|-------------|
| `hideHomeAlways` | `boolean` | When `true`, always apply `--hide-home` behavior |
| `hide` | `string[]` | Directories to always hide (merged with CLI `--hide` flags) |

CLI flags are merged with config at runtime but **never persisted** back to config.

## How It Works

aegis builds a bubblewrap command with these mount layers (in order):

1. **Read-only root** — `--ro-bind / /` makes the entire filesystem visible but read-only
2. **Device and proc** — `--dev /dev` and `--proc /proc` for basic system functionality
3. **Tmpfs for /tmp** — isolated temp directory
4. **Read-write cwd** — `--bind $CWD $CWD` so the tool can edit your project
5. **Read-write tool config** — tool-specific paths like `~/.claude`, `~/.config/opencode`
6. **Hide-home overlay** — (if `--hide-home`) replaces `$HOME` with tmpfs, then re-binds tool config paths on top
7. **Hide overlays** — (if `--hide`) makes specified directories appear empty
8. **Process isolation** — `--die-with-parent` ensures the sandbox dies with aegis

The tool binary is then executed inside this sandbox with `--chdir` set to the original working directory.

## Project Structure

```
src/
├── main.ts              # Entrypoint
├── cli/                 # CLI argument parsing
├── config/config.ts     # Config loading, parsing, validation
├── fs/paths.ts          # Path resolution and validation
├── os/osRelease.ts      # Distro detection and install hints
├── sandbox/bwrap.ts     # Bwrap argument builder and executor
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
