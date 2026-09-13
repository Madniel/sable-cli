import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { describe } from 'node:test';

import { Agent } from '../src/agent/loop.js';
import { ApprovalPolicy } from '../src/approval/policy.js';
import type { CompletionResult } from '../src/providers/types.js';
import { ToolRegistry } from '../src/tools/registry.js';
import {
  ScriptedProvider,
  callTool,
  reply,
  tempWorkspace,
  testConfig,
  testSession,
} from './helpers.js';
import type { Config } from '../src/config/config.js';

function buildAgent(
  root: string,
  script: CompletionResult[],
  approval: ApprovalPolicy = new ApprovalPolicy('yolo'),
  configOverrides: Partial<Config> = {},
) {
  const config = testConfig(root, { approval: approval.getMode(), ...configOverrides });
  const provider = new ScriptedProvider(script);
  const session = testSession(root);
  const agent = new Agent({ config, provider, tools: new ToolRegistry(), approval, session });

  return { agent, provider, session, config };
}

function lastToolResult(provider: ScriptedProvider, requestIndex: number) {
  const block = provider.requests[requestIndex]?.messages.at(-1)?.content[0];
  return block?.type === 'tool_result' ? block : null;
}

describe('Agent.run', () => {
  test('returns the model text when no tools are requested', async () => {
    const root = tempWorkspace({});
    const { agent, session } = buildAgent(root, [reply('All done.')]);

    const result = await agent.run('hello');

    assert.equal(result.text, 'All done.');
    assert.equal(result.steps, 1);
    assert.equal(result.exhausted, false);
    assert.equal(session.history().length, 2);
  });

  test('executes a tool call and feeds the result back', async () => {
    const root = tempWorkspace({ 'a.txt': 'contents here' });
    const { agent, provider } = buildAgent(root, [
      callTool('t1', 'read_file', { path: 'a.txt' }),
      reply('The file says "contents here".'),
    ]);

    const started: string[] = [];
    const ended: boolean[] = [];

    const result = await agent.run('read a.txt', {
      onToolStart: ({ name }) => started.push(name),
      onToolEnd: ({ ok }) => ended.push(ok),
    });

    assert.deepEqual(started, ['read_file']);
    assert.deepEqual(ended, [true]);
    assert.equal(result.steps, 2);
    assert.match(lastToolResult(provider, 1)?.content ?? '', /contents here/);
  });

  test('hands a validation error back to the model instead of throwing', async () => {
    const root = tempWorkspace({});
    const { agent, provider } = buildAgent(root, [
      callTool('t1', 'read_file', { wrong: 'argument' }),
      reply('Sorry, retrying.'),
    ]);

    await agent.run('go');

    const result = lastToolResult(provider, 1);
    assert.equal(result?.isError, true);
    assert.match(result?.content ?? '', /unknown argument/);
  });

  test('an unknown tool name comes back as a recoverable error', async () => {
    const root = tempWorkspace({});
    const { agent, provider } = buildAgent(root, [
      callTool('t1', 'launch_missiles', {}),
      reply('Understood.'),
    ]);

    await agent.run('go');

    assert.match(lastToolResult(provider, 1)?.content ?? '', /Unknown tool "launch_missiles"/);
  });

  test('readonly mode refuses writes and explains why', async () => {
    const root = tempWorkspace({});
    const { agent, provider } = buildAgent(
      root,
      [callTool('t1', 'write_file', { path: 'x.txt', content: 'nope' }), reply('Understood.')],
      new ApprovalPolicy('readonly'),
    );

    await agent.run('write a file');

    assert.equal(fs.existsSync(path.join(root, 'x.txt')), false);
    assert.match(lastToolResult(provider, 1)?.content ?? '', /read-only mode/);
  });

  test('runs several tool calls from one response in order', async () => {
    const root = tempWorkspace({ 'a.txt': 'A', 'b.txt': 'B' });
    const provider = new ScriptedProvider([
      {
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.txt' } },
            { type: 'tool_use', id: 't2', name: 'read_file', input: { path: 'b.txt' } },
          ],
        },
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      reply('Both read.'),
    ]);

    const config = testConfig(root);
    const session = testSession(root);
    const agent = new Agent({
      config,
      provider,
      tools: new ToolRegistry(),
      approval: new ApprovalPolicy('yolo'),
      session,
    });

    await agent.run('read both');

    const results = provider.requests[1]?.messages.at(-1)?.content ?? [];
    assert.equal(results.length, 2);
    assert.equal(results[0]?.type === 'tool_result' ? results[0].toolUseId : '', 't1');
    assert.equal(results[1]?.type === 'tool_result' ? results[1].toolUseId : '', 't2');
  });

  test('remembers reads across steps so edits are not blocked', async () => {
    const root = tempWorkspace({ 'a.txt': 'original\n' });
    const { agent } = buildAgent(root, [
      callTool('t1', 'read_file', { path: 'a.txt' }),
      callTool('t2', 'edit_file', { path: 'a.txt', old_string: 'original', new_string: 'edited' }),
      reply('Done.'),
    ]);

    await agent.run('edit it');

    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'edited\n');
  });

  test('stops at maxSteps rather than looping forever', async () => {
    const root = tempWorkspace({ 'a.txt': 'x' });
    const script = Array.from({ length: 10 }, (_, i) =>
      callTool(`t${i}`, 'read_file', { path: 'a.txt' }),
    );
    const { agent } = buildAgent(root, script, new ApprovalPolicy('yolo'), { maxSteps: 3 });

    const notices: string[] = [];
    const result = await agent.run('loop', { onNotice: (message) => notices.push(message) });

    assert.equal(result.steps, 3);
    assert.equal(result.exhausted, true);
    assert.match(notices.join(' '), /Stopped after 3 steps/);
  });

  test('accumulates usage across steps', async () => {
    const root = tempWorkspace({ 'a.txt': 'x' });
    const { agent, session } = buildAgent(root, [
      callTool('t1', 'read_file', { path: 'a.txt' }),
      reply('done'),
    ]);

    await agent.run('go');
    const totals = session.totals();

    assert.equal(totals.usage.inputTokens, 20);
    assert.equal(totals.usage.outputTokens, 10);
    assert.equal(totals.turns, 1);
  });

  test('an abort signal stops the turn', async () => {
    const root = tempWorkspace({});
    const { agent } = buildAgent(root, [reply('never reached')]);
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(() => agent.run('go', {}, controller.signal), /cancelled/i);
  });

  test('notifies when a turn completes so the session can be saved', async () => {
    const root = tempWorkspace({});
    const config = testConfig(root);
    const session = testSession(root);
    let saved = 0;

    const agent = new Agent({
      config,
      provider: new ScriptedProvider([reply('done')]),
      tools: new ToolRegistry(),
      approval: new ApprovalPolicy('yolo'),
      session,
      onTurnComplete: () => saved++,
    });

    await agent.run('go');

    assert.equal(saved, 1);
  });
});

