import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';

import { compactSession, shouldCompact } from '../src/agent/compaction.js';
import { Session } from '../src/agent/session.js';
import {
  findSession,
  listSessions,
  loadSnapshot,
  mostRecentSession,
  saveSnapshot,
} from '../src/agent/store.js';
import { estimateConversationTokens } from '../src/agent/tokens.js';
import { ScriptedProvider, reply, tempWorkspace, testConfig, testSession } from './helpers.js';

function storeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sable-store-'));
}

function exchange(session: Session, userText: string, assistantText: string): void {
  session.append({ role: 'user', content: [{ type: 'text', text: userText }] });
  session.append({ role: 'assistant', content: [{ type: 'text', text: assistantText }] });
  session.countTurn();
}

describe('Session', () => {
  test('trims only at a clean exchange boundary', () => {
    const session = testSession('/work');

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

  test('derives a title from the first user message', () => {
    const session = testSession('/work');
    exchange(session, 'fix the flaky parser test', 'done');

    assert.equal(session.title(), 'fix the flaky parser test');
  });

  test('round-trips through a snapshot', () => {
    const session = testSession('/work');
    exchange(session, 'hello', 'hi');
    session.recordUsage({
      inputTokens: 5,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    const restored = new Session({ provider: 'scripted', model: 'other', workspaceRoot: '/work' });
    restored.restore(session.snapshot());

    assert.equal(restored.history().length, 2);
    assert.equal(restored.totals().turns, 1);
    assert.equal(restored.totals().usage.inputTokens, 5);
    assert.equal(restored.getModel(), 'test-model');
  });
});

describe('token estimation', () => {
  test('grows with the size of the conversation', () => {
    const small = estimateConversationTokens([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ]);
    const large = estimateConversationTokens([
      { role: 'user', content: [{ type: 'text', text: 'x'.repeat(4000) }] },
    ]);

    assert.ok(large > small * 10);
  });

  test('counts tool results, which is where context actually goes', () => {
    const withResult = estimateConversationTokens([
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 't', content: 'y'.repeat(4000), isError: false },
        ],
      },
    ]);

    assert.ok(withResult > 900);
  });
});

describe('compaction', () => {
  test('does not fire below the threshold', () => {
    const session = testSession('/work');
    exchange(session, 'hello', 'hi');

    assert.equal(shouldCompact(session, testConfig('/work', { compactAtTokens: 100_000 })), false);
  });

  test('fires once the conversation is large enough', () => {
    const session = testSession('/work');
    exchange(session, 'x'.repeat(8000), 'y'.repeat(8000));

    assert.equal(shouldCompact(session, testConfig('/work', { compactAtTokens: 1000 })), true);
  });

  test('replaces old messages with a summary and keeps recent ones', async () => {
    const root = tempWorkspace({});
    const session = testSession(root);

    for (let index = 0; index < 8; index++) {
      exchange(session, `question ${index}`, `answer ${index}`);
    }

    const provider = new ScriptedProvider([reply('Earlier: the user asked eight questions.')]);
    const result = await compactSession({
      session,
      provider,
      config: testConfig(root),
      keepRecent: 4,
    });

    assert.equal(result.compacted, true);
    assert.ok(result.removedMessages >= 8);
    assert.ok(result.tokensAfter < result.tokensBefore);

    const history = session.history();
    assert.match(
      history[0]?.content[0]?.type === 'text' ? history[0].content[0].text : '',
      /compacted/,
    );
    assert.equal(
      history.at(-1)?.content[0]?.type === 'text' ? history.at(-1)?.role : '',
      'assistant',
    );
  });

  test('refuses to compact a conversation that is barely started', async () => {
    const root = tempWorkspace({});
    const session = testSession(root);
    exchange(session, 'hello', 'hi');

    const result = await compactSession({
      session,
      provider: new ScriptedProvider([reply('summary')]),
      config: testConfig(root),
    });

    assert.equal(result.compacted, false);
    assert.match(result.reason ?? '', /Not enough history/);
  });

  test('leaves history untouched when the model returns nothing', async () => {
    const root = tempWorkspace({});
    const session = testSession(root);

    for (let index = 0; index < 8; index++) {
      exchange(session, `question ${index}`, `answer ${index}`);
    }
    const before = session.history().length;

    const result = await compactSession({
      session,
      provider: new ScriptedProvider([reply('')]),
      config: testConfig(root),
      keepRecent: 4,
    });

    assert.equal(result.compacted, false);
    assert.equal(session.history().length, before);
  });

  test('does not send tools to the summariser', async () => {
    const root = tempWorkspace({});
    const session = testSession(root);

    for (let index = 0; index < 8; index++) {
      exchange(session, `question ${index}`, `answer ${index}`);
    }

    const provider = new ScriptedProvider([reply('summary')]);
    await compactSession({ session, provider, config: testConfig(root), keepRecent: 4 });

    assert.deepEqual(provider.requests[0]?.tools, []);
  });
});

describe('session store', () => {
  test('saves and loads a snapshot', () => {
    const directory = storeDir();
    const session = testSession('/work');
    exchange(session, 'hello', 'hi');

    saveSnapshot(session.snapshot(), directory);
    const loaded = loadSnapshot(session.id, directory);

    assert.equal(loaded?.id, session.id);
    assert.equal(loaded?.messages.length, 2);
  });

  test('lists sessions newest first', () => {
    const directory = storeDir();

    const older = testSession('/work');
    exchange(older, 'older', 'x');
    saveSnapshot(
      { ...older.snapshot(), updatedAt: new Date(Date.now() - 60_000).toISOString() },
      directory,
    );

    const newer = testSession('/work');
    exchange(newer, 'newer', 'x');
    saveSnapshot(newer.snapshot(), directory);

    const listed = listSessions(10, directory);

    assert.equal(listed[0]?.id, newer.id);
    assert.equal(listed[1]?.id, older.id);
  });

  test('finds a session by id prefix', () => {
    const directory = storeDir();
    const session = testSession('/work');
    exchange(session, 'hello', 'hi');
    saveSnapshot(session.snapshot(), directory);

    const found = findSession(session.id.slice(0, 8), directory);

    assert.equal(found?.id, session.id);
  });

  test('picks the most recent session for a workspace', () => {
    const directory = storeDir();

    const elsewhere = new Session({ provider: 'p', model: 'm', workspaceRoot: '/other' });
    exchange(elsewhere, 'elsewhere', 'x');
    saveSnapshot(elsewhere.snapshot(), directory);

    const here = new Session({ provider: 'p', model: 'm', workspaceRoot: '/work' });
    exchange(here, 'here', 'x');
    saveSnapshot(here.snapshot(), directory);

    assert.equal(mostRecentSession('/work', directory)?.id, here.id);
    assert.equal(mostRecentSession('/nowhere', directory), null);
  });

  test('ignores corrupt files instead of failing the listing', () => {
    const directory = storeDir();
    fs.writeFileSync(path.join(directory, 'broken.json'), '{ not json');

    assert.deepEqual(listSessions(10, directory), []);
  });
});
