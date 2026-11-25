import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { approveCleanup, autoCleanup, createCleanupPlan, executeCleanup, retainVerifiedArtifacts } from '../lib/cleanup.mjs';
import { saveLog } from '../lib/log.mjs';
import { createRestoreSet, verifyRestoreSet } from '../lib/restore-set.mjs';
import { jstDayStartSeconds, loadState, offsetDay, recordTarget, saveState } from '../lib/state.mjs';
import { run } from '../run.mjs';
import { fingerprint, profileFixture, time } from './phase-fixtures.mjs';

function syntheticSteps(fixture, cardFaults = {}) {
  const calls = [];
  const response = (result) => ({ exitCode: 0, result, failure: null, treeStopped: true });
  const spawnStep = async ({ entry, args }) => {
    const get = (name) => args[args.indexOf(name) + 1];
    if (args.includes('--check-auth')) {
      calls.push('auth');
      return response({ gmail_profile_ok: true, account_fingerprint: cardFaults.account ?? fingerprint });
    }
    if (entry.endsWith('gmail-import-incremental.mjs')) {
      const provider = get('--provider');
      calls.push(provider);
      const fault = cardFaults[provider];
      if (fault === 'temporary') return { exitCode: 1, treeStopped: true, failure: 'invalid_stdout' };
      if (fault === 'parse') return { exitCode: 2, treeStopped: true, result: { imports: [{ failure_count: 1 }] } };
      const output = get('--ingest-run-dir');
      mkdirSync(output);
      writeFileSync(path.join(output, 'messages.jsonl'), '');
      writeFileSync(path.join(output, 'ids.json'), '{"message_ids":[]}');
      writeFileSync(path.join(output, `import-${provider}-period.json`), '{"messages":[]}');
      const from = get('--from');
      const to = get('--to');
      return response({ status: 'success', from_day: from, to_day: to, log_validation: { status: 'success' },
        ingest_bounds: { after: jstDayStartSeconds(from) - 1, before: jstDayStartSeconds(offsetDay(to, 1)), business_from: get('--business-from') },
        imports: [{ provider, failure_count: 0, raw_path: path.join(output, 'messages.jsonl'), import_path: path.join(output, `import-${provider}-period.json`),
          evidence: { searched: [], processed: [], fetched: [], payload: fault === 'mismatch' ? ['missing'] : [], applied: [], classifications: [] } }] });
    }
    if (entry.endsWith('gmail-fetch-local.mjs')) {
      calls.push('amazon-fetch');
      const output = get('--out');
      const typeAQuery = `example after:${get('--type-a-after')}`;
      const typeBQuery = `example after:${get('--type-b-after')}`;
      for (const [type, query] of [['typeA', typeAQuery], ['typeB', typeBQuery]]) {
        writeFileSync(path.join(output, `${type}-ids.json`), JSON.stringify({ type, query, message_ids: [], id_source: 'query' }));
      }
      writeFileSync(path.join(output, 'candidates.json'), JSON.stringify({ rows: [], parse_failures: [],
        typeA_query: typeAQuery, typeB_query: typeBQuery, typeA_message_count: 0, typeB_message_count: 0,
        typeB_fetched_message_count: 0, excluded_typeB_preorder_messages: 0 }));
      return response({ ok: true, ids_only: false });
    }
    calls.push('amazon-apply');
    const directory = path.join(fixture.roots.amazon, 'backups', 'orders');
    mkdirSync(directory, { recursive: true });
    const backup = path.join(directory, 'fixture-orders.csv');
    writeFileSync(backup, readFileSync(fixture.ordersCsv));
    const isolated = get('--isolated-out');
    writeFileSync(isolated, '[]');
    return response({ validation: { ok: true }, backup: { created: true, path: backup }, isolated_file: isolated,
      excluded_invalid_type: 0, excluded_invalid_row: 0, excluded_empty_order_id: 0, excluded_amount_missing_typeA: 0,
      excluded_amount_missing_typeB: 0, excluded_pending_summary: 0, replaced_rows: [], replaced_typeB_summary_rows: 0,
      isolated_amount_diff_only: 0, appended: { total: 0 }, skipped_exact: 0, candidates: { total: 0 } });
  };
  return { calls, spawnStep };
}

