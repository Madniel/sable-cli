import { colorEnabled, cursor, style, terminalWidth, truncateToWidth } from '../util/ansi.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 90;
const ELAPSED_THRESHOLD_SECONDS = 2;
const SLOW_TOOL_MS = 1500;

export class StreamRenderer {
  private buffer = '';
  private insideCodeFence = false;
  private hasWritten = false;

  constructor(private readonly out: NodeJS.WriteStream = process.stdout) {}

  write(delta: string): void {
    this.buffer += delta;

    for (
      let newline = this.buffer.indexOf('\n');
      newline !== -1;
      newline = this.buffer.indexOf('\n')
    ) {
      this.emit(this.buffer.slice(0, newline));
      this.buffer = this.buffer.slice(newline + 1);
    }
  }

  end(): void {
    if (this.buffer) {
      this.emit(this.buffer);
      this.buffer = '';
    }

    if (this.hasWritten) this.out.write('\n');

    this.insideCodeFence = false;
    this.hasWritten = false;
  }

  get isEmpty(): boolean {
    return !this.hasWritten && this.buffer.length === 0;
  }

  private emit(line: string): void {
    this.hasWritten = true;
    this.out.write(`${this.decorate(line)}\n`);
  }

  private decorate(line: string): string {
    if (!colorEnabled()) return line;

    if (/^\s*```/.test(line)) {
      this.insideCodeFence = !this.insideCodeFence;
      const language = line.replace(/^\s*```/, '').trim();
      return style.gray(this.insideCodeFence && language ? `  ${language}` : '  ─');
    }

    if (this.insideCodeFence) return style.cyan(`  ${line}`);

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) return style.bold(style.cyan(heading[2] ?? ''));

    if (/^\s*>\s?/.test(line)) return style.gray(line);

    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const bulleted = line.replace(
        /^(\s*)([-*+])\s+/,
        (_match, indent: string) => `${indent}${style.cyan('•')} `,
      );
      return decorateInline(bulleted);
    }

    return decorateInline(line);
  }
}

function decorateInline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, (_match, code: string) => style.cyan(code))
    .replace(/\*\*([^*]+)\*\*/g, (_match, bold: string) => style.bold(bold))
    .replace(
      /(^|\s)_([^_]+)_(?=\s|$)/g,
      (_match, lead: string, emphasis: string) => `${lead}${style.italic(emphasis)}`,
    );
}

export class Spinner {
  private timer: NodeJS.Timeout | null = null;
  private frameIndex = 0;
  private label = '';
  private startedAt = Date.now();

  start(label: string): void {
    this.label = label;
    if (!colorEnabled() || this.timer) return;

    this.startedAt = Date.now();
    cursor.hide();
    this.timer = setInterval(() => this.tick(), SPINNER_INTERVAL_MS);
    this.timer.unref?.();
    this.tick();
  }

  setLabel(label: string): void {
    this.label = label;
  }

  stop(): void {
    if (!this.timer) return;

    clearInterval(this.timer);
    this.timer = null;
    cursor.clearLine();
    cursor.show();
  }

  private tick(): void {
    const seconds = Math.floor((Date.now() - this.startedAt) / 1000);
    const frame = SPINNER_FRAMES[this.frameIndex % SPINNER_FRAMES.length] ?? '-';
    this.frameIndex++;

    const elapsed = seconds > ELAPSED_THRESHOLD_SECONDS ? style.gray(` ${seconds}s`) : '';
    cursor.clearLine();
    process.stderr.write(
      truncateToWidth(style.cyan(`${frame} ${this.label}${elapsed}`), terminalWidth() - 1),
    );
  }
}

export function toolStartLine(name: string, summary: string): string {
  return `${style.gray('›')} ${style.bold(name)} ${style.gray(summary)}`;
}

export function toolEndLine(ok: boolean, display: string, durationMs: number): string {
  const mark = ok ? style.green('✓') : style.red('✗');
  const elapsed =
    durationMs > SLOW_TOOL_MS ? style.gray(` ${(durationMs / 1000).toFixed(1)}s`) : '';
  return `  ${mark} ${style.gray(display)}${elapsed}`;
}

export function notice(text: string): string {
  return style.yellow(`! ${text}`);
}

export function banner(model: string, root: string, approval: string, provider: string): string {
  return [
    '',
    `${style.bold(style.cyan('sable'))} ${style.gray('· an AI agent in your terminal')}`,
    `${style.gray('model')}    ${model} ${style.gray(`(${provider})`)}`,
    `${style.gray('cwd')}      ${root}`,
    `${style.gray('approval')} ${approval}`,
    style.gray('/help for commands, Ctrl+C to interrupt, Ctrl+D to exit'),
    '',
  ].join('\n');
}

export function indentDetail(detail: string): string {
  return detail.split('\n').map(colorizeDetailLine).join('\n');
}

function colorizeDetailLine(line: string): string {
  if (line.startsWith('@@')) return `  ${style.magenta(line)}`;
  if (line.startsWith('+')) return `  ${style.green(line)}`;
  if (line.startsWith('-')) return `  ${style.red(line)}`;
  if (line.startsWith('$')) return `  ${style.bold(line)}`;
  if (line.trimStart().startsWith('!')) return `  ${style.yellow(line)}`;
  return `  ${style.gray(line)}`;
}
