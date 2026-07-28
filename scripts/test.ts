#!/usr/bin/env bun
/**
 * Unified test runner for aegis.
 *
 * Usage:
 *   bun run scripts/test.ts [options] [layers...]
 *
 * Options:
 *   --logs      Show detailed test output (especially failures)
 *   --help      Show help
 *
 * Layers:
 *   local       Run L1/L2 tests locally (default if no layers specified)
 *   layer3      Run L3 bwrap semantic tests in Docker
 *   layer3m     Run L3m sandbox-exec semantic tests natively on macOS
 *   layer4      Run L4 e2e tests in Docker
 *   docker      Run L3 + L4 in Docker
 *   all         Run all layers (local + L3m + docker)
 *
 * Examples:
 *   bun run scripts/test.ts              # Run L1/L2 locally
 *   bun run scripts/test.ts all          # Run all tests
 *   bun run scripts/test.ts --logs all   # Run all with detailed output
 *   bun run scripts/test.ts layer3       # Run only L3 in Docker
 *   bun run scripts/test.ts layer3m      # Run only L3m natively
 */

import { $ } from "bun";
import { parseArgs } from "util";

// ANSI colors
const colors = {
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
};

function log(color: keyof typeof colors, message: string) {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

interface TestResult {
  layer: string;
  success: boolean;
  skipped?: boolean;
  output: string;
  duration: number;
}

interface ParsedArgs {
  logs: boolean;
  help: boolean;
  layers: string[];
}

function parseCliArgs(): ParsedArgs {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      logs: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  return {
    logs: values.logs ?? false,
    help: values.help ?? false,
    layers: positionals.length > 0 ? positionals : ["local"],
  };
}

function showHelp() {
  console.log(`
${colors.bold}aegis test runner${colors.reset}

${colors.yellow}Usage:${colors.reset}
  bun run scripts/test.ts [options] [layers...]

${colors.yellow}Options:${colors.reset}
  --logs      Show detailed test output (especially failures)
  --help, -h  Show this help

${colors.yellow}Layers:${colors.reset}
  local       Run L1/L2 tests locally (default)
  layer3      Run L3 bwrap semantic tests in Docker
  layer3m     Run L3m sandbox-exec semantic tests natively on macOS
  layer4      Run L4 e2e tests in Docker
  docker      Run L3 + L4 in Docker
  all         Run all layers (local + L3m + docker)

${colors.yellow}Examples:${colors.reset}
  bun run scripts/test.ts              # Run L1/L2 locally
  bun run scripts/test.ts all          # Run all tests
  bun run scripts/test.ts --logs all   # Run all with detailed output
  bun run scripts/test.ts layer3       # Run only L3 in Docker
  bun run scripts/test.ts layer3m      # Run only L3m natively
`);
}

async function runLocalTests(showLogs: boolean): Promise<TestResult> {
  const start = Date.now();
  log("blue", "\n=== Running Layer 1 + 2 (local) ===\n");

  try {
    const result = await $`bun run test`.quiet();
    const output = result.text();

    if (showLogs) {
      console.log(output);
    } else {
      log("green", "Local tests passed");
    }

    return {
      layer: "local (L1+L2)",
      success: true,
      output,
      duration: Date.now() - start,
    };
  } catch (error: unknown) {
    const err = error as { stdout?: Buffer; stderr?: Buffer };
    const output = (err.stdout?.toString() ?? "") + (err.stderr?.toString() ?? "") || String(error);

    if (showLogs) {
      console.log(output);
    }
    log("red", "Local tests failed");

    return {
      layer: "local (L1+L2)",
      success: false,
      output,
      duration: Date.now() - start,
    };
  }
}

async function checkDockerRunning(): Promise<{ running: boolean; error?: string }> {
  try {
    await $`docker info`.quiet();
    return { running: true };
  } catch (error: unknown) {
    const err = error as { stdout?: Buffer; stderr?: Buffer };
    const output = (err.stdout?.toString() ?? "") + (err.stderr?.toString() ?? "") || String(error);

    if (output.includes("Cannot connect to the Docker daemon") ||
        output.includes("docker.sock") ||
        output.includes("Is the docker daemon running")) {
      return {
        running: false,
        error: "Docker daemon is not running. Please start Docker and try again.\n" +
               "  - On Linux: sudo systemctl start docker\n" +
               "  - On macOS/Windows: Start Docker Desktop"
      };
    }

    return {
      running: false,
      error: `Docker check failed: ${output}`
    };
  }
}

async function runDockerTests(
  layer: "layer3" | "layer4",
  showLogs: boolean
): Promise<TestResult> {
  const start = Date.now();
  const config = {
    layer3: {
      name: "Layer 3 (bwrap semantic)",
      dockerfile: "tests/docker/Dockerfile.layer3",
      image: "aegis-layer3-tests",
    },
    layer4: {
      name: "Layer 4 (e2e)",
      dockerfile: "tests/docker/Dockerfile.layer4",
      image: "aegis-layer4-tests",
    },
  }[layer];

  log("blue", `\n=== Running ${config.name} in Docker ===\n`);

  // Check if Docker is running
  const dockerCheck = await checkDockerRunning();
  if (!dockerCheck.running) {
    log("red", "Error: Docker is not available");
    console.log(`\n${dockerCheck.error}\n`);
    return {
      layer: config.name,
      success: false,
      output: dockerCheck.error ?? "Docker not running",
      duration: Date.now() - start,
    };
  }

  try {
    // Build the Docker image
    log("yellow", "Building Docker image...");
    await $`docker build -f ${config.dockerfile} -t ${config.image} .`.quiet();

    // Run tests in Docker
    // Use --privileged for bwrap to work
    log("yellow", "Running tests...");
    const result = await $`docker run --rm --privileged ${config.image}`.quiet();
    const output = result.text();

    if (showLogs) {
      console.log(output);
    } else {
      log("green", `${config.name} tests passed`);
    }

    return {
      layer: config.name,
      success: true,
      output,
      duration: Date.now() - start,
    };
  } catch (error: unknown) {
    const err = error as { stdout?: Buffer; stderr?: Buffer };
    const output = (err.stdout?.toString() ?? "") + (err.stderr?.toString() ?? "") || String(error);

    if (showLogs) {
      console.log(output);
    }
    log("red", `${config.name} tests failed`);

    // Extract failure details from bun test output
    const failureMatch = output.match(/\d+ pass.*\d+ fail/);
    if (failureMatch) {
      log("red", `  ${failureMatch[0]}`);
    }

    return {
      layer: config.name,
      success: false,
      output,
      duration: Date.now() - start,
    };
  }
}

async function runMacSemanticTests(): Promise<TestResult> {
  const start = Date.now();
  const name = "Layer 3m (sandbox-exec semantic)";
  log("blue", `\n=== Running ${name} natively ===\n`);

  try {
    const result =
      await $`bun test tests/integration/seatbeltSemantic.test.ts`.quiet();
    const output = result.text() + result.stderr.toString();

    // A guarded skip is valid on nested/non-macOS hosts, but its reason and
    // counts must remain visible so nobody mistakes it for kernel coverage.
    console.log(output.trim());

    return {
      layer: name,
      success: true,
      skipped: output.includes("SKIP Layer 3m:"),
      output,
      duration: Date.now() - start,
    };
  } catch (error: unknown) {
    const err = error as { stdout?: Buffer; stderr?: Buffer };
    const output =
      (err.stdout?.toString() ?? "") +
        (err.stderr?.toString() ?? "") || String(error);
    console.log(output);
    log("red", `${name} tests failed`);
    return {
      layer: name,
      success: false,
      output,
      duration: Date.now() - start,
    };
  }
}

function printSummary(results: TestResult[], showLogs: boolean) {
  console.log("\n" + "=".repeat(60));
  log("bold", "Test Summary");
  console.log("=".repeat(60) + "\n");

  let allPassed = true;
  let anySkipped = false;

  for (const result of results) {
    const status = result.skipped
      ? `${colors.yellow}SKIP${colors.reset}`
      : result.success
        ? `${colors.green}PASS${colors.reset}`
        : `${colors.red}FAIL${colors.reset}`;
    const duration = (result.duration / 1000).toFixed(1);
    console.log(`  ${status}  ${result.layer} (${duration}s)`);

    if (result.skipped) {
      anySkipped = true;
    }
    if (!result.success) {
      allPassed = false;

      // Show failure summary if not already showing logs
      if (!showLogs) {
        // Extract failed test names from output
        const failedTests = result.output.match(/✗.*$/gm);
        if (failedTests && failedTests.length > 0) {
          console.log(`${colors.red}        Failed tests:${colors.reset}`);
          for (const test of failedTests.slice(0, 5)) {
            console.log(`          ${test}`);
          }
          if (failedTests.length > 5) {
            console.log(`          ... and ${failedTests.length - 5} more`);
          }
        }
      }
    }
  }

  console.log("");

  if (allPassed) {
    log(
      anySkipped ? "yellow" : "green",
      anySkipped
        ? "All executed tests passed; at least one layer was skipped."
        : "All tests passed!"
    );
  } else {
    log("red", "Some tests failed. Run with --logs for details.");
  }

  return allPassed;
}

async function main() {
  const args = parseCliArgs();

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  // Expand layer aliases
  const expandedLayers = new Set<string>();
  for (const layer of args.layers) {
    switch (layer) {
      case "all":
        expandedLayers.add("local");
        expandedLayers.add("layer3");
        expandedLayers.add("layer3m");
        expandedLayers.add("layer4");
        break;
      case "docker":
        expandedLayers.add("layer3");
        expandedLayers.add("layer4");
        break;
      default:
        expandedLayers.add(layer);
    }
  }

  const results: TestResult[] = [];

  // Run local tests if requested
  if (expandedLayers.has("local")) {
    results.push(await runLocalTests(args.logs));
  }

  // Run Docker tests if requested
  if (expandedLayers.has("layer3")) {
    results.push(await runDockerTests("layer3", args.logs));
  }

  if (expandedLayers.has("layer3m")) {
    results.push(await runMacSemanticTests());
  }

  if (expandedLayers.has("layer4")) {
    results.push(await runDockerTests("layer4", args.logs));
  }

  // Print summary and exit with appropriate code
  const allPassed = printSummary(results, args.logs);
  process.exit(allPassed ? 0 : 1);
}

main();
