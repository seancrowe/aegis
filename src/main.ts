/**
 * aegis - Bubblewrap-sandboxed AI CLI runner
 * Main entrypoint
 */
import { Command } from "commander";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { Result } from "typescript-result";
import type { AegisConfig, ConfiguredCliDef } from "./config/config";
import {
  expandHidePaths,
  expandUserPaths,
  getConfigPath,
  loadConfig,
  validateHidePaths,
  validatePolicyPath,
} from "./config/config";
import {
  resolveAndValidateHidePath,
  resolveExecChain,
} from "./fs/paths";
import {
  loadProjectOverrides,
  resolveOverrides,
  assertContentOverridesSupported,
} from "./config/overrides";
import { matchProjectBlocks, type ProjectMatch } from "./config/projects";
import {
  checkHideConflicts,
  findShadowedGrants,
} from "./config/policyChecks";
import { filterAegisFlags, normalizeToolArgs } from "./tools/tool";
import { runMetaCommand } from "./tools/metaCommands";
import {
  createEmptyOverlayDir,
  removeOverlayDir,
  cleanStaleOverlays,
  ensureHostPathsExist,
} from "./sandbox/bwrap";
import { selectBackend } from "./sandbox/backend";
import { resolveTmpPaths } from "./sandbox/sandboxExec";

interface SubCmdOpts {
  hideHome?: boolean;
  hide?: string[];
  writable?: string[];
  dryRun?: boolean;
}

interface ResolvedSandboxSettings {
  hideHome: boolean;
  hidePaths: string[];
  extraWritable: string[];
  allowRead: string[];
}

/**
 * Resolve every additive sandbox setting, including matched project blocks,
 * at the command boundary so both backends receive one flat policy rather
 * than learning config precedence.
 */
function resolveSandboxSettings(
  config: AegisConfig,
  cliDef: ConfiguredCliDef,
  options: SubCmdOpts,
  home: string,
  cwd: string,
  projects: ProjectMatch[]
): Result<ResolvedSandboxSettings, Error> {
  // Global hide stays lenient for backward compatibility; per-tool hide is
  // strict because this is new surface with no legacy typos to preserve.
  const configHide = expandHidePaths(config.hide, home);
  const toolHide = expandUserPaths(cliDef.hide ?? [], home);
  for (let i = 0; i < toolHide.length; i++) {
    const validation = validateHidePaths([toolHide[i]!]);
    if (!validation.ok) {
      return Result.error(
        new Error(
          `${getConfigPath()}: Invalid hide path ${JSON.stringify(cliDef.hide![i])} ` +
            `in tool "${cliDef.subCommand}": ${validation.error.message}`
        )
      );
    }
  }

  const projectHide: string[] = [];
  for (const { block } of projects) {
    const expanded = expandUserPaths(block.hide, home);
    for (let i = 0; i < expanded.length; i++) {
      const validation = validateHidePaths([expanded[i]!]);
      if (!validation.ok) {
        return Result.error(
          new Error(
            `${getConfigPath()}: Invalid hide path ${JSON.stringify(block.hide[i])} ` +
              `in project "${block.key}": ${validation.error.message}`
          )
        );
      }
      projectHide.push(expanded[i]!);
    }
  }

  const cliHide: string[] = [];
  for (const path of options.hide ?? []) {
    const resolved = resolveAndValidateHidePath(path, cwd);
    if (!resolved.ok) return Result.error(resolved.error);
    cliHide.push(resolved.value);
  }

  for (const path of options.writable ?? []) {
    const validation = validatePolicyPath(path, "writable");
    if (!validation.ok) return Result.error(validation.error);
  }

  // Per-tool and project hides can only add; only allowRead subtracts.
  return Result.ok({
    hideHome:
      config.homeAccess === "allowlist" ||
      config.hideHomeAlways ||
      !!cliDef.hideHomeAlways ||
      !!options.hideHome ||
      projects.some((p) => p.block.hideHomeAlways),
    hidePaths: [...configHide, ...toolHide, ...projectHide, ...cliHide],
    extraWritable: expandUserPaths(
      [
        ...config.extraWritable,
        ...(cliDef.extraWritable ?? []),
        ...projects.flatMap((p) => p.block.extraWritable),
        ...(options.writable ?? []),
      ],
      home
    ),
    // Match extraWritable's lenient expansion convention: Seatbelt rules
    // remain useful before a path exists, while bwrap skips missing bind
    // sources because it cannot bind them safely.
    allowRead: expandUserPaths(
      [
        ...config.allowRead,
        ...projects.flatMap((p) => p.block.allowRead),
      ],
      home
    ),
  });
}

