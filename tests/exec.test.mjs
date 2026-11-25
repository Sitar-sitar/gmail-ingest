import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildChildEnv } from '../lib/env.mjs';
import { runNodeStep } from '../lib/exec.mjs';

function testStep(t, script, options = {}) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'gmail ingest exec '));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const entry = path.join(cwd, 'child step.mjs');
  writeFileSync(entry, script);
  const env = buildChildEnv({
    authFile: path.join(cwd, 'fixture auth.json'),
    ordersCsv: path.join(cwd, 'orders.csv'),
    cardDb: path.join(cwd, 'credit-card.db'),
  });
  return { entry, cwd, env, ...options };
}

test('launches a real Node child in a path with spaces and captures one JSON object', async (t) => {
  let pid;
  const step = testStep(t, `
    console.error('synthetic diagnostic');
    console.log(JSON.stringify({ value: process.argv[2], pid: process.pid }));
  `, { args: ['value with spaces'], onSpawn(value) { pid = value; } });
  assert.deepEqual(await runNodeStep(step), {
    exitCode: 0, result: { value: 'value with spaces', pid }, failure: null, treeStopped: true,
  });
  assert.ok(Number.isInteger(pid));
});

test('rejects missing, malformed, decorated, or non-object stdout', async (t) => {
  for (const stdout of ['', '{', '> header\n{}', '[]', 'null', '{}\n{}']) {
    const step = testStep(t, `process.stdout.write(${JSON.stringify(stdout)});`);
    assert.deepEqual(await runNodeStep(step), {
      exitCode: 0, result: null, failure: 'invalid_stdout', treeStopped: true,
    });
  }
});

test('preserves a nonzero status even when stdout is valid JSON', async (t) => {
  const step = testStep(t, 'console.log(JSON.stringify({ status: "error" })); process.exitCode = 2;');
  assert.deepEqual(await runNodeStep(step), {
    exitCode: 2, result: { status: 'error' }, failure: null, treeStopped: true,
  });
});

test('a timeout stops the real Windows child and its descendant', { skip: process.platform !== 'win32' }, async (t) => {
  let childPid;
  const step = testStep(t, `
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    const grandchild = spawn(process.execPath, [
      '-e', 'setTimeout(() => {}, 25000)', 'gmail-ingest-timeout-test',
    ], { stdio: 'ignore' });
    grandchild.on('spawn', () => writeFileSync('grandchild.pid', String(grandchild.pid)));
    setTimeout(() => {}, 25000);
  `, { timeoutMs: 2_000, onSpawn(pid) { childPid = pid; } });
  const result = await runNodeStep(step);
  assert.equal(result.failure, 'timeout');
  assert.equal(result.treeStopped, true);
  const descendantPid = Number(readFileSync(path.join(step.cwd, 'grandchild.pid'), 'utf8'));
  assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
  for (const pid of [childPid, descendantPid]) {
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
});