describe('ApprovalPolicy', () => {
  test('read tools never prompt', async () => {
    const policy = new ApprovalPolicy('prompt');
    const outcome = await policy.confirm({ toolName: 'read_file', kind: 'read', summary: 'read' });

    assert.equal(outcome, 'once');
  });

  test('auto-edit lets writes through but still asks about commands', async () => {
    let asked = 0;
    const policy = new ApprovalPolicy('auto-edit', {
      async ask() {
        asked++;
        return 'once';
      },
    });

    assert.equal(
      await policy.confirm({ toolName: 'write_file', kind: 'write', summary: 'w' }),
      'once',
    );
    assert.equal(asked, 0);

    assert.equal(
      await policy.confirm({ toolName: 'shell', kind: 'execute', summary: 's' }),
      'once',
    );
    assert.equal(asked, 1);
  });

  test('"always" is remembered for the rest of the session', async () => {
    let asked = 0;
    const policy = new ApprovalPolicy('prompt', {
      async ask() {
        asked++;
        return 'always';
      },
    });

    await policy.confirm({ toolName: 'shell', kind: 'execute', summary: 's' });
    await policy.confirm({ toolName: 'shell', kind: 'execute', summary: 's' });

    assert.equal(asked, 1);
    assert.deepEqual(policy.allowlist(), ['shell']);
  });

  test('with nobody to ask, the answer is no', async () => {
    const policy = new ApprovalPolicy('prompt', null);

    assert.equal(
      await policy.confirm({ toolName: 'shell', kind: 'execute', summary: 's' }),
      'reject',
    );
  });

  test('readonly refuses even when a prompt exists', async () => {
    const policy = new ApprovalPolicy('readonly', {
      async ask() {
        throw new Error('should not be asked');
      },
    });

    assert.equal(
      await policy.confirm({ toolName: 'write_file', kind: 'write', summary: 'w' }),
      'reject',
    );
  });
});
