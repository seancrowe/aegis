import { Command, CommanderError } from "commander";
import { existsSync, realpathSync } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  getConfigPath,
  loadConfig,
  parseConfig,
  validateRwPath,
  validateToolKey,
} from "../config/config";
import { isTable, stripBom } from "../config/toml";
import {
  TOOL_CATALOG,
  renderToolTable,
  type ToolRecipe,
} from "./catalog";

interface ConfiguredTool {
  key: string;
  name: string;
  cliCmd: string;
}

interface ConfigDocument {
  content: string;
  configuredKeys: Set<string>;
  configured: ConfiguredTool[];
}

interface PendingTool {
  recipe: ToolRecipe;
  key: string;
  cliCmd: string;
  rwDirs: string[];
}

interface AddOptions {
  as?: string;
  rwPath: string[];
}

interface InitOptions {
  all?: boolean;
  yes?: boolean;
}

const CONFIG_SCHEMA = `Config schema (TOML)

Top-level keys:
  hideHomeAlways = boolean                 required
  homeAccess = "blocklist" | "allowlist"   optional (default: "blocklist")
  hide = ["path", ...]                     required
  allowRead = ["path", ...]                optional
  extraWritable = ["path", ...]            optional
  cwdOverrides = [{ target, override? }]   optional

Tool tables:
  [tools.<key>]
  name = string                            required
  cliCmd = string                          required
  yoloArg = string                         optional
  rwDirs = ["relative/path", ...]           optional
  rwFiles = ["relative/path", ...]          optional
  hide = ["path", ...]                     optional
  extraWritable = ["path", ...]            optional
  hideHomeAlways = boolean                 optional

Tool keys may contain A-Z, a-z, 0-9, dot, underscore, and hyphen; they may not
start with a hyphen or be named tools, init, or help. Writable paths must be
relative to $HOME and may not resolve to $HOME or traverse through "..".
Per-tool hide and extraWritable support ~ and ADD to their global lists; they
never replace them. Per-tool hideHomeAlways is OR'd with the global setting.

Worked example:

hideHomeAlways = false
homeAccess = "blocklist"
hide = ["~/.ssh", "~/.aws"]
allowRead = ["~/.config/git"]
extraWritable = ["~/.npm"]

[tools.claude]
name = "claude code"
cliCmd = "claude"
yoloArg = "--dangerously-skip-permissions"
rwDirs = [".claude"]
rwFiles = [".claude.json"]
hide = ["~/.kube"]
extraWritable = ["~/.cache/claude"]
hideHomeAlways = false

In allowlist mode, $HOME is masked wholesale and only the tool's own config plus
allowRead are re-exposed. hide still applies in both modes: entries under $HOME
are already covered by the mask, but entries outside it are not, so they are
always enforced, including per-tool hide. Per-tool settings are only meaningful
in blocklist mode because the allowlist masks $HOME wholesale; per-tool hide is
still applied so paths outside $HOME remain denied. CLI --hide and overrides
still win over allowRead.
allowRead grants read access only and also applies when --hide-home or
hideHomeAlways masks $HOME in blocklist mode.
`;

/**
 * The tool keys the config file actually declares.
 *
 * Must strip the BOM exactly as parseConfig does. Reading the raw bytes here
 * while the loader strips them makes the two disagree about what the file
 * contains: Bun returns `{}` for a BOM-prefixed document, so every configured
 * tool would be reported as missing and `tools add` would try to append a table
 * that is already there.
 */
function explicitToolKeys(content: string): Set<string> {
  const raw = Bun.TOML.parse(stripBom(content)) as { tools?: unknown };
  if (!isTable(raw.tools)) return new Set();
  return new Set(Object.keys(raw.tools));
}

async function readConfigDocument(): Promise<
  { ok: true; value: ConfigDocument } | { ok: false; error: Error }
> {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    try {
      const loadResult = await loadConfig();
      if (!loadResult.ok) return { ok: false, error: loadResult.error };
    } catch (error) {
      return { ok: false, error: error as Error };
    }
  }

  let content: string;
  try {
    content = await readFile(configPath, "utf-8");
  } catch (error) {
    return { ok: false, error: error as Error };
  }
  const parsed = parseConfig(content, configPath);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return {
    ok: true,
    value: {
      content,
      configuredKeys: explicitToolKeys(content),
      configured: parsed.value.tools.map((tool) => ({
        key: tool.subCommand,
        name: tool.name,
        cliCmd: tool.cliCmd,
      })),
    },
  };
}

