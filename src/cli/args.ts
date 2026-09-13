import { APPROVAL_MODES, type ApprovalMode } from '../config/config.js';
import { style } from '../util/ansi.js';
import { ConfigError } from '../util/errors.js';

export interface ParsedArgs {
  prompt: string | undefined;
  print: boolean;
  json: boolean;
  provider: string | undefined;
  model: string | undefined;
  cwd: string | undefined;
  approval: ApprovalMode | undefined;
  maxSteps: number | undefined;
  maxTokens: number | undefined;
  compactAt: number | undefined;
  resume: string | undefined;
  continueLatest: boolean;
  persist: boolean | undefined;
  color: boolean | undefined;
  debug: boolean;
  help: boolean;
  version: boolean;
}

const EMPTY_ARGS: ParsedArgs = {
  prompt: undefined,
  print: false,
  json: false,
  provider: undefined,
  model: undefined,
  cwd: undefined,
  approval: undefined,
  maxSteps: undefined,
  maxTokens: undefined,
  compactAt: undefined,
  resume: undefined,
  continueLatest: false,
  persist: undefined,
  color: undefined,
  debug: false,
  help: false,
  version: false,
};

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { ...EMPTY_ARGS };
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string;

    if (arg === '--') {
      positional.push(...argv.slice(index + 1));
      break;
    }

    const consumed = applyFlag(arg, args, () => valueAfter(argv, index, arg));

    if (consumed === 'flag') continue;
    if (consumed === 'flag-with-value') {
      index++;
      continue;
    }

    if (arg.startsWith('-') && arg.length > 1) {
      throw new ConfigError(`Unknown option "${arg}". Run \`sable --help\`.`);
    }

    positional.push(arg);
  }

  if (positional.length > 0) args.prompt = positional.join(' ');
  return args;
}

type FlagOutcome = 'flag' | 'flag-with-value' | 'positional';

function applyFlag(arg: string, args: ParsedArgs, value: () => string): FlagOutcome {
  switch (arg) {
    case '-h':
    case '--help':
      args.help = true;
      return 'flag';

    case '-v':
    case '--version':
      args.version = true;
      return 'flag';

    case '-p':
    case '--print':
      args.print = true;
      return 'flag';

    case '--json':
      args.json = true;
      args.print = true;
      return 'flag';

    case '--debug':
      args.debug = true;
      return 'flag';

    case '--no-color':
      args.color = false;
      return 'flag';

    case '--color':
      args.color = true;
      return 'flag';

    case '--yolo':
      args.approval = 'yolo';
      return 'flag';

    case '--no-persist':
      args.persist = false;
      return 'flag';

    case '-c':
    case '--continue':
      args.continueLatest = true;
      return 'flag';

    case '--resume':
      args.resume = value();
      return 'flag-with-value';

    case '--provider':
      args.provider = value();
      return 'flag-with-value';

    case '-m':
    case '--model':
      args.model = value();
      return 'flag-with-value';

    case '-C':
    case '--cwd':
      args.cwd = value();
      return 'flag-with-value';

    case '-a':
    case '--approval':
      args.approval = toApprovalMode(value());
      return 'flag-with-value';

    case '--max-steps':
      args.maxSteps = toPositiveNumber(value(), arg);
      return 'flag-with-value';

    case '--max-tokens':
      args.maxTokens = toPositiveNumber(value(), arg);
      return 'flag-with-value';

    case '--compact-at':
      args.compactAt = toPositiveNumber(value(), arg);
      return 'flag-with-value';

    default:
      return 'positional';
  }
}

function valueAfter(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];

  if (value === undefined || value.startsWith('-')) {
    throw new ConfigError(`${flag} needs a value.`);
  }

  return value;
}

function toApprovalMode(value: string): ApprovalMode {
  if (!APPROVAL_MODES.includes(value as ApprovalMode)) {
    throw new ConfigError(
      `Unknown approval mode "${value}". Expected: ${APPROVAL_MODES.join(', ')}.`,
    );
  }

  return value as ApprovalMode;
}

function toPositiveNumber(value: string, flag: string): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigError(`${flag} needs a positive number, got "${value}".`);
  }

  return parsed;
}

export function helpText(version: string): string {
  const bold = style.bold;
  const gray = style.gray;

  return `
${bold('sable')} ${gray(`v${version}`)} — an AI agent in your terminal

${bold('Usage')}
  sable                          start an interactive session
  sable "fix the failing test"   run one task, then hand over the prompt
  sable -p "summarise src/"      one-shot: print the answer and exit
  cat error.log | sable -p       read the prompt from stdin
  sable --continue               pick up the last session in this directory

${bold('Options')}
  -p, --print              non-interactive; write the final answer to stdout
      --json               emit one JSON object per event (implies --print)
      --provider <name>    anthropic | openai
  -m, --model <name>       model to use
  -C, --cwd <dir>          workspace root; tools cannot reach outside it
  -a, --approval <mode>    ${APPROVAL_MODES.join(' | ')}
      --yolo               shorthand for --approval yolo
  -c, --continue           resume the most recent session for this directory
      --resume <id>        resume a specific session (see /sessions)
      --no-persist         do not save this session to disk
      --max-steps <n>      tool-use rounds allowed per turn (default 40)
      --max-tokens <n>     max tokens per model response
      --compact-at <n>     summarise the conversation past this many tokens
      --no-color           disable ANSI colour
      --debug              verbose diagnostics on stderr
  -h, --help               show this help
  -v, --version            print the version

${bold('Approval modes')}
  readonly    the agent may read, but never write or run commands
  prompt      ask before every write and command ${gray('(default)')}
  auto-edit   file edits apply silently; commands still ask
  yolo        never ask ${gray('— use in a sandbox or a scratch repo')}

${bold('Configuration')}
  ANTHROPIC_API_KEY        required for the anthropic provider
  OPENAI_API_KEY           required for the openai provider
  ~/.sable/config.json     user defaults
  .sable/config.json       per-project overrides
  SABLE.md / AGENTS.md     project instructions injected into the system prompt
`;
}
