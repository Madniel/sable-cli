import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { describe } from 'node:test';

import { editFileTool } from '../src/tools/edit-file.js';
import { globToRegExp, grepTool } from '../src/tools/grep.js';
import { listDirTool } from '../src/tools/list-dir.js';
import { readFileTool } from '../src/tools/read-file.js';
import { shellTool } from '../src/tools/shell.js';
import { writeFileTool } from '../src/tools/write-file.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { tempWorkspace, testContext } from './helpers.js';

describe('read_file', () => {
  test('returns line-numbered content', async () => {
    const root = tempWorkspace({ 'a.txt': 'one\ntwo\nthree' });
    const result = await readFileTool.run({ path: 'a.txt' }, testContext(root));
    assert.match(result.output, /1 {2}one/);
    assert.match(result.output, /3 {2}three/);
  });

  test('honours offset and limit and points at the next page', async () => {
    const root = tempWorkspace({
      'a.txt': Array.from({ length: 50 }, (_, i) => `L${i + 1}`).join('\n'),
    });
    const result = await readFileTool.run(
      { path: 'a.txt', offset: 10, limit: 5 },
      testContext(root),
    );
    assert.match(result.output, /10 {2}L10/);
    assert.match(result.output, /14 {2}L14/);
    assert.doesNotMatch(result.output, /15 {2}L15/);
    assert.match(result.output, /offset=15/);
  });

  test('refuses to escape the workspace', async () => {
    const root = tempWorkspace({});
    await assert.rejects(
      () => readFileTool.run({ path: '../../etc/passwd' }, testContext(root)),
      /outside the workspace root/,
    );
  });

  test('reports a missing file as a tool error, not an exception', async () => {
    const root = tempWorkspace({});
    const result = await readFileTool.run({ path: 'nope.txt' }, testContext(root));
    assert.equal(result.isError, true);
    assert.match(result.output, /no such file/);
  });

  test('refuses binary files', async () => {
    const root = tempWorkspace({});
    fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
    const result = await readFileTool.run({ path: 'blob.bin' }, testContext(root));
    assert.equal(result.isError, true);
    assert.match(result.output, /binary/);
  });
});

describe('write_file', () => {
  test('creates a file and its parent directories', async () => {
    const root = tempWorkspace({});
    const ctx = testContext(root);
    const result = await writeFileTool.run({ path: 'src/new/a.ts', content: 'x\n' }, ctx);
    assert.equal(result.isError, undefined);
    assert.equal(fs.readFileSync(path.join(root, 'src/new/a.ts'), 'utf8'), 'x\n');
    assert.equal(ctx.confirmations.length, 1);
  });

  test('a refusal aborts the write', async () => {
    const root = tempWorkspace({ 'a.txt': 'keep' });
    const ctx = testContext(root, { answer: 'reject' });
    await assert.rejects(
      () => writeFileTool.run({ path: 'a.txt', content: 'clobber' }, ctx),
      /declined/,
    );
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'keep');
  });

  test('a no-op write does not even ask', async () => {
    const root = tempWorkspace({ 'a.txt': 'same' });
    const ctx = testContext(root);
    const result = await writeFileTool.run({ path: 'a.txt', content: 'same' }, ctx);
    assert.match(result.output, /No change/);
    assert.equal(ctx.confirmations.length, 0);
  });
});

describe('edit_file', () => {
  test('replaces a unique match', async () => {
    const root = tempWorkspace({ 'a.ts': 'const a = 1;\nconst b = 2;\n' });
    await editFileTool.run(
      { path: 'a.ts', old_string: 'a = 1', new_string: 'a = 42' },
      testContext(root),
    );
    assert.equal(fs.readFileSync(path.join(root, 'a.ts'), 'utf8'), 'const a = 42;\nconst b = 2;\n');
  });

  test('refuses an ambiguous match and says how to fix it', async () => {
    const root = tempWorkspace({ 'a.ts': 'x\nx\n' });
    const result = await editFileTool.run(
      { path: 'a.ts', old_string: 'x', new_string: 'y' },
      testContext(root),
    );
    assert.equal(result.isError, true);
    assert.match(result.output, /appears 2 times/);
    assert.match(result.output, /replace_all/);
  });

  test('replace_all rewrites every occurrence', async () => {
    const root = tempWorkspace({ 'a.ts': 'x\nx\n' });
    await editFileTool.run(
      { path: 'a.ts', old_string: 'x', new_string: 'y', replace_all: true },
      testContext(root),
    );
    assert.equal(fs.readFileSync(path.join(root, 'a.ts'), 'utf8'), 'y\ny\n');
  });

  test('reports a miss instead of guessing', async () => {
    const root = tempWorkspace({ 'a.ts': 'hello' });
    const result = await editFileTool.run(
      { path: 'a.ts', old_string: 'goodbye', new_string: 'hi' },
      testContext(root),
    );
    assert.equal(result.isError, true);
    assert.match(result.output, /was not found/);
  });
});

