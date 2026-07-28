export interface LsSection {
  label: string;
  entries: string[];
  error?: string;
}

/**
 * Parse the behavioral fixture's ls sections identically for both kernels.
 */
export function parseLsOutput(stdout: string): Map<string, LsSection> {
  const sections = new Map<string, LsSection>();
  const lines = stdout.split("\n");
  let currentSection: LsSection | null = null;

  for (const line of lines) {
    const sectionMatch = line.match(/^=== LS:(.+) ===$/);
    if (sectionMatch) {
      if (currentSection) {
        sections.set(currentSection.label, currentSection);
      }
      currentSection = { label: sectionMatch[1]!, entries: [] };
      continue;
    }

    if (currentSection) {
      if (line.startsWith("ERROR:")) {
        currentSection.error = line;
      } else if (line.trim() && !line.startsWith("===")) {
        currentSection.entries.push(line.trim());
      }
    }
  }

  if (currentSection) {
    sections.set(currentSection.label, currentSection);
  }

  return sections;
}

export function parseArgs(stdout: string): string[] {
  const args: string[] = [];
  const lines = stdout.split("\n");
  let inArgsSection = false;

  for (const line of lines) {
    if (line === "=== ARGS ===") {
      inArgsSection = true;
      continue;
    }
    if (line.startsWith("=== ") && inArgsSection) {
      break;
    }
    if (inArgsSection) {
      const argMatch = line.match(/^arg: (.+)$/);
      if (argMatch) {
        args.push(argMatch[1]!);
      }
    }
  }

  return args;
}

export function parseSecretCredentialExists(stdout: string): boolean {
  const match = stdout.match(/EXISTS=(true|false)/);
  return match ? match[1] === "true" : false;
}
