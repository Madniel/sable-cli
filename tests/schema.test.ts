import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { objectSchema, validate } from '../src/tools/schema.js';

const schema = objectSchema(
  {
    path: { type: 'string', description: 'a path' },
    limit: { type: 'integer', description: 'a count', default: 10, minimum: 1, maximum: 100 },
    deep: { type: 'boolean', description: 'a flag', default: false },
    mode: { type: 'string', description: 'a mode', enum: ['fast', 'slow'] },
    names: { type: 'array', description: 'names', items: { type: 'string' } },
  },
  ['path'],
);

describe('validate', () => {
  test('applies declared defaults', () => {
    const result = validate(schema, { path: 'a.ts' }, 'demo');
    assert.deepEqual(result, { path: 'a.ts', limit: 10, deep: false });
  });

  test('rejects a missing required argument', () => {
    assert.throws(() => validate(schema, {}, 'demo'), /missing required argument "path"/);
  });

  test('rejects unknown arguments and names the accepted ones', () => {
    assert.throws(
      () => validate(schema, { path: 'a', nope: 1 }, 'demo'),
      /unknown argument\(s\) "nope"/,
    );
  });

  test('coerces numeric strings, because models send them', () => {
    const result = validate(schema, { path: 'a', limit: '25' }, 'demo');
    assert.equal(result['limit'], 25);
  });

  test('enforces numeric bounds', () => {
    assert.throws(() => validate(schema, { path: 'a', limit: 0 }, 'demo'), /at least 1/);
    assert.throws(() => validate(schema, { path: 'a', limit: 500 }, 'demo'), /at most 100/);
  });

  test('enforces enums', () => {
    assert.throws(
      () => validate(schema, { path: 'a', mode: 'sideways' }, 'demo'),
      /one of: fast, slow/,
    );
  });

  test('checks array item types', () => {
    assert.throws(() => validate(schema, { path: 'a', names: ['ok', 3] }, 'demo'), /"names\[1\]"/);
  });

  test('accepts boolean strings', () => {
    assert.equal(validate(schema, { path: 'a', deep: 'true' }, 'demo')['deep'], true);
  });

  test('reports malformed tool JSON in a way the model can act on', () => {
    assert.throws(
      () => validate(schema, { __malformed_json__: '{"path": ' }, 'demo'),
      /not valid JSON/,
    );
  });

  test('rejects non-objects', () => {
    assert.throws(() => validate(schema, 'a string', 'demo'), /expected an object/);
    assert.throws(() => validate(schema, ['a'], 'demo'), /expected an object/);
  });
});
