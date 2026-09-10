/**
 * Minimal ANSI helpers. No dependencies; honours NO_COLOR and non-TTY output.
 */

const ESC = '\u001b';
const CSI = `${ESC}[`;

let enabled =
  process.stdout.isTTY === true && !process.env['NO_COLOR'] && process.env['TERM'] !== 'dumb';

export function setColorEnabled(value: boolean): void {
  enabled = value;
}

export function colorEnabled(): boolean {
  return enabled;
}

function wrap(open: number, close: number) {
  return (text: string): string => (enabled ? `${CSI}${open}m${text}${CSI}${close}m` : text);
}

export const style = {
  reset: `${CSI}0m`,
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  underline: wrap(4, 24),
  inverse: wrap(7, 27),
  strike: wrap(9, 29),

  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  white: wrap(37, 39),
  gray: wrap(90, 39),

  bgRed: wrap(41, 49),
  bgGreen: wrap(42, 49),
  bgYellow: wrap(43, 49),
} as const;

export const cursor = {
  hide(): void {
    if (enabled) process.stderr.write(`${CSI}?25l`);
  },
  show(): void {
    if (enabled) process.stderr.write(`${CSI}?25h`);
  },
  clearLine(): void {
    if (enabled) process.stderr.write(`${CSI}2K\r`);
  },
};

const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/** Visible width of a string, ignoring ANSI escape sequences. */
export function visibleWidth(text: string): number {
  return stripAnsi(text).length;
}

export function terminalWidth(fallback = 80): number {
  const columns = process.stdout.columns;
  return typeof columns === 'number' && columns > 20 ? columns : fallback;
}
