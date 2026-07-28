import { describe, expect, test } from "bun:test";
import {
  TOOL_CATALOG,
  defaultCliDefs,
  renderToolTable,
  tomlString,
  type ToolRecipe,
} from "../../src/tools/catalog";

const claudeRecipe = TOOL_CATALOG.find(
  (recipe) => recipe.subCommand === "cc"
)!;

describe("tool catalog", () => {
  test("claude gets the macOS login keychain as an rwPath on darwin", () => {
    // Without write access the OAuth refresh cannot persist its rotated token,
    // which surfaces hours later as a spurious logout in unsandboxed sessions.
    const claude = defaultCliDefs("darwin").find(
      (cli) => cli.subCommand === "cc"
    )!;
    expect(claude.rwPaths).toContainEqual({
      kind: "dir",
      path: "Library/Keychains",
    });
    expect(renderToolTable(claudeRecipe, "darwin")).toContain(
      "Library/Keychains"
    );
  });

  test("claude has no keychain rwPath off darwin", () => {
    // ~/Library/Keychains does not exist on Linux, and bwrap's rwPath bind
    // would have ensureHostPathsExist create an empty one.
    for (const platform of ["linux", "win32"] as const) {
      const claude = defaultCliDefs(platform).find(
        (cli) => cli.subCommand === "cc"
      )!;
      expect(claude.rwPaths.map((rwPath) => rwPath.path)).toEqual([
        ".claude",
        ".claude.json",
      ]);
    }
    expect(renderToolTable(claudeRecipe, "linux")).not.toContain(
      "Library/Keychains"
    );
  });
});

describe("renderToolTable", () => {
  test("renders valid TOML and round-trips the recipe fields", () => {
    const rendered = renderToolTable(claudeRecipe, "darwin");
    const parsed = Bun.TOML.parse(rendered) as {
      tools: Record<string, Record<string, unknown>>;
    };

    expect(parsed.tools.cc).toEqual({
      name: "claude code",
      cliCmd: "claude",
      yoloArg: "--dangerously-skip-permissions",
      rwDirs: [".claude", "Library/Keychains"],
      rwFiles: [".claude.json"],
    });
    expect(rendered.endsWith("\n")).toBe(true);
    expect(rendered.endsWith("\n\n")).toBe(false);
  });

  test("emits directory policy before file policy", () => {
    const rendered = renderToolTable(claudeRecipe, "darwin");
    expect(rendered.indexOf("rwDirs =")).toBeLessThan(
      rendered.indexOf("rwFiles =")
    );
  });

  test("quotes a table key that is not a valid bare key", () => {
    // A dot in a bare key nests, so `--as my.tool` would otherwise emit
    // [tools.my.tool] and parse as a tool "my" containing a tool "tool".
    const recipe: ToolRecipe = {
      name: "dotted",
      cliCmd: "dotted",
      subCommand: "my.tool",
      rwPaths: [{ kind: "dir", path: ".dotted" }],
    };
    const rendered = renderToolTable(recipe, "linux");
    expect(rendered).toContain('[tools."my.tool"]');

    const parsed = Bun.TOML.parse(rendered) as {
      tools: Record<string, unknown>;
    };
    expect(Object.keys(parsed.tools)).toEqual(["my.tool"]);
  });

  test("a table key containing a quote cannot break out of the key", () => {
    const recipe: ToolRecipe = {
      name: "hostile",
      cliCmd: "hostile",
      subCommand: 'a"]\n[tools.evil',
      rwPaths: [{ kind: "dir", path: ".hostile" }],
    };
    const parsed = Bun.TOML.parse(renderToolTable(recipe, "linux")) as {
      tools: Record<string, unknown>;
    };
    expect(Object.keys(parsed.tools)).toEqual(['a"]\n[tools.evil']);
  });

  test("omits absent yoloArg and empty path kinds", () => {
    const recipe: ToolRecipe = {
      name: "minimal",
      cliCmd: "minimal",
      subCommand: "minimal",
      rwPaths: [{ kind: "file", path: ".minimal.json" }],
    };
    const rendered = renderToolTable(recipe, "linux");

    expect(rendered).not.toContain("yoloArg =");
    expect(rendered).not.toContain("rwDirs =");
    expect(rendered).toContain('rwFiles = [".minimal.json"]');
    expect(rendered).not.toContain("= []");
  });
});

describe("tomlString", () => {
  test("escapes injection-shaped content and parses it back", () => {
    const input = 'quote " slash \\ newline\n backspace\b';
    const rendered = tomlString(input);
    const parsed = Bun.TOML.parse(`x = ${rendered}`) as { x: string };

    expect(rendered).toContain('\\"');
    expect(rendered).toContain("\\\\");
    expect(rendered).toContain("\\n");
    expect(rendered).toContain("\\b");
    expect(parsed.x).toBe(input);
  });

  test("uses TOML escapes for tabs and other control characters", () => {
    expect(tomlString("\t")).toBe('"\\t"');
    expect(tomlString("\u0001")).toBe('"\\u0001"');
  });
});
