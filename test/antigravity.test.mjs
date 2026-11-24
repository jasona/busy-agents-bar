import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AntigravityProvider } from '../src/providers/antigravity/index.mjs';
import { clearTranscriptCache } from '../src/providers/antigravity/transcript.mjs';

function makeTempAntigravityRoot() {
  const root = mkdtempSync(join(tmpdir(), 'busy-bar-ag-'));
  const appData = join(root, 'antigravity');
  const projectsDir = join(root, 'projects');
  mkdirSync(join(appData, 'brain'), { recursive: true });
  mkdirSync(projectsDir, { recursive: true });
  return { root, appData, projectsDir };
}

function writeProject(projectsDir, id, name, workspacePath) {
  writeFileSync(
    join(projectsDir, `${id}.json`),
    JSON.stringify({
      id,
      name,
      projectResources: {
        resources: [{ folderUri: `file://${workspacePath}` }],
      },
    }),
    'utf-8'
  );
}

function writeTranscript(appData, convId, lines, mtimeSec) {
  const logsDir = join(appData, 'brain', convId, '.system_generated', 'logs');
  mkdirSync(logsDir, { recursive: true });
  const filePath = join(logsDir, 'transcript.jsonl');
  writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
  if (mtimeSec) {
    utimesSync(filePath, mtimeSec, mtimeSec);
    utimesSync(join(appData, 'brain', convId), mtimeSec, mtimeSec);
  }
  return filePath;
}