async function main() {
  const metaCode = await runMetaCommand(process.argv);
  if (metaCode !== null) process.exit(metaCode);

  // Select the sandbox backend for this platform (bwrap on Linux, sandbox-exec on macOS).
  const backendResult = selectBackend();
  if (!backendResult.ok) {
    process.stderr.write(backendResult.error.message + "\n");
    process.exit(1);
  }
  const backend = backendResult.value;

  // Clean up stale overlay dirs from previous crashed/killed runs (bwrap only).
  if (backend.needsEmptyDir) {
    cleanStaleOverlays();
  }

  const configResult = await loadConfig();
  if (!configResult.ok) {
    process.stderr.write(configResult.error.message + "\n");
    process.exit(1);
  }
  const config = configResult.value;

  const pkg = await import("../package.json");

  const program = new Command();
  const noToolsGuidance =
    `No tools configured in ${getConfigPath()}.\n` +
    "Run `aegis init` to detect installed agents, or " +
    "`aegis tools add claude`.\n";
  program
    .name("aegis")
    .version(pkg.version, "-V, --version")
    .enablePositionalOptions()
    .addHelpText(
      "after",
      `
Sandbox flags (pass after the tool, e.g. \`aegis <tool> --hide-home\`):
  --hide-home              Replace $HOME with an empty view
  --hide <path>            Hide a specific directory (repeatable)
  -w, --writable <path>    Allow write access to a directory (repeatable)
  --dry-run                Print the sandbox command as JSON without executing

Run \`aegis <tool> --help\` for the full per-tool flag list.`
    );

  if (config.tools.length === 0) {
    program.addHelpText("after", `\n${noToolsGuidance.trimEnd()}`);
    const firstArg = process.argv[2];
    if (firstArg === undefined) {
      process.stdout.write(noToolsGuidance);
      return;
    }
    if (!["-h", "--help", "-V", "--version"].includes(firstArg)) {
      process.stderr.write(noToolsGuidance);
      process.exit(1);
    }
  }

  for (const cliDef of config.tools) {
    program
      .command(cliDef.subCommand)
      .allowUnknownOption(true)
      .option("--hide-home", "Hide home directory")
      .option(
        "--hide <path>",
        "Hide specific directories",
        (val: string, acc: string[]) => [...acc, val],
        [] as string[]
      )
      .option(
        "-w, --writable <path>",
        "Allow write access to additional directories",
        (val: string, acc: string[]) => [...acc, val],
        [] as string[]
      )
      .option("--dry-run", "Print the sandbox command as JSON without executing")
      .argument("[args...]", "Arguments to pass to the tool")
      .action(async (_passedArgs: string[], options: SubCmdOpts) => {
        // 1. Resolve tool path (skip for dry-run since nothing is executed)
        const resolvedToolPath = Bun.which(cliDef.cliCmd);
        const toolPath = resolvedToolPath ?? cliDef.cliCmd;
        if (!options.dryRun && resolvedToolPath === null) {
          process.stderr.write(`${cliDef.cliCmd} not found in PATH\n`);
          process.exit(1);
        }

        // 2. Effective options
        const home = homedir();
        const cwd = process.cwd();
        const projectMatch = matchProjectBlocks(config.projects, cwd, home);
        // Applied in BOTH modes. Allowlist masks $HOME wholesale, which makes
        // global and per-tool hide entries *under* home redundant — but entries
        // OUTSIDE home are not covered by the mask. Applying both lists in
        // allowlist mode prevents the stricter-sounding mode from silently
        // loosening an explicit deny.
        const settingsResult = resolveSandboxSettings(
          config,
          cliDef,
          options,
          home,
          cwd,
          projectMatch.matched
        );
        if (!settingsResult.ok) {
          process.stderr.write(settingsResult.error.message + "\n");
          process.exit(1);
        }
        const {
          hideHome,
          hidePaths: allHidePaths,
          extraWritable,
          allowRead,
        } = settingsResult.value;

        // 3. Policy conflict checks — run on the merged hide list, so they
        //    also catch a global, per-tool or CLI hide that would otherwise
        //    produce a silently broken sandbox.
        const hostPaths = cliDef.rwPaths.map((rp) => ({
          path: join(home, rp.path),
          kind: rp.kind,
        }));

        const hideConflict = checkHideConflicts(
          allHidePaths,
          cwd,
          hostPaths,
          cliDef.subCommand
        );
        if (!hideConflict.ok) {
          process.stderr.write(hideConflict.error.message + "\n");
          process.exit(1);
        }

        const shadowedGrants = findShadowedGrants(allHidePaths, [
          ...extraWritable.map((path) => ({
            label: "extraWritable" as const,
            path,
          })),
          ...allowRead.map((path) => ({ label: "allowRead" as const, path })),
        ]);
        for (const grant of shadowedGrants) {
          process.stderr.write(
            `aegis: warning: ${grant.label} path "${grant.path}" is inside ` +
              `hidden path "${grant.hide}" and has no effect\n`
          );
        }

        // A mistyped project key never matches, so its hides silently never
        // apply. Warn on every run, not just --dry-run, since that is fail-open.
        for (const block of projectMatch.missing) {
          process.stderr.write(
            `aegis: warning: project "${block.key}" does not exist on disk and never matches\n`
          );
        }

        // 4. Get raw args from process.argv (after subcommand)
        const subIdx = process.argv.indexOf(cliDef.subCommand, 2);
        const rawArgs = subIdx >= 0 ? process.argv.slice(subIdx + 1) : _passedArgs;

        // 5. Filter and normalize
        const filtered = filterAegisFlags(rawArgs);
        const toolArgs = normalizeToolArgs(filtered, cliDef);

        // 6. Ensure tool config paths exist on the host
        const ensureResult = await ensureHostPathsExist(hostPaths);
        if (!ensureResult.ok) {
          process.stderr.write(ensureResult.error.message + "\n");
          process.exit(1);
        }

        // 7. Enumerate home directory entries for RO re-binds (bwrap only).
        const homeEntries = backend.needsHomeEntries
          ? readdirSync(home, { withFileTypes: true })
              .filter(e => e.isFile() || e.isDirectory() || e.isSymbolicLink())
              .map(e => e.name)
              .sort()
          : [];

        // 7b. Temp dirs to keep writable (sandbox-exec only; bwrap uses a
        //     private tmpfs and ignores this).
        const tmpPaths = backend.needsTmpPaths ? resolveTmpPaths() : [];

        // 8. Load project overrides (.aegis.toml)
        const projResult = await loadProjectOverrides(cwd);
        if (!projResult.ok) {
          process.stderr.write(projResult.error.message + "\n");
          process.exit(1);
        }
        const projectEntries = projResult.value ?? [];
        const configCwdOverrides = config.cwdOverrides;

        // 8b. Reject content-substitution overrides on backends that can't honor them.
        const overrideCheck = assertContentOverridesSupported(backend, [
          { label: "config.toml cwdOverrides", entries: configCwdOverrides },
          { label: ".aegis.toml", entries: projectEntries },
        ]);
        if (!overrideCheck.ok) {
          process.stderr.write(overrideCheck.error.message + "\n");
          process.exit(1);
        }

        // 9. Create empty overlay dir if needed + register cleanup (bwrap only).
        let emptyDir = "";
        const needsEmptyDir =
          backend.needsEmptyDir &&
          (allHidePaths.length > 0 ||
            configCwdOverrides.length > 0 ||
            projectEntries.length > 0);
        if (needsEmptyDir) {
          emptyDir = await createEmptyOverlayDir();
          process.on("exit", () => removeOverlayDir(emptyDir));
          for (const sig of ["SIGINT", "SIGTERM"] as const) {
            process.on(sig, () => process.exit(128 + (sig === "SIGINT" ? 2 : 15)));
          }
        }

        // 10. Resolve CWD overrides
        const resolvedCwdOverrides = resolveOverrides(
          configCwdOverrides, cwd, home, emptyDir
        );
        const resolvedProjectOverrides = resolveOverrides(
          projectEntries, cwd, home, emptyDir
        );

        // 11. Build sandbox options
        const sandboxOpts = {
          cwd,
          home,
          cliDef,
          toolPath,
          toolChain: resolveExecChain(toolPath),
          toolArgs,
          hideHome,
          hidePaths: allHidePaths,
          allowRead,
          extraWritable,
          emptyDir,
          homeEntries,
          cwdOverrides: resolvedCwdOverrides,
          projectOverrides: resolvedProjectOverrides,
          tmpPaths,
        };

        // 12. Build command once, then dry-run or execute
        const cmdResult = backend.buildCommand(sandboxOpts);
        if (!cmdResult.ok) {
          process.stderr.write(cmdResult.error.message + "\n");
          process.exit(1);
        }

        if (options.dryRun) {
          if (config.projects.length === 0) {
            process.stderr.write("aegis: project policy: none configured\n");
          } else if (projectMatch.matched.length === 0) {
            process.stderr.write(
              `aegis: project policy: no [projects.*] block matches ${cwd}\n`
            );
          } else {
            const matchedBlocks = projectMatch.matched
              .map(({ block }) => `[projects."${block.key}"]`)
              .join(", ");
            process.stderr.write(
              `aegis: project policy: matched ${matchedBlocks}\n`
            );
          }
          console.log(JSON.stringify(cmdResult.value));
          process.exit(0);
        }

        const execResult = await backend.execute(cmdResult.value);
        if (!execResult.ok) {
          process.stderr.write(execResult.error.message + "\n");
          process.exit(1);
        }
        process.exit(execResult.value);
      });
  }

  await program.parseAsync(process.argv);
}

main();
