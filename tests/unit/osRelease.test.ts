/**
 * Unit tests for /etc/os-release parsing and install hint generation.
 * These tests validate the logic without touching the filesystem.
 */
import { describe, test, expect } from "bun:test";
import {
  parseOsRelease,
  getDistroFamily,
  getInstallHint,
  getInstallHintFromOsRelease,
  type OsRelease,
  type DistroFamily,
} from "../../src/os/osRelease";

describe("parseOsRelease", () => {
  test("parses Ubuntu os-release", () => {
    const content = `
NAME="Ubuntu"
VERSION="22.04.3 LTS (Jammy Jellyfish)"
ID=ubuntu
ID_LIKE=debian
PRETTY_NAME="Ubuntu 22.04.3 LTS"
VERSION_ID="22.04"
`;
    const result = parseOsRelease(content);
    expect(result.id).toBe("ubuntu");
    expect(result.idLike).toEqual(["debian"]);
    expect(result.name).toBe("Ubuntu");
    expect(result.versionId).toBe("22.04");
  });

  test("parses Fedora os-release", () => {
    const content = `
NAME="Fedora Linux"
VERSION="39 (Workstation Edition)"
ID=fedora
VERSION_ID=39
PRETTY_NAME="Fedora Linux 39 (Workstation Edition)"
`;
    const result = parseOsRelease(content);
    expect(result.id).toBe("fedora");
    expect(result.idLike).toEqual([]);
    expect(result.name).toBe("Fedora Linux");
    expect(result.versionId).toBe("39");
  });

  test("parses Arch Linux os-release", () => {
    const content = `
NAME="Arch Linux"
PRETTY_NAME="Arch Linux"
ID=arch
BUILD_ID=rolling
`;
    const result = parseOsRelease(content);
    expect(result.id).toBe("arch");
    expect(result.idLike).toEqual([]);
  });

  test("parses openSUSE os-release", () => {
    const content = `
NAME="openSUSE Tumbleweed"
ID="opensuse-tumbleweed"
ID_LIKE="opensuse suse"
PRETTY_NAME="openSUSE Tumbleweed"
`;
    const result = parseOsRelease(content);
    expect(result.id).toBe("opensuse-tumbleweed");
    expect(result.idLike).toEqual(["opensuse", "suse"]);
  });

  test("parses Alpine Linux os-release", () => {
    const content = `
NAME="Alpine Linux"
ID=alpine
VERSION_ID=3.19.0
PRETTY_NAME="Alpine Linux v3.19"
`;
    const result = parseOsRelease(content);
    expect(result.id).toBe("alpine");
    expect(result.idLike).toEqual([]);
    expect(result.versionId).toBe("3.19.0");
  });

  test("parses Debian os-release", () => {
    const content = `
PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"
NAME="Debian GNU/Linux"
VERSION_ID="12"
ID=debian
`;
    const result = parseOsRelease(content);
    expect(result.id).toBe("debian");
    expect(result.idLike).toEqual([]);
  });

  test("parses Gentoo os-release", () => {
    const content = `
NAME=Gentoo
ID=gentoo
PRETTY_NAME="Gentoo Linux"
`;
    const result = parseOsRelease(content);
    expect(result.id).toBe("gentoo");
    expect(result.idLike).toEqual([]);
  });

  test("parses Void Linux os-release", () => {
    const content = `
NAME="Void"
ID=void
DISTRIB_ID="void"
PRETTY_NAME="Void Linux"
`;
    const result = parseOsRelease(content);
    expect(result.id).toBe("void");
    expect(result.idLike).toEqual([]);
  });

  test("parses NixOS os-release", () => {
    const content = `
NAME=NixOS
ID=nixos
VERSION="23.11"
PRETTY_NAME="NixOS 23.11"
`;
    const result = parseOsRelease(content);
    expect(result.id).toBe("nixos");
    expect(result.idLike).toEqual([]);
  });

  test("parses Linux Mint (Debian-like)", () => {
    const content = `
NAME="Linux Mint"
VERSION="21.2 (Victoria)"
ID=linuxmint
ID_LIKE="ubuntu debian"
PRETTY_NAME="Linux Mint 21.2"
`;
    const result = parseOsRelease(content);
    expect(result.id).toBe("linuxmint");
    expect(result.idLike).toEqual(["ubuntu", "debian"]);
  });

  test("handles quoted values correctly", () => {
    const content = `
NAME="Test Distro"
ID="test"
ID_LIKE="parent1 parent2"
`;
    const result = parseOsRelease(content);
    expect(result.id).toBe("test");
    expect(result.name).toBe("Test Distro");
    expect(result.idLike).toEqual(["parent1", "parent2"]);
  });

  test("handles empty content", () => {
    const result = parseOsRelease("");
    expect(result.id).toBe("");
    expect(result.idLike).toEqual([]);
  });

  test("ignores comments and blank lines", () => {
    const content = `
# This is a comment
NAME="Test"
ID=test

# Another comment
VERSION_ID="1.0"
`;
    const result = parseOsRelease(content);
    expect(result.id).toBe("test");
    expect(result.name).toBe("Test");
    expect(result.versionId).toBe("1.0");
  });
});

