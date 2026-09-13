const ESC = '\u001b';
const CSI = `${ESC}[`;
const SGR_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const MIN_USABLE_WIDTH = 20;

function detectColorSupport(): boolean {
  if (process.env['NO_COLOR']) return false;
  if (process.env['FORCE_COLOR']) return true;
  if (process.env['TERM'] === 'dumb') return false;
  return process.stdout.isTTY === true;
}

let colorIsEnabled = detectColorSupport();

export function setColorEnabled(value: boolean): void {
  colorIsEnabled = value;
}

export function colorEnabled(): boolean {
  return colorIsEnabled;
}

function sgr(open: number, close: number) {
  return (text: string): string => (colorIsEnabled ? `${CSI}${open}m${text}${CSI}${close}m` : text);
}

export const style = {
  reset: `${CSI}0m`,
  bold: sgr(1, 22),
  dim: sgr(2, 22),
  italic: sgr(3, 23),
  underline: sgr(4, 24),
  inverse: sgr(7, 27),
  strike: sgr(9, 29),

  red: sgr(31, 39),
  green: sgr(32, 39),
  yellow: sgr(33, 39),
  blue: sgr(34, 39),
  magenta: sgr(35, 39),
  cyan: sgr(36, 39),
  white: sgr(37, 39),
  gray: sgr(90, 39),

  bgRed: sgr(41, 49),
  bgGreen: sgr(42, 49),
  bgYellow: sgr(43, 49),
} as const;

export const cursor = {
  hide(): void {
    if (colorIsEnabled) process.stderr.write(`${CSI}?25l`);
  },
  show(): void {
    if (colorIsEnabled) process.stderr.write(`${CSI}?25h`);
  },
  clearLine(): void {
    if (colorIsEnabled) process.stderr.write(`${CSI}2K\r`);
  },
};

export function stripAnsi(text: string): string {
  return text.replace(SGR_PATTERN, '');
}

export function visibleWidth(text: string): number {
  return stripAnsi(text).length;
}

export function terminalWidth(fallback = 80): number {
  const columns = process.stdout.columns;
  return typeof columns === 'number' && columns > MIN_USABLE_WIDTH ? columns : fallback;
}

export function truncateToWidth(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  return `${stripAnsi(text).slice(0, Math.max(0, width - 1))}…`;
}
