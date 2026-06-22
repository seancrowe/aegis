/**
 * aegis - Bubblewrap-sandboxed AI CLI runner
 * Main entrypoint
 */
import { Command } from "commander";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { loadConfig, validateHidePaths, expandHidePaths, expandUserPaths } from "./config/config";
import {
  loadProjectOverrides,
  resolveOverrides,
  assertContentOverridesSupported,
} from "./config/overrides";
import { filterAegisFlags, normalizeToolArgs } from "./tools/tool";
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

async function main() {
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
  program
    .name("aegis")
    .version(pkg.version, "-V, --version")
    .enablePositionalOptions();

  for (const cliDef of config.clis) {
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
        const toolPath = Bun.which(cliDef.cliCmd) ?? cliDef.cliCmd;
        if (!options.dryRun && toolPath === cliDef.cliCmd) {
          process.stderr.write(`${cliDef.cliCmd} not found in PATH\n`);
          process.exit(1);
        }

        // 2. Effective options
        const hideHome = config.hideHomeAlways || !!options.hideHome;
        const cliHidePaths: string[] = options.hide || [];

        // 3. Validate hide paths
        // Config paths: expand ~ and silently skip non-existent (lenient)
        const home = homedir();
        const configHide = expandHidePaths(config.hide, home);
        // CLI paths: validate strictly (user just typed them, typos should error)
        const hideValidation = validateHidePaths(cliHidePaths);
        if (!hideValidation.ok) {
          process.stderr.write(hideValidation.error.message + "\n");
          process.exit(1);
        }
        const allHidePaths = [...configHide, ...cliHidePaths];

        const cliWritable: string[] = options.writable || [];
        const extraWritable = expandUserPaths(
          [...config.extraWritable, ...cliWritable], home
        );

        // 4. Get raw args from process.argv (after subcommand)
        const subIdx = process.argv.indexOf(cliDef.subCommand, 2);
        const rawArgs = subIdx >= 0 ? process.argv.slice(subIdx + 1) : _passedArgs;

        // 5. Filter and normalize
        const filtered = filterAegisFlags(rawArgs);
        const toolArgs = normalizeToolArgs(filtered, cliDef);

        // 6. Ensure host paths exist
        const hostPaths = cliDef.rwPaths.map((rp) => ({
          path: join(home, rp.path),
          kind: rp.kind,
        }));
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

        // 8. Load project overrides (.aegis.json)
        const cwd = process.cwd();
        const projResult = await loadProjectOverrides(cwd);
        if (!projResult.ok) {
          process.stderr.write(projResult.error.message + "\n");
          process.exit(1);
        }
        const projectEntries = projResult.value ?? [];
        const configCwdOverrides = config.cwdOverrides;

        // 8b. Reject content-substitution overrides on backends that can't honor them.
        const overrideCheck = assertContentOverridesSupported(backend, [
          { label: "config.json cwdOverrides", entries: configCwdOverrides },
          { label: ".aegis.json", entries: projectEntries },
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
          toolArgs,
          hideHome,
          hidePaths: allHidePaths,
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
