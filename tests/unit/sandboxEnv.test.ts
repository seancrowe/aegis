/**
 * Verify that both sandbox backends inject AEGIS_SANDBOX=1 into the child
 * process environment.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeSandboxExec } from "../../src/sandbox/sandboxExec";
import { executeBwrap } from "../../src/sandbox/bwrap";

describe("AEGIS_SANDBOX env var", () => {
  let tempDir: string;
  let outFile: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aegis-env-test-"));
    outFile = join(tempDir, "aegis_sandbox_val");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("executeSandboxExec passes AEGIS_SANDBOX=1 to the child", async () => {
    const result = await executeSandboxExec({
      cmd: "sh",
      args: ["-c", `printenv AEGIS_SANDBOX > "${outFile}"`],
    });
    expect(result.ok).toBe(true);
    const val = (await readFile(outFile, "utf-8")).trim();
    expect(val).toBe("1");
  });

  test("executeBwrap passes AEGIS_SANDBOX=1 to the child", async () => {
    const result = await executeBwrap({
      cmd: "sh",
      args: ["-c", `printenv AEGIS_SANDBOX > "${outFile}"`],
    });
    expect(result.ok).toBe(true);
    const val = (await readFile(outFile, "utf-8")).trim();
    expect(val).toBe("1");
  });
});