function resolveRecipes(names: string[]):
  | { ok: true; value: ToolRecipe[] }
  | { ok: false; error: Error } {
  const recipes: ToolRecipe[] = [];
  for (const name of names) {
    const recipe =
      TOOL_CATALOG.find((entry) => entry.subCommand === name) ??
      TOOL_CATALOG.find((entry) => entry.cliCmd === name);
    if (recipe === undefined) {
      const validNames = [
        ...new Set(
          TOOL_CATALOG.flatMap((entry) => [entry.subCommand, entry.cliCmd])
        ),
      ].join(", ");
      return {
        ok: false,
        error: new Error(`Unknown tool "${name}". Valid names: ${validNames}`),
      };
    }
    recipes.push(recipe);
  }
  return { ok: true, value: recipes };
}

function prepareTools(
  names: string[],
  options: AddOptions
): { ok: true; value: PendingTool[] } | { ok: false; error: Error } {
  const recipesResult = resolveRecipes(names);
  if (!recipesResult.ok) return recipesResult;
  if (options.as !== undefined && recipesResult.value.length !== 1) {
    return {
      ok: false,
      error: new Error("--as may only be used when adding one tool"),
    };
  }
  // Applying one --rw-path to several tools would silently widen the writable
  // set for tools the user was not thinking about — a policy change disguised
  // as a convenience. Make them say which tool they mean.
  if (options.rwPath.length > 0 && recipesResult.value.length !== 1) {
    return {
      ok: false,
      error: new Error("--rw-path may only be used when adding one tool"),
    };
  }

  const rwDirs: string[] = [];
  for (const path of options.rwPath) {
    const pathResult = validateRwPath(path);
    if (!pathResult.ok) return { ok: false, error: pathResult.error };
    rwDirs.push(pathResult.value);
  }

  const pending = recipesResult.value.map((recipe) => ({
    recipe,
    key: options.as ?? recipe.subCommand,
    cliCmd: absoluteMatch(recipe) ?? recipe.cliCmd,
    rwDirs,
  }));
  for (const tool of pending) {
    const keyResult = validateToolKey(tool.key);
    if (!keyResult.ok) return { ok: false, error: keyResult.error };
  }
  return { ok: true, value: pending };
}

async function appendTools(
  pending: PendingTool[]
): Promise<{ ok: true } | { ok: false; error: Error }> {
  const configPath = getConfigPath();
  const documentResult = await readConfigDocument();
  if (!documentResult.ok) return documentResult;

  const requested = new Set<string>();
  for (const tool of pending) {
    if (
      documentResult.value.configuredKeys.has(tool.key) ||
      requested.has(tool.key)
    ) {
      return {
        ok: false,
        error: new Error(
          `${configPath}: Tool key "${tool.key}" is already configured`
        ),
      };
    }
    requested.add(tool.key);
  }

  // Concurrent writers deliberately remain last-rename-wins: this
  // single-maintainer CLI avoids a platform-specific locking dependency.
  const blocks = pending.map(renderPendingTool);
  const separator = documentResult.value.content.endsWith("\n")
    ? "\n"
    : "\n\n";
  const candidate =
    documentResult.value.content + separator + blocks.join("\n");
  let writePath = configPath;
  try {
    writePath = realpathSync(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { ok: false, error: error as Error };
    }
  }
  const dir = dirname(writePath);
  const tmp = join(
    dir,
    `.aegis-config-${process.pid}-${randomUUID()}.tmp`
  );
  let renamed = false;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, candidate, "utf-8");
    const currentMode = (await stat(writePath)).mode;
    await chmod(tmp, currentMode);

    // A successful in-memory render is not enough: only the exact bytes about
    // to replace the config are allowed to pass the authoritative loader.
    const tempContent = await readFile(tmp, "utf-8");
    const reparsed = parseConfig(tempContent, configPath);
    if (!reparsed.ok) return { ok: false, error: reparsed.error };

    await rename(tmp, writePath);
    renamed = true;
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error as Error };
  } finally {
    if (!renamed) await rm(tmp, { force: true });
  }
}

