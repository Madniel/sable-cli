import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { describe } from 'node:test';

import { editFileTool } from '../src/tools/edit-file.js';
import { FileTracker } from '../src/tools/file-tracker.js';
import { globTool } from '../src/tools/glob.js';
import { globToRegExp } from '../src/tools/glob-pattern.js';
import { grepTool } from '../src/tools/grep.js';
import { listDirTool } from '../src/tools/list-dir.js';
import { multiEditTool } from '../src/tools/multi-edit.js';
import { readFileTool } from '../src/tools/read-file.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { shellTool } from '../src/tools/shell.js';
import { writeFileTool } from '../src/tools/write-file.js';
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

  test('records the read so later edits can detect drift', async () => {
    const root = tempWorkspace({ 'a.txt': 'x' });
    const context = testContext(root);

    await readFileTool.run({ path: 'a.txt' }, context);

    assert.ok(context.files.hasSeen(path.join(root, 'a.txt')));
  });
});

describe('write_file', () => {
  test('creates a file and its parent directories', async () => {
    const root = tempWorkspace({});
    const context = testContext(root);

    const result = await writeFileTool.run({ path: 'src/new/a.ts', content: 'x\n' }, context);

    assert.equal(result.isError, undefined);
    assert.equal(fs.readFileSync(path.join(root, 'src/new/a.ts'), 'utf8'), 'x\n');
    assert.equal(context.confirmations.length, 1);
  });

  test('a refusal aborts the write', async () => {
    const root = tempWorkspace({ 'a.txt': 'keep' });
    const context = testContext(root, { answer: 'reject' });

    await assert.rejects(
      () => writeFileTool.run({ path: 'a.txt', content: 'clobber' }, context),
      /declined/,
    );
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'keep');
  });

  test('a no-op write does not even ask', async () => {
    const root = tempWorkspace({ 'a.txt': 'same' });
    const context = testContext(root);

    const result = await writeFileTool.run({ path: 'a.txt', content: 'same' }, context);

    assert.match(result.output, /No change/);
    assert.equal(context.confirmations.length, 0);
  });

  test('shows a diff in the approval prompt when overwriting', async () => {
    const root = tempWorkspace({ 'a.txt': 'old line\n' });
    const context = testContext(root);

    await writeFileTool.run({ path: 'a.txt', content: 'new line\n' }, context);

    assert.match(context.confirmations[0]?.detail ?? '', /^-old line$/m);
    assert.match(context.confirmations[0]?.detail ?? '', /^\+new line$/m);
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

  test('refuses to edit a file that changed since it was read', async () => {
    const root = tempWorkspace({ 'a.ts': 'original\n' });
    const files = new FileTracker();
    const context = testContext(root, { files });

    await readFileTool.run({ path: 'a.ts' }, context);

    const file = path.join(root, 'a.ts');
    fs.writeFileSync(file, 'changed by someone else\n');
    fs.utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));

    const result = await editFileTool.run(
      { path: 'a.ts', old_string: 'changed', new_string: 'edited' },
      context,
    );

    assert.equal(result.isError, true);
    assert.match(result.output, /changed on disk/);
  });
});

