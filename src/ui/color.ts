/**
 * Console color utilities.
 * Respects NO_COLOR environment variable.
 */

const noColor = !!process.env.NO_COLOR;

function wrap(code: string, text: string): string {
  if (noColor) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

export const color = {
  red: (text: string) => wrap("31", text),
  green: (text: string) => wrap("32", text),
  yellow: (text: string) => wrap("33", text),
  blue: (text: string) => wrap("34", text),
  dim: (text: string) => wrap("2", text),
  bold: (text: string) => wrap("1", text),
  underline: (text: string) => wrap("4", text),
};
