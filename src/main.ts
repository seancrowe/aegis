/**
 * aegis - Bubblewrap-sandboxed AI CLI runner
 * Main entrypoint
 */
import { Command } from "commander";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig, validateHidePaths, expandHidePaths } from "./config/config";
import { filterAegisFlags, normalizeToolArgs } from "./tools/tool";
import {
  buildBwrapCommand,
  executeBwrap,
  createEmptyOverlayDir,
  removeOverlayDir,
  cleanStaleOverlays,
  ensureHostPathsExist,
} from "./sandbox/bwrap";

interface SubCmdOpts {
  hideHome?: boolean;
  hide?: string[];
  dryRun?: boolean;
}

async function main() {
  // Clean up stale overlay dirs from previous crashed/killed runs
  cleanStaleOverlays();

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
      .option("--dry-run", "Print bwrap command as JSON without executing")
      .argument("[args...]", "Arguments to pass to the tool")
      .action(async (_passedArgs: string[], options: SubCmdOpts) => {
        // 1. Resolve tool path
        const toolPath = Bun.which(cliDef.cliCmd);
        if (!toolPath) {
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

        // 7. Create empty overlay dir for hide paths + register cleanup
        let emptyDir = "";
        if (allHidePaths.length > 0) {
          emptyDir = await createEmptyOverlayDir();
          process.on("exit", () => removeOverlayDir(emptyDir));
          for (const sig of ["SIGINT", "SIGTERM"] as const) {
            process.on(sig, () => process.exit(128 + (sig === "SIGINT" ? 2 : 15)));
          }
        }

        // 8. Build bwrap options
        const bwrapOpts = {
          cwd: process.cwd(),
          home,
          cliDef,
          toolPath,
          toolArgs,
          hideHome,
          hidePaths: allHidePaths,
          emptyDir,
        };

        // 9. Build command once, then dry-run or execute
        const cmdResult = buildBwrapCommand(bwrapOpts);
        if (!cmdResult.ok) {
          process.stderr.write(cmdResult.error.message + "\n");
          process.exit(1);
        }

        if (options.dryRun) {
          console.log(JSON.stringify(cmdResult.value));
          process.exit(0);
        }

        const execResult = await executeBwrap(cmdResult.value);
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
