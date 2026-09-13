import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { buildHunks, diffLines, diffStats, splitLines, unifiedDiff } from '../src/util/diff.js';

describe('splitLines', () => {
  test('drops the trailing empty line a final newline creates', () => {
    assert.deepEqual(splitLines('a\nb\n'), ['a', 'b']);
    assert.deepEqual(splitLines('a\nb'), ['a', 'b']);
    assert.deepEqual(splitLines(''), []);
  });
});

describe('diffLines', () => {
  test('marks an unchanged file as all context', () => {
    const lines = diffLines('a\nb\n', 'a\nb\n');
    assert.ok(lines.every((line) => line.kind === 'context'));
  });

  test('reports a single changed line as one removal and one addition', () => {
    const lines = diffLines('a\nb\nc\n', 'a\nB\nc\n');
    assert.deepEqual(
      lines.map((line) => line.kind),
      ['context', 'remove', 'add', 'context'],
    );
  });

  test('keeps surrounding lines as context when inserting', () => {
    const stats = diffStats('a\nc\n', 'a\nb\nc\n');
    assert.deepEqual(stats, { added: 1, removed: 0 });
  });

  test('numbers old and new lines independently', () => {
    const lines = diffLines('a\nb\nc\n', 'a\nc\n');
    const removed = lines.find((line) => line.kind === 'remove');

    assert.equal(removed?.text, 'b');
    assert.equal(removed?.oldLine, 2);
    assert.equal(removed?.newLine, null);
  });

  test('finds the minimal edit rather than replacing everything', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 10', 'line ten');
    const stats = diffStats(before, after);

    assert.deepEqual(stats, { added: 1, removed: 1 });
  });

  test('handles a file that only gains content at the end', () => {
    assert.deepEqual(diffStats('a\n', 'a\nb\nc\n'), { added: 2, removed: 0 });
  });

  test('handles an emptied file', () => {
    assert.deepEqual(diffStats('a\nb\n', ''), { added: 0, removed: 2 });
  });
});

describe('buildHunks', () => {
  test('merges nearby changes into one hunk', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 5', 'five').replace('line 6', 'six');
    const hunks = buildHunks(diffLines(before, after), 3);

    assert.equal(hunks.length, 1);
  });

  test('keeps distant changes in separate hunks', () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 2', 'two').replace('line 30', 'thirty');
    const hunks = buildHunks(diffLines(before, after), 2);

    assert.equal(hunks.length, 2);
  });

  test('produces no hunks when nothing changed', () => {
    assert.deepEqual(buildHunks(diffLines('a\n', 'a\n'), 3), []);
  });
});

describe('unifiedDiff', () => {
  test('renders a git-style header and +/- markers', () => {
    const rendered = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n');

    assert.match(rendered, /^@@ -\d+,\d+ \+\d+,\d+ @@/m);
    assert.match(rendered, /^-b$/m);
    assert.match(rendered, /^\+B$/m);
    assert.match(rendered, /^ a$/m);
  });

  test('says so when there is nothing to show', () => {
    assert.equal(unifiedDiff('same\n', 'same\n'), '(no changes)');
  });

  test('caps very large diffs', () => {
    const before = Array.from({ length: 500 }, (_, i) => `old ${i}`).join('\n');
    const after = Array.from({ length: 500 }, (_, i) => `new ${i}`).join('\n');
    const rendered = unifiedDiff(before, after, { maxLines: 20 });

    assert.ok(rendered.split('\n').length <= 21);
    assert.match(rendered, /more diff lines/);
  });
});