test('AntigravityProvider classifies running, ask_question, approval, error/quota, stuck, done, and stale', async () => {
  clearTranscriptCache();
  const { root, appData, projectsDir } = makeTempAntigravityRoot();
  const now = 1_700_000_000_000;
  const nowSec = Math.floor(now / 1000);

  try {
    writeProject(projectsDir, 'proj-1', 'my-app', '/workspace/my-app');

    // 1. Running session + torn trailing line tolerance
    writeTranscript(
      appData,
      '11111111-1111-1111-1111-111111111111',
      [
        JSON.stringify({ type: 'USER_INPUT', created_at: new Date(now - 20_000).toISOString(), content: 'Build feature' }),
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          created_at: new Date(now - 5_000).toISOString(),
          tool_calls: [{ name: 'run_command', args: { CommandLine: '"/workspace/my-app/test.sh"' } }],
        }),
        '{"type":"GENERIC","truncated',
      ],
      nowSec - 5
    );

    // 2. Waiting on ask_question
    writeTranscript(
      appData,
      '22222222-2222-2222-2222-222222222222',
      [
        JSON.stringify({ type: 'USER_INPUT', content: 'Deploy?' }),
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          tool_calls: [{ name: 'ask_question', args: { question: 'Which environment?' } }],
        }),
        JSON.stringify({ type: 'GENERIC', status: 'WAITING' }),
      ],
      nowSec - 10
    );

    // 3. Waiting on tool approval
    writeTranscript(
      appData,
      '33333333-3333-3333-3333-333333333333',
      [
        JSON.stringify({ type: 'USER_INPUT', content: 'Run migration' }),
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          status: 'WAITING',
          tool_calls: [{ name: 'run_command', args: { CommandLine: '"rm -rf build"' } }],
        }),
      ],
      nowSec - 15
    );

    // 4. Quota error (ERROR_MESSAGE)
    writeTranscript(
      appData,
      '44444444-4444-4444-4444-444444444444',
      [
        JSON.stringify({ type: 'USER_INPUT', content: 'Analyze' }),
        JSON.stringify({ type: 'ERROR_MESSAGE', error: '429 RESOURCE_EXHAUSTED quota limit' }),
      ],
      nowSec - 20
    );

    // 5. Stuck running (> stuckAfterMs with no progress)
    writeTranscript(
      appData,
      '55555555-5555-5555-5555-555555555555',
      [
        JSON.stringify({ type: 'USER_INPUT', content: 'Long task' }),
        JSON.stringify({ type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'run_command', args: { CommandLine: '"sleep 999"' } }] }),
      ],
      nowSec - 700
    );

    // 6. Done session
    writeTranscript(
      appData,
      '66666666-6666-6666-6666-666666666666',
      [
        JSON.stringify({ type: 'USER_INPUT', content: 'Fix bug' }),
        JSON.stringify({ type: 'PLANNER_RESPONSE', tool_calls: [], content: 'All fixed!' }),
      ],
      nowSec - 30
    );

    // 7. Stale session (> staleAfterMs) should be ignored
    writeTranscript(
      appData,
      '77777777-7777-7777-7777-777777777777',
      [
        JSON.stringify({ type: 'USER_INPUT', content: 'Ancient task' }),
        JSON.stringify({ type: 'PLANNER_RESPONSE', tool_calls: [], content: 'Old' }),
      ],
      nowSec - 30_000
    );

    const provider = new AntigravityProvider({
      appDataDirs: [appData],
      projectsDir,
      stuckAfterMs: 600_000,
      staleAfterMs: 21_600_000,
    });

    const sessions = provider.poll(now);
    const byId = new Map(sessions.map((s) => [s.id, s]));

    assert.equal(byId.size, 6);
    assert.equal(byId.get('11111111-1111-1111-1111-111111111111').status, 'running');
    assert.equal(byId.get('11111111-1111-1111-1111-111111111111').project, 'my-app');

    assert.equal(byId.get('22222222-2222-2222-2222-222222222222').status, 'waiting');
    assert.equal(byId.get('22222222-2222-2222-2222-222222222222').attentionKind, 'question');

    assert.equal(byId.get('33333333-3333-3333-3333-333333333333').status, 'waiting');
    assert.equal(byId.get('33333333-3333-3333-3333-333333333333').attentionKind, 'approval');

    assert.equal(byId.get('44444444-4444-4444-4444-444444444444').status, 'error');
    assert.equal(byId.get('44444444-4444-4444-4444-444444444444').attentionKind, 'quota');

    assert.equal(byId.get('55555555-5555-5555-5555-555555555555').status, 'waiting');
    assert.equal(byId.get('55555555-5555-5555-5555-555555555555').attentionKind, 'stuck');

    assert.equal(byId.get('66666666-6666-6666-6666-666666666666').status, 'done');
    assert.equal(byId.has('77777777-7777-7777-7777-777777777777'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AntigravityProvider deduplicates swarm worker conversations and detects ready worker approval', async () => {
  clearTranscriptCache();
  const { root, appData, projectsDir } = makeTempAntigravityRoot();
  const now = 1_700_000_000_000;
  const nowSec = Math.floor(now / 1000);

  try {
    const coordId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const workerId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

    writeProject(projectsDir, 'proj-s', 'swarm-proj', '/workspace/swarm-proj');

    writeTranscript(
      appData,
      coordId,
      [
        JSON.stringify({ type: 'USER_INPUT', content: 'Orchestrate swarm' }),
        JSON.stringify({ type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'swarm_wait', args: {} }] }),
        JSON.stringify({ type: 'GENERIC', status: 'DONE' }),
      ],
      nowSec - 10
    );

    writeTranscript(
      appData,
      workerId,
      [
        JSON.stringify({ type: 'USER_INPUT', content: 'Worker task' }),
        JSON.stringify({ type: 'PLANNER_RESPONSE', tool_calls: [], content: 'Done!' }),
      ],
      nowSec - 5
    );

    const swarmDir = join(appData, 'brain', coordId, '.system_generated', 'swarm');
    mkdirSync(swarmDir, { recursive: true });
    writeFileSync(
      join(swarmDir, 'members.json'),
      JSON.stringify({
        title: 'Swarm Build',
        members: {
          coordinator: { role: 'coordinator', conversation_id: coordId },
          builder: {
            role: 'worker',
            conversation_id: workerId,
            workspace: '/workspace/swarm-proj',
            wake_mode: 'mentions',
          },
        },
      }),
      'utf-8'
    );
    writeFileSync(
      join(swarmDir, 'board.jsonl'),
      JSON.stringify({ seq: 1, agent: 'builder', text: '[done] ready for merge' }) + '\n',
      'utf-8'
    );

    const provider = new AntigravityProvider({
      appDataDirs: [appData],
      projectsDir,
    });

    const sessions = provider.poll(now);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, coordId);
    assert.equal(sessions[0].project, 'swarm-proj');
    assert.equal(sessions[0].isSwarm, true);
    assert.equal(sessions[0].status, 'waiting');
    assert.equal(sessions[0].attentionKind, 'approval');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
