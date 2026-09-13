import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { describe } from 'node:test';

import { parseArgs } from '../src/cli/args.js';
import { StreamRenderer } from '../src/cli/render.js';
import { DEFAULT_MODELS, loadConfig } from '../src/config/config.js';
import { resolveWithin } from '../src/util/paths.js';
import { tempWorkspace } from './helpers.js';

function writeProjectConfig(root: string, config: object): void {
  fs.mkdirSync(path.join(root, '.sable'), { recursive: true });
  fs.writeFileSync(path.join(root, '.sable/config.json'), JSON.stringify(config));
}

describe('parseArgs', () => {
  test('treats bare words as the prompt', () => {
    assert.equal(parseArgs(['fix', 'the', 'test']).prompt, 'fix the test');
  });

  test('reads flags with values', () => {
    const args = parseArgs(['-m', 'claude-opus-4-1', '-C', '/tmp', '--max-steps', '5', 'go']);

    assert.equal(args.model, 'claude-opus-4-1');
    assert.equal(args.cwd, '/tmp');
    assert.equal(args.maxSteps, 5);
    assert.equal(args.prompt, 'go');
  });

  test('--json implies --print', () => {
    const args = parseArgs(['--json', 'go']);

    assert.equal(args.json, true);
    assert.equal(args.print, true);
  });

  test('--yolo is shorthand for the approval mode', () => {
    assert.equal(parseArgs(['--yolo']).approval, 'yolo');
  });

  test('reads the session flags', () => {
    assert.equal(parseArgs(['--resume', 'abc123']).resume, 'abc123');
    assert.equal(parseArgs(['--continue']).continueLatest, true);
    assert.equal(parseArgs(['-c']).continueLatest, true);
    assert.equal(parseArgs(['--no-persist']).persist, false);
  });

  test('reads provider and compaction flags', () => {
    const args = parseArgs(['--provider', 'openai', '--compact-at', '50000']);

    assert.equal(args.provider, 'openai');
    assert.equal(args.compactAt, 50_000);
  });

  test('rejects an unknown approval mode', () => {
    assert.throws(() => parseArgs(['--approval', 'whatever']), /Unknown approval mode/);
  });

  test('rejects an unknown flag rather than silently ignoring it', () => {
    assert.throws(() => parseArgs(['--turbo']), /Unknown option "--turbo"/);
  });

  test('everything after -- is prompt text', () => {
    assert.equal(parseArgs(['--', '--not-a-flag']).prompt, '--not-a-flag');
  });

  test('a flag missing its value is an error', () => {
    assert.throws(() => parseArgs(['--model']), /needs a value/);
  });
});

describe('loadConfig', () => {
  test('project config overrides user defaults', () => {
    const root = tempWorkspace({});
    writeProjectConfig(root, { model: 'from-project', maxSteps: 7 });

    const config = loadConfig({ workspaceRoot: root });

    assert.equal(config.model, 'from-project');
    assert.equal(config.maxSteps, 7);
  });

  test('explicit overrides beat the config file', () => {
    const root = tempWorkspace({});
    writeProjectConfig(root, { model: 'from-file' });

    assert.equal(loadConfig({ workspaceRoot: root, model: 'from-flag' }).model, 'from-flag');
  });

  test('picks the default model for the chosen provider', () => {
    const root = tempWorkspace({});

    assert.equal(loadConfig({ workspaceRoot: root }).model, DEFAULT_MODELS['anthropic']);
    assert.equal(
      loadConfig({ workspaceRoot: root, provider: 'openai' }).model,
      DEFAULT_MODELS['openai'],
    );
  });

  test('reads the API key for the selected provider', () => {
    const root = tempWorkspace({});
    const previous = process.env['OPENAI_API_KEY'];
    process.env['OPENAI_API_KEY'] = 'openai-key';

    try {
      assert.equal(loadConfig({ workspaceRoot: root, provider: 'openai' }).apiKey, 'openai-key');
    } finally {
      if (previous === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = previous;
    }
  });

  test('rejects an invalid approval mode from a config file', () => {
    const root = tempWorkspace({});
    writeProjectConfig(root, { approval: 'nope' });

    assert.throws(() => loadConfig({ workspaceRoot: root }), /Unknown approval mode/);
  });

  test('reports malformed JSON with the file name', () => {
    const root = tempWorkspace({});
    fs.mkdirSync(path.join(root, '.sable'), { recursive: true });
    fs.writeFileSync(path.join(root, '.sable/config.json'), '{ not json');

    assert.throws(() => loadConfig({ workspaceRoot: root }), /Invalid JSON/);
  });

  test('rejects a nonsense compaction threshold', () => {
    const root = tempWorkspace({});
    writeProjectConfig(root, { compactAtTokens: 0 });

    assert.throws(() => loadConfig({ workspaceRoot: root }), /compactAtTokens/);
  });
});

describe('resolveWithin', () => {
  test('allows paths inside the root', () => {
    assert.ok(resolveWithin('/work', 'src/a.ts')?.endsWith('/work/src/a.ts'));
  });

  test('blocks traversal, absolute escapes and sibling-prefix tricks', () => {
    assert.equal(resolveWithin('/work', '../secrets'), null);
    assert.equal(resolveWithin('/work', '/etc/passwd'), null);
    assert.equal(resolveWithin('/work', 'src/../../elsewhere'), null);
    assert.equal(resolveWithin('/work', '../work-other/file'), null);
  });
});

describe('StreamRenderer', () => {
  test('writes complete lines as they arrive and flushes the tail', () => {
    const written: string[] = [];
    const sink = { write: (chunk: string) => written.push(chunk) } as unknown as NodeJS.WriteStream;

    const renderer = new StreamRenderer(sink);
    renderer.write('hello ');
    assert.equal(written.length, 0, 'a partial line should not be emitted yet');

    renderer.write('world\nsecond');
    assert.equal(written.join(''), 'hello world\n');

    renderer.end();
    assert.match(written.join(''), /second/);
  });

  test('reports whether anything has been written', () => {
    const sink = { write: () => true } as unknown as NodeJS.WriteStream;
    const renderer = new StreamRenderer(sink);

    assert.equal(renderer.isEmpty, true);
    renderer.write('x');
    assert.equal(renderer.isEmpty, false);
  });
});