test('runner persists independently verified targets while permanent and repeated transient failures stay put', async (t) => {
  const fixture = profileFixture(t);
  const steps = syntheticSteps(fixture, { smbc: 'parse', rakuten_card: 'temporary' });
  const waits = [];
  const result = await run(['--profile', fixture.profile], { now: () => time, spawnStep: steps.spawnStep, wait: async (n) => waits.push(n) });
  assert.equal(result.exitCode, 2);
  assert.deepEqual(steps.calls, ['auth', 'smbc', 'rakuten_card', 'rakuten_card', 'rakuten_card', 'jcb_ekenet', 'amazon-fetch', 'amazon-apply']);
  assert.deepEqual(waits, [60_000, 300_000]);
  const state = loadState(fixture.stateFile);
  assert.equal(state.credit_card.smbc.confirmed_through, '2026-11-21');
  assert.equal(state.credit_card.rakuten_card.confirmed_through, '2026-11-21');
  assert.equal(state.credit_card.jcb_ekenet.confirmed_through, '2026-11-24');
  assert.equal(state.amazon.type_a.confirmed_through, '2026-11-24');
  assert.equal(state.last_run.completed_slot, '');
  const next = syntheticSteps(fixture);
  assert.equal((await run(['--profile', fixture.profile], { now: () => time, spawnStep: next.spawnStep })).exitCode, 0);
  assert.deepEqual(next.calls, ['auth', 'rakuten_card']);
  assert.equal((await run(['--profile', fixture.profile, '--job', 'credit-card'], { now: () => time, spawnStep: next.spawnStep })).exitCode, 5);
});

test('mixed modes and account mismatches never start jobs or change state', async (t) => {
  const fixture = profileFixture(t);
  const before = readFileSync(fixture.stateFile);
  const { calls, spawnStep } = syntheticSteps(fixture, { account: 'b'.repeat(64) });
  const deps = { now: () => time, spawnStep };
  assert.equal((await run(['--profile', fixture.profile, '--cleanup-plan', '--restore-set'], deps)).exitCode, 1);
  assert.equal((await run(['--profile', fixture.profile], deps)).exitCode, 4);
  assert.deepEqual(calls, ['auth']);
  assert.deepEqual(readFileSync(fixture.stateFile), before);
  assert.equal((await run(['--profile', fixture.profile, '--register-account', '--expected-account-fingerprint', 'b'.repeat(64)], deps)).exitCode, 0);
  assert.equal(loadState(fixture.stateFile).account_fingerprint, 'b'.repeat(64));
});

test('mismatched Gmail ID sets never advance the provider', async (t) => {
  const fixture = profileFixture(t);
  const { spawnStep } = syntheticSteps(fixture, { smbc: 'mismatch' });
  const result = await run(['--profile', fixture.profile, '--job', 'credit-card'], { now: () => time, spawnStep });
  assert.equal(result.exitCode, 2);
  assert.equal(loadState(fixture.stateFile).credit_card.smbc.confirmed_through, '2026-11-21');
  assert.equal(loadState(fixture.stateFile).credit_card.smbc.last_outcome, 'permanent');
});

test('failed weekly attempt keeps the slot open, then recovery closes it exactly once', async (t) => {
  const fixture = profileFixture(t);
  const args = ['--profile', fixture.profile, '--test-weekly'];
  const deps = { now: () => time, wait: async () => {} };
  const lost = syntheticSteps(fixture, { smbc: 'temporary' });
  assert.equal((await run(args, { ...deps, spawnStep: lost.spawnStep })).exitCode, 2);
  assert.equal(loadState(fixture.stateFile).last_run.attempted_slot, '2026-11-22');
  assert.equal(loadState(fixture.stateFile).last_run.completed_slot, '');
  const recovered = syntheticSteps(fixture);
  assert.equal((await run(args, { ...deps, spawnStep: recovered.spawnStep })).exitCode, 0);
  assert.equal(loadState(fixture.stateFile).last_run.completed_slot, '2026-11-22');
  assert.equal((await run(args, { ...deps, spawnStep: recovered.spawnStep })).exitCode, 0);
  assert.deepEqual(recovered.calls, ['auth', 'smbc']);
});

test('diagnostic values and arbitrary properties are not persisted', (t) => {
  const { roots } = profileFixture(t);
  const dir = path.join(roots.runner, 'logs');
  const value = 'synthetic-id-secret-subject';
  saveLog(dir, { started_at: time.toISOString(), finished_at: time.toISOString(),
    entries: [{ job: 'amazon', step: 'apply', code: value, path: value, error: new Error(value),
      counts: { candidates: 1, subject: value }, checks: { preserved: true, arbitrary: value } }] });
  for (const file of ['summary.json', '2026-11-25.json']) assert.equal(readFileSync(path.join(dir, file), 'utf8').includes(value), false);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'summary.json'), 'utf8')).entries[0].counts.candidates, 1);
});

