import { APPROVAL_MODES, type ApprovalMode } from '../config/config.js';
import { style } from '../util/ansi.js';
import { ConfigError } from '../util/errors.js';

export interface ParsedArgs {
  prompt: string | undefined;
  /** Force one-shot mode even on a TTY. */
  print: boolean;
  model: string | undefined;
  cwd: string | undefined;
  approval: ApprovalMode | undefined;
  maxSteps: number | undefined;
  maxTokens: number | undefined;
  color: boolean | undefined;
  json: boolean;
  debug: boolean;
  help: boolean;
  version: boolean;
}

const EMPTY: ParsedArgs = {
  prompt: undefined,
  print: false,
  model: undefined,
  cwd: undefined,
  approval: undefined,
  maxSteps: undefined,
  maxTokens: undefined,
  color: undefined,
  json: false,
  debug: false,
  help: false,
  version: false,
};

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { ...EMPTY };
  const positional: string[] = [];

  const next = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('-')) {
      throw new ConfigError(`${flag} needs a value.`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;

    switch (arg) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '-v':
      case '--version':
        args.version = true;
        break;
      case '-p':
      case '--print':
        args.print = true;
        break;
      case '--json':
        args.json = true;
        args.print = true;
        break;
      case '--debug':
        args.debug = true;
        break;
      case '--no-color':
        args.color = false;
        break;
      case '--color':
        args.color = true;
        break;
      case '-m':
      case '--model':
        args.model = next(i, arg);
        i++;
        break;
      case '-C':
      case '--cwd':
        args.cwd = next(i, arg);
        i++;
        break;
      case '-a':
      case '--approval': {
        const value = next(i, arg);
        if (!APPROVAL_MODES.includes(value as ApprovalMode)) {
          throw new ConfigError(
            `Unknown approval mode "${value}". Expected: ${APPROVAL_MODES.join(', ')}.`,
          );
        }
        args.approval = value as ApprovalMode;
        i++;
        break;
      }
      case '--yolo':
        args.approval = 'yolo';
        break;
      case '--max-steps':
        args.maxSteps = toNumber(next(i, arg), arg);
        i++;
        break;
      case '--max-tokens':
        args.maxTokens = toNumber(next(i, arg), arg);
        i++;
        break;
      case '--':
        positional.push(...argv.slice(i + 1));
        i = argv.length;
        break;
      default:
        if (arg.startsWith('-') && arg.length > 1) {
          throw new ConfigError(`Unknown option "${arg}". Run \`sable --help\`.`);
        }
        positional.push(arg);
    }
  }

  if (positional.length > 0) args.prompt = positional.join(' ');
  return args;
}

function toNumber(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigError(`${flag} needs a positive number, got "${value}".`);
  }
  return parsed;
}

export function helpText(version: string): string {
  const b = style.bold;
  const g = style.gray;
  return `
${b('sable')} ${g(`v${version}`)} — an AI agent in your terminal

${b('Usage')}
  sable                          start an interactive session
  sable "fix the failing test"   run one task, then hand over the prompt
  sable -p "summarise src/"      one-shot: print the answer and exit
  cat error.log | sable -p       read the prompt from stdin

${b('Options')}
  -p, --print              non-interactive; write the final answer to stdout
      --json               emit one JSON object per event (implies --print)
  -m, --model <name>       model to use (default: claude-sonnet-4-5)
  -C, --cwd <dir>          workspace root; tools cannot reach outside it
  -a, --approval <mode>    ${APPROVAL_MODES.join(' | ')}
      --yolo               shorthand for --approval yolo
      --max-steps <n>      tool-use rounds allowed per turn (default 40)
      --max-tokens <n>     max tokens per model response
      --no-color           disable ANSI colour
      --debug              verbose diagnostics on stderr
  -h, --help               show this help
  -v, --version            print the version

${b('Approval modes')}
  readonly    the agent may read, but never write or run commands
  prompt      ask before every write and command ${g('(default)')}
  auto-edit   file edits apply silently; commands still ask
  yolo        never ask ${g('— use in a sandbox or a scratch repo')}

${b('Configuration')}
  ANTHROPIC_API_KEY        required
  ~/.sable/config.json     user defaults
  .sable/config.json       per-project overrides
  SABLE.md / AGENTS.md     project instructions injected into the system prompt
`;
}