function renderPendingTool({
  recipe,
  key,
  cliCmd,
  rwDirs,
}: PendingTool): string {
  return renderToolTable({
    ...recipe,
    subCommand: key,
    cliCmd,
    rwPaths: [
      ...recipe.rwPaths,
      ...rwDirs.map((path) => ({ kind: "dir" as const, path })),
    ],
  });
}

function renderedHeader(tool: PendingTool): string {
  return renderPendingTool(tool).split("\n", 1)[0]!;
}

function printPresets(configuredKeys?: Set<string>): void {
  process.stdout.write("Tool presets:\n");
  for (const recipe of TOOL_CATALOG) {
    const configured =
      configuredKeys === undefined
        ? ""
        : configuredKeys.has(recipe.subCommand)
          ? " [configured]"
          : " [not configured]";
    process.stdout.write(
      `  ${recipe.subCommand} (${recipe.cliCmd}) — ${recipe.name}${configured}\n`
    );
  }
}

/**
 * Print the tools this install can actually run.
 *
 * Deliberately says nothing about presets beyond a one-line pointer: "what can
 * I type after `aegis`" and "what could I add" are different questions asked at
 * different times, and mixing them buried the first one. Returns true when a
 * configured cliCmd has gone stale so the caller can exit non-zero — a tool
 * table naming a binary that is no longer there is a broken config, not a note.
 */
function printConfigured(document: ConfigDocument): boolean {
  const configPath = getConfigPath();
  if (document.configured.length === 0) {
    process.stdout.write(`No tools configured in ${configPath}.\n`);
    process.stdout.write(
      "Run `aegis init` to add the agents found on your PATH, " +
        "or `aegis tools presets` to see what aegis can configure.\n"
    );
    return false;
  }

  const presetKeys = new Set(TOOL_CATALOG.map((recipe) => recipe.subCommand));
  const width = Math.max(...document.configured.map((tool) => tool.key.length));
  process.stdout.write(`Configured tools (${configPath}):\n`);
  let stale = false;
  for (const tool of document.configured) {
    // A relative cliCmd is resolved against PATH at spawn time, so its absence
    // here is not something this command can honestly report on.
    const missing = isAbsolute(tool.cliCmd) && !existsSync(tool.cliCmd);
    if (missing) stale = true;
    const note = missing
      ? "  ✗ not found"
      : presetKeys.has(tool.key)
        ? ""
        : "  (not a preset)";
    process.stdout.write(
      `  ${tool.key.padEnd(width)}  ${tool.cliCmd}${note}\n`
    );
  }

  const unconfigured = TOOL_CATALOG.filter(
    (recipe) => !document.configuredKeys.has(recipe.subCommand)
  ).length;
  if (unconfigured > 0) {
    process.stdout.write(
      `\n${unconfigured} preset${unconfigured === 1 ? "" : "s"} not configured` +
        " — run `aegis tools presets`\n"
    );
  }
  return stale;
}

function absoluteMatch(recipe: ToolRecipe): string | undefined {
  const matched = Bun.which(recipe.cliCmd);
  if (matched === null) return undefined;
  return isAbsolute(matched) ? matched : resolve(matched);
}

export async function runInit(
  options: InitOptions,
  confirm?: () => Promise<boolean>
): Promise<number> {
  const documentResult = await readConfigDocument();
  if (!documentResult.ok) {
    process.stderr.write(documentResult.error.message + "\n");
    return 1;
  }

  const proposals = TOOL_CATALOG.map((recipe) => ({
    recipe,
    path: absoluteMatch(recipe),
  })).filter(
    ({ recipe, path }) =>
      !documentResult.value.configuredKeys.has(recipe.subCommand) &&
      (options.all || path !== undefined)
  );

  if (proposals.length === 0) {
    process.stdout.write("No tools to add.\n");
    return 0;
  }

  const nonInteractivePreview =
    !options.yes && confirm === undefined && !process.stdin.isTTY;
  process.stdout.write(
    options.yes
      ? "Adding tools:\n"
      : nonInteractivePreview
        ? "Would add tools:\n"
        : "Proposed tools:\n"
  );
  for (const proposal of proposals) {
    process.stdout.write(
      `  ${proposal.recipe.subCommand} (${proposal.recipe.cliCmd}): ` +
        `${proposal.path ?? "not found on PATH"}\n`
    );
  }

  if (!options.yes) {
    if (nonInteractivePreview) {
      process.stderr.write(
        "No interactive terminal detected; rerun with --yes to add these tools.\n"
      );
      return 1;
    }
    let confirmed: boolean;
    if (confirm !== undefined) {
      confirmed = await confirm();
    } else {
      const readline = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      const answer = await readline.question("Add these tools? [y/N] ");
      readline.close();
      confirmed = /^y(?:es)?$/i.test(answer.trim());
    }
    if (!confirmed) {
      process.stdout.write("No changes made.\n");
      return 0;
    }
  }

  const pending = proposals.map(({ recipe, path }) => ({
    recipe,
    key: recipe.subCommand,
    cliCmd: path ?? recipe.cliCmd,
    rwDirs: [],
  }));
  const appendResult = await appendTools(pending);
  if (!appendResult.ok) {
    process.stderr.write(appendResult.error.message + "\n");
    return 1;
  }
  for (const tool of pending) {
    process.stdout.write(`Added ${renderedHeader(tool)}\n`);
  }
  return 0;
}

