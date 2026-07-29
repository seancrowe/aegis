/**
 * Seed a config that opts the whole tool catalog in.
 *
 * A scaffolded config declares no `[tools.*]` tables — tools arrive only via
 * `aegis init` or `aegis tools add`. Tests that drive `aegis <tool>` end to end
 * therefore have to write the tables themselves rather than lean on the
 * first-run scaffold. Tables come from the same emitter aegis uses, so a
 * catalog edit cannot leave this seed stale.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TOOL_CATALOG, renderToolTable } from "../../src/tools/catalog";
import { defaultConfigContent } from "../../src/config/config";

/**
 * Write `<configHome>/aegis/config.toml` with the default policy plus every
 * catalog tool configured. Returns the config file path.
 *
 * The policy half is the scaffold verbatim, so tests asserting on default hide
 * paths keep asserting on the shipped values; only the tool tables are added.
 */
export async function seedCatalogConfig(configHome: string): Promise<string> {
  const dir = join(configHome, "aegis");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "config.toml");
  await writeFile(
    path,
    `${defaultConfigContent()}\n` +
      TOOL_CATALOG.map((recipe) => renderToolTable(recipe)).join("\n")
  );
  return path;
}

/** Same, for a home directory whose config lives at `<home>/.config`. */
export async function seedCatalogConfigForHome(home: string): Promise<string> {
  return seedCatalogConfig(join(home, ".config"));
}