test('Amazon records each type’s outcome and the shared import counts once', async (t) => {
  const fixture = profileFixture(t);
  const { spawnStep } = syntheticSteps(fixture);
  assert.equal((await run(['--profile', fixture.profile, '--job', 'amazon'], { now: () => time, spawnStep })).exitCode, 0);
  const summary = JSON.parse(readFileSync(path.join(fixture.roots.runner, 'logs', 'summary.json'), 'utf8'));
  const entries = summary.entries.filter((entry) => entry.job === 'amazon' && entry.step === 'verify');
  assert.deepEqual(entries.filter((entry) => entry.provider).map((entry) => [entry.provider, entry.outcome, entry.counts]),
    [['type_a', 'success', {}], ['type_b', 'success', {}]]);
  const counted = entries.filter((entry) => Object.hasOwn(entry.counts, 'inserted'));
  assert.equal(counted.length, 1);
  assert.equal(counted[0].provider, undefined);
});

test('cleanup approval is single-use and changed, unverified and protected files survive', (t) => {
  const { roots, stateDir, ordersCsv } = profileFixture(t);
  const folder = path.join(roots.amazon, 'data', 'gmail-staging', 'amazon', 'run');
  mkdirSync(folder, { recursive: true });
  const first = path.join(folder, 'typeA-messages.jsonl');
  const second = path.join(folder, 'typeB-messages.jsonl');
  const unproven = path.join(folder, 'candidates.json');
  for (const file of [first, second, unproven]) writeFileSync(file, 'generational fixture');
  retainVerifiedArtifacts(stateDir, roots, [first, second, ordersCsv].map((file) => ({ root: 'amazon', file })), time);
  assert.equal(autoCleanup(stateDir, roots, time).removed, 0);
  const firstPlan = createCleanupPlan(stateDir, roots, time);
  approveCleanup(stateDir, firstPlan.planId, time);
  const secondPlan = createCleanupPlan(stateDir, roots, time);
  assert.notEqual(firstPlan.planId, secondPlan.planId);
  assert.throws(() => executeCleanup(stateDir, roots, firstPlan.planId, time), /INVALID_CLEANUP_PLAN/);
  approveCleanup(stateDir, secondPlan.planId, time);
  writeFileSync(first, 'changed after approval');
  assert.equal(executeCleanup(stateDir, roots, secondPlan.planId, time).removed, 1);
  assert.equal(executeCleanup(stateDir, roots, secondPlan.planId, time).removed, 0);
  for (const file of [first, unproven, ordersCsv]) assert.equal(existsSync(file), true);
  writeFileSync(path.join(stateDir, 'auto-cleanup-enabled'), '');
  assert.equal(autoCleanup(stateDir, roots, time).removed, 0);
  writeFileSync(second, 'newly verified');
  retainVerifiedArtifacts(stateDir, roots, [{ root: 'amazon', file: second }], time);
  assert.equal(autoCleanup(stateDir, roots, time).removed, 1);
  assert.equal(existsSync(path.join(stateDir, 'auto-cleanup-enabled')), true);
});

test('WAL restore set includes all three verified members and rejects missing files', async (t) => {
  const fixture = profileFixture(t);
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { return t.skip('node:sqlite unavailable'); }
  unlinkSync(fixture.cardDb);
  const live = new DatabaseSync(fixture.cardDb);
  try {
    live.exec('PRAGMA journal_mode=WAL; CREATE TABLE transactions (id INTEGER); INSERT INTO transactions VALUES (1)');
    assert.equal(existsSync(`${fixture.cardDb}-wal`), true);
    const generation = await createRestoreSet({ ...fixture, cardRoot: fixture.roots.card, lockHeld: { amazon: true, card: true }, at: time });
    const manifest = await verifyRestoreSet(generation.destination, fixture.roots.card);
    assert.equal(manifest.db_counts.transactions, 1);
    assert.equal(manifest.csv_rows, 0);
    assert.equal(manifest.state_schema, 2);
    unlinkSync(path.join(generation.destination, 'orders.csv'));
    await assert.rejects(verifyRestoreSet(generation.destination, fixture.roots.card));
    assert.equal(live.prepare('SELECT count(*) AS n FROM transactions').get().n, 1);
  } finally { live.close(); }
});
