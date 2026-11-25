import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  CLAUDE_HOOK_EVENTS,
  CODEX_HOOK_EVENTS,
  PHOENIX_HOOK_EVENTS,
  installHooksForTargets,
} from '../src/providers/hooks-install.mjs';

test('installHooksForTargets merges cleanly, is idempotent, honors dryRun, and uninstalls safely', () => {
  const home = mkdtempSync(join(tmpdir(), 'busy-bar-hooks-'));
  const binPath = '/home/jason/coding/busy-bar/bin/busy-bar.mjs';
  const nodeBin = '/usr/bin/node';

  try {
    // Seed existing Claude settings, Codex hooks, and Antigravity hooks
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify(
        {
          model: 'sonnet',
          hooks: {
            PreToolUse: [
              {
                matcher: 'Bash',
                hooks: [{ type: 'command', command: 'rtk hook claude' }],
              },
            ],
            Stop: [
              {
                hooks: [{ type: 'command', command: 'impeccable hook', timeout: 30 }],
              },
            ],
          },
        },
        null,
        2
      ),
      'utf-8'
    );

    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(
      join(home, '.codex', 'hooks.json'),
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: 'Bash',
                hooks: [{ type: 'command', command: 'rtk hook codex' }],
              },
            ],
          },
        },
        null,
        2
      ),
      'utf-8'
    );

    mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
    writeFileSync(
      join(home, '.gemini', 'config', 'hooks.json'),
      JSON.stringify({ 'other-hook': { Stop: [{ type: 'command', command: 'echo ok' }] } }, null, 2),
      'utf-8'
    );

    mkdirSync(join(home, '.phoenix', 'userdata'), { recursive: true });
    writeFileSync(
      join(home, '.phoenix', 'userdata', 'hooks.json'),
      JSON.stringify(
        {
          hooks: {
            Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }],
          },
        },
        null,
        2
      ),
      'utf-8'
    );

    // 1. Dry-run makes no disk writes
    const dryRes = installHooksForTargets(['all'], {
      homeDir: home,
      nodeBin,
      binPath,
      dryRun: true,
    });
    assert.equal(dryRes.length, 4);
    const claudeBefore = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'));
    assert.equal(claudeBefore.hooks.UserPromptSubmit, undefined);

    // 2. Install all targets (plus alias deduplication)
    const first = installHooksForTargets(['claude-code', 'chatgpt', 'antigravity', 'phoenix-code', 't3', 'claude'], {
      homeDir: home,
      nodeBin,
      binPath,
    });
    assert.equal(first.length, 4);
    assert.ok(first.every((r) => r.changed === true));

    const claudeAfter = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'));
    assert.equal(claudeAfter.model, 'sonnet');
    assert.equal(claudeAfter.hooks.PreToolUse.length, 2);
    assert.equal(claudeAfter.hooks.PreToolUse[0].hooks[0].command, 'rtk hook claude');
    assert.equal(claudeAfter.hooks.Stop.length, 2);
    assert.equal(claudeAfter.hooks.Stop[0].hooks[0].command, 'impeccable hook');
    for (const ev of CLAUDE_HOOK_EVENTS) {
      assert.ok(
        claudeAfter.hooks[ev].some((g) => g.hooks.some((h) => h.command.includes('hook claude'))),
        `Missing Claude hook for ${ev}`
      );
    }

    const codexAfter = JSON.parse(readFileSync(join(home, '.codex', 'hooks.json'), 'utf-8'));
    assert.equal(codexAfter.hooks.PreToolUse.length, 2);
    assert.equal(codexAfter.hooks.PreToolUse[0].hooks[0].command, 'rtk hook codex');
    for (const ev of CODEX_HOOK_EVENTS) {
      assert.ok(
        codexAfter.hooks[ev].some((g) => g.hooks.some((h) => h.command.includes('hook codex'))),
        `Missing Codex hook for ${ev}`
      );
    }

    const agyAfter = JSON.parse(readFileSync(join(home, '.gemini', 'config', 'hooks.json'), 'utf-8'));
    assert.ok(agyAfter['other-hook']);
    assert.ok(agyAfter['busy-bar-stop']);

    const phxAfter = JSON.parse(readFileSync(join(home, '.phoenix', 'userdata', 'hooks.json'), 'utf-8'));
    assert.equal(phxAfter.hooks.Stop.length, 2);
    assert.equal(phxAfter.hooks.Stop[0].hooks[0].command, 'notify-send done');
    for (const ev of PHOENIX_HOOK_EVENTS) {
      assert.ok(
        phxAfter.hooks[ev].some((g) => g.hooks.some((h) => h.command.includes('hook phoenix'))),
        `Missing Phoenix hook for ${ev}`
      );
    }

    // 3. Re-running install is completely idempotent (changed === false, no duplicates)
    const second = installHooksForTargets(['all'], { homeDir: home, nodeBin, binPath });
    assert.ok(second.every((r) => r.changed === false));
    const claudeRe = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'));
    assert.equal(claudeRe.hooks.PreToolUse.length, 2);

    // 4. Uninstall removes only managed hooks and preserves rtk, impeccable, notify-send, and other-hook
    const un = installHooksForTargets(['all'], { homeDir: home, nodeBin, binPath, uninstall: true });
    assert.ok(un.every((r) => r.changed === true));

    const claudeUn = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'));
    assert.equal(claudeUn.model, 'sonnet');
    assert.equal(claudeUn.hooks.PreToolUse.length, 1);
    assert.equal(claudeUn.hooks.PreToolUse[0].hooks[0].command, 'rtk hook claude');
    assert.equal(claudeUn.hooks.Stop.length, 1);
    assert.equal(claudeUn.hooks.Stop[0].hooks[0].command, 'impeccable hook');
    assert.equal(claudeUn.hooks.UserPromptSubmit, undefined);

    const codexUn = JSON.parse(readFileSync(join(home, '.codex', 'hooks.json'), 'utf-8'));
    assert.equal(codexUn.hooks.PreToolUse.length, 1);
    assert.equal(codexUn.hooks.PreToolUse[0].hooks[0].command, 'rtk hook codex');
    assert.equal(codexUn.hooks.Stop, undefined);

    const agyUn = JSON.parse(readFileSync(join(home, '.gemini', 'config', 'hooks.json'), 'utf-8'));
    assert.ok(agyUn['other-hook']);
    assert.equal(agyUn['busy-bar-stop'], undefined);

    const phxUn = JSON.parse(readFileSync(join(home, '.phoenix', 'userdata', 'hooks.json'), 'utf-8'));
    assert.equal(phxUn.hooks.Stop.length, 1);
    assert.equal(phxUn.hooks.Stop[0].hooks[0].command, 'notify-send done');
    assert.equal(phxUn.hooks.UserPromptSubmit, undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('installHooksForTargets creates parent dirs when files do not yet exist', () => {
  const home = mkdtempSync(join(tmpdir(), 'busy-bar-hooks-empty-'));
  try {
    const res = installHooksForTargets(['claude', 'codex'], {
      homeDir: home,
      nodeBin: '/usr/bin/node',
      binPath: '/app/bin/busy-bar.mjs',
    });
    assert.equal(res.length, 2);
    assert.equal(existsSync(join(home, '.claude', 'settings.json')), true);
    assert.equal(existsSync(join(home, '.codex', 'hooks.json')), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
