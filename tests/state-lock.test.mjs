import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { acquireImportLock, joinImportLock } from '../lib/lock.mjs';
import { approveFailure, cardRange, consumeFailureApproval, isBlocked, latestSlot, loadState, recordTarget, saveState } from '../lib/state.mjs';
import { stateFixture, temp, time } from './phase-fixtures.mjs';

test('only a confirmed contiguous interval advances atomically', (t) => {
  const filepath = path.join(temp(t, 'state'), 'last-run.json');
  const state = stateFixture();
  saveState(filepath, state);
  const original = readFileSync(filepath);
  const range = { from: '2026-11-23', to: '2026-11-24' };
  assert.throws(() => recordTarget(state, 'credit-card', 'smbc', { outcome: 'success', range, verifiedThrough: range.to, at: time }), /NONCONTIGUOUS_RANGE/);
  state.schema_version = 3;
  assert.throws(() => saveState(filepath, state), /INVALID_STATE/);
  assert.deepEqual(readFileSync(filepath), original);
  state.schema_version = 2;
  range.from = '2026-11-22';
  recordTarget(state, 'credit-card', 'smbc', { outcome: 'success', range, verifiedThrough: range.to, at: time });
  saveState(filepath, state);
  assert.equal(loadState(filepath).credit_card.smbc.confirmed_through, range.to);
  assert.equal(loadState(filepath).credit_card.rakuten_card.confirmed_through, '2026-11-21');
  writeFileSync(filepath, '{corrupt');
  assert.throws(() => loadState(filepath), /INVALID_STATE/);
  assert.equal(readFileSync(filepath, 'utf8'), '{corrupt');
});

test('bounded gap and Sunday slot follow JST boundaries', () => {
  const interval = cardRange('2026-09-25', '2026-01-01', '2026-11-25');
  assert.deepEqual(interval, { from: '2026-09-26', to: '2026-11-09', recovery: true, hasMore: true });
  assert.equal(cardRange('', '2026-01-01', '2026-11-25').recovery, true);
  assert.equal(cardRange('2026-11-21', '2026-01-01', '2026-11-25', true), null);
  assert.deepEqual(cardRange('2026-11-09', '2026-01-01', '2026-11-25', true, true),
    { from: '2026-11-10', to: '2026-11-24', recovery: true, hasMore: false });
  assert.equal(latestSlot(new Date('2026-11-22T12:59:59Z')), '2026-11-15');
  assert.equal(latestSlot(new Date('2026-11-22T13:00:00Z')), '2026-11-22');
  assert.equal(latestSlot(new Date('2026-11-22T23:00:00Z')), '2026-11-22');
});

test('failure approval is bound to one target and consumed before work', () => {
  const state = stateFixture();
  const range = { from: '2026-11-22', to: '2026-11-24' };
  recordTarget(state, 'credit-card', 'smbc', { outcome: 'permanent', code: 'parse', range, at: time });
  const id = state.credit_card.smbc.failure.failure_id;
  assert.equal(isBlocked(state, 'credit-card', 'smbc'), true);
  assert.throws(() => approveFailure(state, 'amazon', id, time), /FAILURE_NOT_FOUND/);
  approveFailure(state, 'credit-card', id, time);
  assert.equal(isBlocked(state, 'credit-card', 'smbc'), false);
  assert.equal(consumeFailureApproval(state, 'credit-card', 'rakuten_card'), false);
  assert.equal(consumeFailureApproval(state, 'credit-card', 'smbc'), true);
  assert.equal(isBlocked(state, 'credit-card', 'smbc'), true);
  assert.equal(state.credit_card.smbc.confirmed_through, '2026-11-21');
});

test('exclusive owner and inherited token cannot remove each other’s lock', (t) => {
  const file = path.join(temp(t, 'lock'), '.lock');
  const owner = acquireImportLock(file, 'runner');
  assert.throws(() => acquireImportLock(file, 'other'), /IMPORT_LOCKED/);
  assert.throws(() => joinImportLock(file, 'child', randomUUID()), /IMPORT_LOCKED/);
  joinImportLock(file, 'child', owner.ownerToken).release();
  assert.equal(existsSync(file), true);
  owner.release();
  assert.equal(existsSync(file), false);
});

test('a surviving child fences stale recovery and a held review flag persists', async (t) => {
  const file = path.join(temp(t, 'lease'), '.lock');
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { windowsHide: true, stdio: 'ignore' });
  const done = once(child, 'exit');
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  await once(child, 'spawn');
  const record = { owner_token: randomUUID(), pids: [child.pid], started_at: '2000-01-01T00:00:00.000Z', host: hostname(), entry: 'fixture', pending_human_review: false };
  writeFileSync(file, JSON.stringify(record));
  assert.throws(() => acquireImportLock(file, 'runner'), /IMPORT_LOCKED/);
  child.kill();
  await done;
  const replacement = acquireImportLock(file, 'runner');
  assert.equal(replacement.recovered, true);
  replacement.release();
  writeFileSync(file, JSON.stringify({ ...record, pending_human_review: true }));
  assert.throws(() => acquireImportLock(file, 'runner'), /IMPORT_LOCKED/);
});