describe("getDistroFamily", () => {
  const testCases: Array<{ osRelease: OsRelease; expected: DistroFamily }> = [
    // Direct ID matches
    { osRelease: { id: "debian", idLike: [] }, expected: "debian" },
    { osRelease: { id: "ubuntu", idLike: ["debian"] }, expected: "debian" },
    { osRelease: { id: "fedora", idLike: [] }, expected: "fedora" },
    { osRelease: { id: "rhel", idLike: ["fedora"] }, expected: "fedora" },
    { osRelease: { id: "centos", idLike: ["rhel", "fedora"] }, expected: "fedora" },
    { osRelease: { id: "arch", idLike: [] }, expected: "arch" },
    { osRelease: { id: "manjaro", idLike: ["arch"] }, expected: "arch" },
    { osRelease: { id: "opensuse-tumbleweed", idLike: ["opensuse", "suse"] }, expected: "suse" },
    { osRelease: { id: "opensuse-leap", idLike: ["suse", "opensuse"] }, expected: "suse" },
    { osRelease: { id: "alpine", idLike: [] }, expected: "alpine" },
    { osRelease: { id: "gentoo", idLike: [] }, expected: "gentoo" },
    { osRelease: { id: "void", idLike: [] }, expected: "void" },
    { osRelease: { id: "nixos", idLike: [] }, expected: "nix" },
    // ID_LIKE fallback
    { osRelease: { id: "linuxmint", idLike: ["ubuntu", "debian"] }, expected: "debian" },
    { osRelease: { id: "pop", idLike: ["ubuntu", "debian"] }, expected: "debian" },
    { osRelease: { id: "rocky", idLike: ["rhel", "centos", "fedora"] }, expected: "fedora" },
    { osRelease: { id: "endeavouros", idLike: ["arch"] }, expected: "arch" },
    // Unknown
    { osRelease: { id: "customos", idLike: [] }, expected: "unknown" },
    { osRelease: { id: "", idLike: [] }, expected: "unknown" },
  ];

  for (const { osRelease, expected } of testCases) {
    test(`identifies ${osRelease.id || "empty"} (idLike: ${osRelease.idLike.join(",") || "none"}) as ${expected}`, () => {
      expect(getDistroFamily(osRelease)).toBe(expected);
    });
  }
});

describe("getInstallHint", () => {
  const expectedHints: Record<DistroFamily, string> = {
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

  for (const [family, hint] of Object.entries(expectedHints)) {
    test(`returns correct hint for ${family}`, () => {
      expect(getInstallHint(family as DistroFamily)).toBe(hint);
    });
  }
});

describe("getInstallHintFromOsRelease", () => {
  test("returns apt hint for Ubuntu", () => {
    const osRelease: OsRelease = { id: "ubuntu", idLike: ["debian"] };
    expect(getInstallHintFromOsRelease(osRelease)).toBe("sudo apt install bubblewrap");
  });

  test("returns dnf hint for Fedora", () => {
    const osRelease: OsRelease = { id: "fedora", idLike: [] };
    expect(getInstallHintFromOsRelease(osRelease)).toBe("sudo dnf install bubblewrap");
  });

  test("returns pacman hint for Arch-based", () => {
    const osRelease: OsRelease = { id: "manjaro", idLike: ["arch"] };
    expect(getInstallHintFromOsRelease(osRelease)).toBe("sudo pacman -S bubblewrap");
  });

  test("returns generic hint for unknown distro", () => {
    const osRelease: OsRelease = { id: "obscureos", idLike: [] };
    expect(getInstallHintFromOsRelease(osRelease)).toBe(
      "Please install bubblewrap using your system's package manager"
    );
  });
});
