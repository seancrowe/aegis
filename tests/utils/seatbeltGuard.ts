import { spawn } from "bun";

export interface SeatbeltProbe {
  available: boolean;
  message: string;
}

export async function probeSeatbelt(): Promise<SeatbeltProbe> {
  const plainTerminalGuidance =
    "Run Layer 3m from a plain macOS Terminal, outside any parent Seatbelt sandbox.";

  if (process.platform !== "darwin") {
    return {
      available: false,
      message:
        `SKIP Layer 3m: native Seatbelt enforcement requires macOS. ` +
        `A failed sandbox-exec probe on macOS usually means a nested sandbox cannot widen its parent's access. ${plainTerminalGuidance}`,
    };
  }

  try {
    const proc = spawn({
      cmd: [
        "/usr/bin/sandbox-exec",
        "-p",
        "(version 1)(allow default)",
        "/usr/bin/true",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    if (exitCode === 0) {
      return {
        available: true,
        message: "Layer 3m Seatbelt probe succeeded.",
      };
    }
    const detail = stderr.trim() || `sandbox-exec exited ${exitCode}`;
    return {
      available: false,
      message:
        `SKIP Layer 3m: sandbox-exec cannot apply even an allow-default profile (${detail}). ` +
        `This is the nested-sandbox signature: a child Seatbelt profile cannot widen access denied by its parent. ${plainTerminalGuidance}`,
    };
  } catch (error) {
    return {
      available: false,
      message:
        `SKIP Layer 3m: sandbox-exec probe failed (${String(error)}). ` +
        `This commonly means the process is already inside a nested Seatbelt sandbox. ${plainTerminalGuidance}`,
    };
  }
}
