import { join, basename } from "node:path";
import { homedir, tmpdir, platform } from "node:os";

/**
 * Represents the standard directory structure for application data.
 */
export interface Paths {
  data: string;
  config: string;
  cache: string;
  log: string;
  temp: string;
}

export interface Options {
  /**
   * Appendix added to the end of the project name.
   * @default 'bun'
   */
  suffix?: string | boolean;
}

const home = homedir();
const temp = tmpdir();

const macos = (name: string): Paths => {
  const library = join(home, "Library");

  return {
    data: join(library, "Application Support", name),
    config: join(library, "Preferences", name),
    cache: join(library, "Caches", name),
    log: join(library, "Logs", name),
    temp: join(temp, name),
  };
};

const windows = (name: string): Paths => {
  const appData = Bun.env.APPDATA || join(home, "AppData", "Roaming");
  const localAppData = Bun.env.LOCALAPPDATA || join(home, "AppData", "Local");

  return {
    data: join(localAppData, name, "Data"),
    config: join(appData, name, "Config"),
    cache: join(localAppData, name, "Cache"),
    log: join(localAppData, name, "Log"),
    temp: join(temp, name),
  };
};

const linux = (name: string): Paths => {
  const username = basename(home);

  return {
    data: join(Bun.env.XDG_DATA_HOME || join(home, ".local", "share"), name),
    config: join(Bun.env.XDG_CONFIG_HOME || join(home, ".config"), name),
    cache: join(Bun.env.XDG_CACHE_HOME || join(home, ".cache"), name),
    log: join(Bun.env.XDG_STATE_HOME || join(home, ".local", "state"), name),
    temp: join(temp, username, name),
  };
};

/**
 * Get paths for things like config, cache, and data across different platforms.
 * * @param name - The name of your project.
 * @param options - Configuration options.
 */
export default function envPaths(
  name: string,
  { suffix = "bun" }: Options = {}
): Paths {
  if (typeof name !== "string") {
    throw new TypeError(`Expected a string, got ${typeof name}`);
  }

  let finalName = name;
  if (suffix) {
    finalName += `-${suffix}`;
  }

  const p = platform();

  if (p === "darwin") {
    return macos(finalName);
  }

  if (p === "win32") {
    return windows(finalName);
  }

  return linux(finalName);
}