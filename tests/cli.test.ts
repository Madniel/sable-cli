import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { describe } from 'node:test';

import { Session } from '../src/agent/session.js';
import { parseArgs } from '../src/cli/args.js';
import { StreamRenderer } from '../src/cli/render.js';
import { loadConfig } from '../src/config/config.js';
import { resolveWithin } from '../src/util/paths.js';
import { tempWorkspace } from './helpers.js';

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
    fs.mkdirSync(path.join(root, '.sable'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.sable/config.json'),
      JSON.stringify({ model: 'from-project', maxSteps: 7 }),
    );

    const config = loadConfig({ workspaceRoot: root });
    assert.equal(config.model, 'from-project');
    assert.equal(config.maxSteps, 7);
  });

  test('explicit overrides beat the config file', () => {
    const root = tempWorkspace({});
    fs.mkdirSync(path.join(root, '.sable'), { recursive: true });
    fs.writeFileSync(path.join(root, '.sable/config.json'), JSON.stringify({ model: 'from-file' }));

    assert.equal(loadConfig({ workspaceRoot: root, model: 'from-flag' }).model, 'from-flag');
  });

  test('rejects an invalid approval mode from a config file', () => {
    const root = tempWorkspace({});
    fs.mkdirSync(path.join(root, '.sable'), { recursive: true });
    fs.writeFileSync(path.join(root, '.sable/config.json'), JSON.stringify({ approval: 'nope' }));

    assert.throws(() => loadConfig({ workspaceRoot: root }), /Unknown approval mode/);
  });

  test('reports malformed JSON with the file name', () => {
    const root = tempWorkspace({});
    fs.mkdirSync(path.join(root, '.sable'), { recursive: true });
    fs.writeFileSync(path.join(root, '.sable/config.json'), '{ not json');

    assert.throws(() => loadConfig({ workspaceRoot: root }), /Invalid JSON/);
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

describe('Session', () => {
  test('trims only at a clean exchange boundary', () => {
    const session = new Session('m');
    session.append({ role: 'user', content: [{ type: 'text', text: 'one' }] });
    session.append({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }],
    });
    session.append({
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: 't1', content: 'x', isError: false }],
    });
    session.append({ role: 'assistant', content: [{ type: 'text', text: 'done' }] });
    session.append({ role: 'user', content: [{ type: 'text', text: 'two' }] });

    session.trimTo(2);
    const first = session.history()[0];

    assert.equal(first?.role, 'user');
    assert.ok(first?.content.every((block) => block.type !== 'tool_result'));
  });
});

describe('StreamRenderer', () => {
  test('writes complete lines as they arrive and flushes the tail', () => {
    const written: string[] = [];
    const fake = { write: (chunk: string) => written.push(chunk) } as unknown as NodeJS.WriteStream;

    const renderer = new StreamRenderer(fake);
    renderer.write('hello ');
    assert.equal(written.length, 0, 'a partial line should not be emitted yet');

    renderer.write('world\nsecond');
    assert.equal(written.join(''), 'hello world\n');

    renderer.end();
    assert.match(written.join(''), /second/);
  });
});
