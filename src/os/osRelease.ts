/**
 * OS Release parsing and install hint generation.
 * Parses /etc/os-release to determine distro and suggest bubblewrap install commands.
 */
import { readFile } from "node:fs/promises";

export interface OsRelease {
  id: string;
  idLike: string[];
  name?: string;
  versionId?: string;
}

/**
 * Parse /etc/os-release content into a structured object.
 */
export function parseOsRelease(content: string): OsRelease {
  const fields: Record<string, string> = {};

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx);
    let value = trimmed.slice(eqIdx + 1);

    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }

    fields[key] = value;
  }

  const id = fields["ID"] ?? "";
  const idLikeRaw = fields["ID_LIKE"] ?? "";
  const idLike = idLikeRaw ? idLikeRaw.split(/\s+/) : [];

  const result: OsRelease = { id, idLike };
  if (fields["NAME"] !== undefined) result.name = fields["NAME"];
  if (fields["VERSION_ID"] !== undefined) result.versionId = fields["VERSION_ID"];

  return result;
}

/**
 * Read and parse /etc/os-release from the filesystem.
 */
export async function readOsRelease(): Promise<OsRelease | null> {
  try {
    const content = await readFile("/etc/os-release", "utf-8");
    return parseOsRelease(content);
  } catch {
    return null;
  }
}

export type DistroFamily =
  | "debian"
  | "fedora"
  | "arch"
  | "suse"
  | "alpine"
  | "gentoo"
  | "void"
  | "nix"
  | "unknown";

const FAMILY_MAP: Record<string, DistroFamily> = {
  debian: "debian",
  ubuntu: "debian",
  fedora: "fedora",
  rhel: "fedora",
  centos: "fedora",
  arch: "arch",
  manjaro: "arch",
  "opensuse-tumbleweed": "suse",
  "opensuse-leap": "suse",
  opensuse: "suse",
  suse: "suse",
  alpine: "alpine",
  gentoo: "gentoo",
  void: "void",
  nixos: "nix",
};

/**
 * Determine the distro family from OS release info.
 */
export function getDistroFamily(osRelease: OsRelease): DistroFamily {
  const byId = FAMILY_MAP[osRelease.id];
  if (byId) return byId;

  for (const like of osRelease.idLike) {
    const byLike = FAMILY_MAP[like];
    if (byLike) return byLike;
  }

  return "unknown";
}

const INSTALL_HINTS: Record<DistroFamily, string> = {
  debian: "sudo apt install bubblewrap",
  fedora: "sudo dnf install bubblewrap",
  arch: "sudo pacman -S bubblewrap",
  suse: "sudo zypper install bubblewrap",
  alpine: "sudo apk add bubblewrap",
  gentoo: "sudo emerge sys-apps/bubblewrap",
  void: "sudo xbps-install -S bubblewrap",
  nix: "nix-env -iA nixpkgs.bubblewrap",
  unknown: "Please install bubblewrap using your system's package manager",
};

/**
 * Get the install command hint for bubblewrap based on distro.
 */
export function getInstallHint(family: DistroFamily): string {
  return INSTALL_HINTS[family];
}

/**
 * Get install hint directly from OS release info.
 */
export function getInstallHintFromOsRelease(osRelease: OsRelease): string {
  return getInstallHint(getDistroFamily(osRelease));
}
