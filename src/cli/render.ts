import { colorEnabled, cursor, style, terminalWidth } from '../util/ansi.js';

/* -------------------------------------------------------------------------- */
/* Streaming markdown                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Renders model output as it streams. Styling is applied per completed line,
 * which is the only way to do this without buffering the whole response: a
 * half-arrived `**bold` is not yet anything.
 */
export class StreamRenderer {
  private buffer = '';
  private inFence = false;
  private wroteAnything = false;

  constructor(private readonly out: NodeJS.WriteStream = process.stdout) {}

  write(delta: string): void {
    this.buffer += delta;
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      this.emit(this.buffer.slice(0, newline));
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf('\n');
    }
  }

  /** Flush whatever is left and end the block. */
  end(): void {
    if (this.buffer) {
      this.emit(this.buffer);
      this.buffer = '';
    }
    if (this.wroteAnything) this.out.write('\n');
    this.inFence = false;
    this.wroteAnything = false;
  }

  get isEmpty(): boolean {
    return !this.wroteAnything && this.buffer.length === 0;
  }

  private emit(line: string): void {
    this.wroteAnything = true;
    this.out.write(`${this.styleLine(line)}\n`);
  }

  private styleLine(line: string): string {
    if (!colorEnabled()) return line;

    if (/^\s*```/.test(line)) {
      this.inFence = !this.inFence;
      const language = line.replace(/^\s*```/, '').trim();
      return style.gray(this.inFence && language ? `  ${language}` : '  ─');
    }

    if (this.inFence) return style.cyan(`  ${line}`);

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) return style.bold(style.cyan(heading[2] ?? ''));

    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      return inline(
        line.replace(/^(\s*)([-*+])\s+/, (_m, space: string) => `${space}${style.cyan('•')} `),
      );
    }

    if (/^\s*>\s?/.test(line)) return style.gray(line);

    return inline(line);
  }
}

function inline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, (_m, code: string) => style.cyan(code))
    .replace(/\*\*([^*]+)\*\*/g, (_m, bold: string) => style.bold(bold))
    .replace(
      /(^|\s)_([^_]+)_(?=\s|$)/g,
      (_m, lead: string, em: string) => `${lead}${style.italic(em)}`,
    );
}

/* -------------------------------------------------------------------------- */
/* Spinner                                                                    */
/* -------------------------------------------------------------------------- */

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class Spinner {
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;
  private label = '';
  private readonly startedAt = Date.now();

  start(label: string): void {
    this.label = label;
    if (!colorEnabled() || this.timer) {
      if (this.timer) return;
      return;
    }
    cursor.hide();
    this.timer = setInterval(() => this.tick(), 90);
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
    const frame = FRAMES[this.frame % FRAMES.length] ?? '-';
    this.frame++;
    const text = `${frame} ${this.label}${seconds > 2 ? style.gray(` ${seconds}s`) : ''}`;
    cursor.clearLine();
    process.stderr.write(truncateToWidth(style.cyan(text), terminalWidth() - 1));
  }
}

function truncateToWidth(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

/* -------------------------------------------------------------------------- */
/* Tool call lines                                                            */
/* -------------------------------------------------------------------------- */

export function toolStartLine(name: string, summary: string): string {
  return `${style.gray('›')} ${style.bold(name)} ${style.gray(summary)}`;
}

export function toolEndLine(ok: boolean, display: string, durationMs: number): string {
  const mark = ok ? style.green('✓') : style.red('✗');
  const time = durationMs > 1500 ? style.gray(` ${(durationMs / 1000).toFixed(1)}s`) : '';
  return `  ${mark} ${style.gray(display)}${time}`;
}

export function notice(text: string): string {
  return style.yellow(`! ${text}`);
}

export function banner(model: string, root: string, approval: string): string {
  const lines = [
    `${style.bold(style.cyan('sable'))} ${style.gray('· an AI agent in your terminal')}`,
    `${style.gray('model')}    ${model}`,
    `${style.gray('cwd')}      ${root}`,
    `${style.gray('approval')} ${approval}`,
    style.gray('/help for commands, Ctrl+C to interrupt, Ctrl+D to exit'),
  ];
  return `\n${lines.join('\n')}\n`;
}

/** Indent a block of detail text (a diff, a command) for an approval prompt. */
export function indentDetail(detail: string): string {
  return detail
    .split('\n')
    .map((line) => {
      if (line.startsWith('+')) return `  ${style.green(line)}`;
      if (line.startsWith('-')) return `  ${style.red(line)}`;
      if (line.startsWith('$')) return `  ${style.bold(line)}`;
      return `  ${style.gray(line)}`;
    })
    .join('\n');
}