/** Returning null keeps non-repair commands on the existing startup path. */
export async function runMetaCommand(
  argv: string[]
): Promise<number | null> {
  // `tools` is a reserved tool key, so it can never be a real tool subcommand —
  // claiming the whole namespace lets `aegis tools` and `aegis tools --help`
  // print usage instead of falling through to an unknown-command error.
  const isMeta = argv[2] === "init" || argv[2] === "tools";
  if (!isMeta) return null;

  let commandCode = 0;
  const program = new Command()
    .name("aegis")
    .exitOverride();
  const tools = program.command("tools");

  tools
    .command("schema")
    .description("Print the config schema and an example")
    .action(() => {
      process.stdout.write(CONFIG_SCHEMA);
    });

  tools
    .command("list")
    .description("Show the tools this install can run")
    .action(async () => {
      const documentResult = await readConfigDocument();
      if (!documentResult.ok) {
        // Without a parseable config there is no configured set to report, and
        // guessing at one from the presets would be a lie. Say why, and point
        // at the command that still works.
        process.stderr.write(
          `Could not read ${getConfigPath()}:\n${documentResult.error.message}\n` +
            "Run `aegis tools presets` to see what aegis can configure.\n"
        );
        commandCode = 1;
        return;
      }
      if (printConfigured(documentResult.value)) commandCode = 1;
    });

  tools
    .command("presets")
    .description("Show the tools aegis ships ready-made config for")
    .action(async () => {
      const documentResult = await readConfigDocument();
      if (!documentResult.ok) {
        // The presets are compiled in, so they are still worth printing; only
        // the [configured] markers depend on a readable config.
        printPresets();
        process.stderr.write(
          `Could not read ${getConfigPath()}:\n${documentResult.error.message}\n`
        );
        commandCode = 1;
        return;
      }
      printPresets(documentResult.value.configuredKeys);
      process.stdout.write(
        "\nAdd one with `aegis tools add <name>`, " +
          "or run `aegis init` to add every preset found on your PATH.\n"
      );
    });

  tools
    .command("add")
    .description("Append preset tool tables to config.toml")
    .argument("<names...>", "preset names or executable names")
    .option("--as <name>", "override the tool table key")
    .option(
      "--rw-path <path>",
      "append a writable directory relative to home",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[]
    )
    .action(async (names: string[], options: AddOptions) => {
      const pendingResult = prepareTools(names, options);
      if (!pendingResult.ok) {
        process.stderr.write(pendingResult.error.message + "\n");
        commandCode = 1;
        return;
      }
      const appendResult = await appendTools(pendingResult.value);
      if (!appendResult.ok) {
        process.stderr.write(appendResult.error.message + "\n");
        commandCode = 1;
        return;
      }
      for (const tool of pendingResult.value) {
        process.stdout.write(`Added ${renderedHeader(tool)}\n`);
      }
    });

  program
    .command("init")
    .description("Detect installed agents and add their tool tables")
    .option("--all", "propose every catalog entry")
    .option("--yes", "add every proposal without prompting")
    .action(async (options: InitOptions) => {
      commandCode = await runInit(options);
    });

  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    throw error;
  }
  return commandCode;
}
