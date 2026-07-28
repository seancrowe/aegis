/**
 * Shared TOML reading helpers.
 *
 * Both config files aegis reads — `config.toml` and a project's `.aegis.toml` —
 * have to agree on how a document is turned into values, so the rules live here
 * rather than in whichever loader needed them first. Neither file may import
 * the other (config.ts already depends on overrides.ts for entry validation),
 * which is the other reason this is its own module.
 */
import { Result } from "typescript-result";

/**
 * Drop a leading BOM so `Bun.TOML.parse` sees the document the author wrote.
 *
 * Some editors add one on save, and Bun returns `{}` for a BOM-prefixed
 * document *without erroring* — so a file that looks fine yields zero rules and
 * the user believes restrictions are in force that are not. Every reader has to
 * strip it identically: one caller parsing raw bytes while another strips them
 * is how a configured tool gets reported as missing.
 */
export function stripBom(text: string): string {
  return text.startsWith("﻿") ? text.slice(1) : text;
}

/** True for a TOML table (an object that is not an array). */
export function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse TOML, surfacing the parser's own message and position on failure.
 *
 * Hand-editing is the expected workflow now, so a bare "invalid TOML" wastes
 * the line and column Bun already computed.
 */
export function parseToml(
  content: string,
  filePath: string
): Result<unknown, Error> {
  try {
    return Result.ok(Bun.TOML.parse(content));
  } catch (error) {
    const parserError = error as {
      message?: unknown;
      position?: { line?: unknown; column?: unknown };
    };
    const message =
      typeof parserError.message === "string"
        ? parserError.message
        : String(error);
    const { line, column } = parserError.position ?? {};
    if (typeof line === "number" && typeof column === "number") {
      return Result.error(new Error(`${filePath}:${line}:${column}: ${message}`));
    }
    return Result.error(new Error(`${filePath}: ${message}`));
  }
}