describe('list_dir', () => {
  test('renders a tree and skips noise directories', async () => {
    const root = tempWorkspace({
      'src/a.ts': '',
      'src/nested/b.ts': '',
      'node_modules/junk/index.js': '',
    });
    const result = await listDirTool.run({ path: '.', depth: 3 }, testContext(root));
    assert.match(result.output, /src\//);
    assert.match(result.output, /b\.ts/);
    assert.doesNotMatch(result.output, /node_modules/);
  });
});

describe('grep', () => {
  test('finds matches with file and line numbers', async () => {
    const root = tempWorkspace({ 'a.ts': 'const needle = 1;\n', 'b.md': 'no match here\n' });
    const result = await grepTool.run({ pattern: 'needle' }, testContext(root));
    assert.match(result.output, /a\.ts:1:/);
  });

  test('respects a glob filter', async () => {
    const root = tempWorkspace({ 'src/a.ts': 'needle\n', 'docs/b.md': 'needle\n' });
    const result = await grepTool.run({ pattern: 'needle', glob: '**/*.ts' }, testContext(root));
    assert.match(result.output, /a\.ts/);
    assert.doesNotMatch(result.output, /b\.md/);
  });

  test('reports no matches without erroring', async () => {
    const root = tempWorkspace({ 'a.ts': 'nothing\n' });
    const result = await grepTool.run({ pattern: 'zzz' }, testContext(root));
    assert.equal(result.isError, undefined);
    assert.match(result.output, /No matches/);
  });

  test('rejects an invalid regular expression', async () => {
    const root = tempWorkspace({});
    await assert.rejects(
      () => grepTool.run({ pattern: '([' }, testContext(root)),
      /invalid regular/,
    );
  });
});

describe('globToRegExp', () => {
  test('matches the patterns people actually write', () => {
    assert.ok(globToRegExp('**/*.ts').test('src/deep/a.ts'));
    assert.ok(globToRegExp('**/*.ts').test('a.ts'));
    assert.ok(!globToRegExp('**/*.ts').test('a.js'));
    assert.ok(globToRegExp('src/*.ts').test('src/a.ts'));
    assert.ok(!globToRegExp('src/*.ts').test('src/deep/a.ts'));
    assert.ok(globToRegExp('a?.txt').test('ab.txt'));
  });
});

describe('shell', () => {
  test('captures stdout and the exit code', async () => {
    const root = tempWorkspace({});
    const result = await shellTool.run({ command: 'echo hello' }, testContext(root));
    assert.match(result.output, /Exit code: 0/);
    assert.match(result.output, /hello/);
  });

  test('marks a non-zero exit as an error', async () => {
    const root = tempWorkspace({});
    const result = await shellTool.run({ command: 'exit 3' }, testContext(root));
    assert.equal(result.isError, true);
    assert.match(result.output, /Exit code: 3/);
  });

  test('a refusal stops the command', async () => {
    const root = tempWorkspace({});
    await assert.rejects(
      () =>
        shellTool.run({ command: 'touch created.txt' }, testContext(root, { answer: 'reject' })),
      /declined/,
    );
    assert.equal(fs.existsSync(path.join(root, 'created.txt')), false);
  });

  test('times out a hanging command', async () => {
    const root = tempWorkspace({});
    const result = await shellTool.run(
      { command: 'sleep 30', timeout_ms: 1000 },
      testContext(root),
    );
    assert.equal(result.isError, true);
    assert.match(result.output, /timed out/);
  });
});

describe('ToolRegistry', () => {
  test('exposes schemas for every tool', () => {
    const specs = new ToolRegistry().specs();
    assert.ok(specs.length >= 6);
    for (const spec of specs) {
      assert.ok(spec.name);
      assert.ok(spec.description.length > 20, `${spec.name} needs a real description`);
      assert.equal((spec.parameters as { type: string }).type, 'object');
    }
  });

  test('readOnly() drops everything that can change the workspace', () => {
    const names = new ToolRegistry().readOnly().names();
    assert.deepEqual(names.sort(), ['grep', 'list_dir', 'read_file']);
  });

  test('rejects an unknown tool name with the list of real ones', () => {
    assert.throws(
      () => new ToolRegistry().validateInput('teleport', {}),
      /Unknown tool "teleport"/,
    );
  });
});