describe('multi_edit', () => {
  test('applies every edit in order', async () => {
    const root = tempWorkspace({ 'a.ts': 'one\ntwo\nthree\n' });

    const result = await multiEditTool.run(
      {
        path: 'a.ts',
        edits: [
          { old_string: 'one', new_string: '1' },
          { old_string: 'three', new_string: '3' },
        ],
      },
      testContext(root),
    );

    assert.equal(result.isError, undefined);
    assert.equal(fs.readFileSync(path.join(root, 'a.ts'), 'utf8'), '1\ntwo\n3\n');
  });

  test('writes nothing when any edit fails', async () => {
    const root = tempWorkspace({ 'a.ts': 'one\ntwo\n' });

    const result = await multiEditTool.run(
      {
        path: 'a.ts',
        edits: [
          { old_string: 'one', new_string: '1' },
          { old_string: 'missing', new_string: 'x' },
        ],
      },
      testContext(root),
    );

    assert.equal(result.isError, true);
    assert.match(result.output, /edit 2/);
    assert.equal(fs.readFileSync(path.join(root, 'a.ts'), 'utf8'), 'one\ntwo\n');
  });

  test('later edits see the result of earlier ones', async () => {
    const root = tempWorkspace({ 'a.ts': 'alpha\n' });

    await multiEditTool.run(
      {
        path: 'a.ts',
        edits: [
          { old_string: 'alpha', new_string: 'beta' },
          { old_string: 'beta', new_string: 'gamma' },
        ],
      },
      testContext(root),
    );

    assert.equal(fs.readFileSync(path.join(root, 'a.ts'), 'utf8'), 'gamma\n');
  });

  test('rejects malformed edit entries', async () => {
    const root = tempWorkspace({ 'a.ts': 'x' });

    await assert.rejects(
      () => multiEditTool.run({ path: 'a.ts', edits: [{ old_string: 'x' }] }, testContext(root)),
      /needs string "old_string" and "new_string"/,
    );
  });

  test('rejects an empty edit list', async () => {
    const root = tempWorkspace({ 'a.ts': 'x' });

    await assert.rejects(
      () => multiEditTool.run({ path: 'a.ts', edits: [] }, testContext(root)),
      /non-empty array/,
    );
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

describe('glob', () => {
  test('finds files matching a pattern', async () => {
    const root = tempWorkspace({ 'src/a.ts': '', 'src/deep/b.ts': '', 'docs/c.md': '' });

    const result = await globTool.run({ pattern: '**/*.ts' }, testContext(root));

    assert.match(result.output, /src\/a\.ts/);
    assert.match(result.output, /src\/deep\/b\.ts/);
    assert.doesNotMatch(result.output, /c\.md/);
  });

  test('supports brace alternatives', async () => {
    const root = tempWorkspace({ 'a.ts': '', 'b.tsx': '', 'c.js': '' });

    const result = await globTool.run({ pattern: '*.{ts,tsx}' }, testContext(root));

    assert.match(result.output, /a\.ts/);
    assert.match(result.output, /b\.tsx/);
    assert.doesNotMatch(result.output, /c\.js/);
  });

  test('returns newest files first', async () => {
    const root = tempWorkspace({ 'old.ts': '', 'new.ts': '' });
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(root, 'old.ts'), past, past);

    const result = await globTool.run({ pattern: '*.ts' }, testContext(root));

    assert.ok(result.output.indexOf('new.ts') < result.output.indexOf('old.ts'));
  });

  test('reports no matches without erroring', async () => {
    const root = tempWorkspace({ 'a.ts': '' });
    const result = await globTool.run({ pattern: '*.py' }, testContext(root));

    assert.equal(result.isError, undefined);
    assert.match(result.output, /No files matching/);
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

  test('includes surrounding lines when asked', async () => {
    const root = tempWorkspace({ 'a.ts': 'before\nneedle\nafter\n' });
    const result = await grepTool.run({ pattern: 'needle', context_lines: 1 }, testContext(root));

    assert.match(result.output, /before/);
    assert.match(result.output, /> 2: needle/);
    assert.match(result.output, /after/);
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
    assert.ok(globToRegExp('*.{ts,tsx}').test('a.tsx'));
    assert.ok(!globToRegExp('*.{ts,tsx}').test('a.js'));
  });

  test('treats dots as literals rather than wildcards', () => {
    assert.ok(!globToRegExp('*.ts').test('axts'));
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

  test('flags risky commands in the approval prompt', async () => {
    const root = tempWorkspace({});
    const context = testContext(root);

    await shellTool.run({ command: 'rm -rf build' }, context);

    assert.match(context.confirmations[0]?.detail ?? '', /recursive or forced delete/);
  });
});

describe('ToolRegistry', () => {
  test('exposes schemas for every tool', () => {
    const specs = new ToolRegistry().specs();

    assert.ok(specs.length >= 8);
    for (const spec of specs) {
      assert.ok(spec.name);
      assert.ok(spec.description.length > 20, `${spec.name} needs a real description`);
      assert.equal((spec.parameters as { type: string }).type, 'object');
    }
  });

  test('readOnly() drops everything that can change the workspace', () => {
    const names = new ToolRegistry().readOnly().names().sort();

    assert.deepEqual(names, ['glob', 'grep', 'list_dir', 'read_file']);
  });

  test('rejects an unknown tool name with the list of real ones', () => {
    assert.throws(
      () => new ToolRegistry().validateInput('teleport', {}),
      /Unknown tool "teleport"/,
    );
  });
});

describe('FileTracker', () => {
  test('detects a file that changed after it was recorded', () => {
    const root = tempWorkspace({ 'a.txt': 'one' });
    const file = path.join(root, 'a.txt');
    const tracker = new FileTracker();

    tracker.record(file);
    assert.equal(tracker.changedSinceRead(file), false);

    fs.writeFileSync(file, 'two');
    fs.utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));

    assert.equal(tracker.changedSinceRead(file), true);
  });

  test('says nothing changed for a file it never saw', () => {
    const root = tempWorkspace({ 'a.txt': 'one' });

    assert.equal(new FileTracker().changedSinceRead(path.join(root, 'a.txt')), false);
  });

  test('treats a deleted file as changed', () => {
    const root = tempWorkspace({ 'a.txt': 'one' });
    const file = path.join(root, 'a.txt');
    const tracker = new FileTracker();

    tracker.record(file);
    fs.rmSync(file);

    assert.equal(tracker.changedSinceRead(file), true);
  });
});
