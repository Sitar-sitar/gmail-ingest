import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { approveCleanup, autoCleanup, createCleanupPlan, executeCleanup, retainVerifiedArtifacts } from '../lib/cleanup.mjs';
import { saveLog } from '../lib/log.mjs';
import { createRestoreSet, verifyRestoreSet } from '../lib/restore-set.mjs';
import { createHash } from 'node:crypto';
import { jstDay, jstDayStartSeconds, loadState, offsetDay, recordTarget, saveState } from '../lib/state.mjs';
import { run } from '../run.mjs';
import { fingerprint, profileFixture, time } from './phase-fixtures.mjs';

function syntheticSteps(fixture, cardFaults = {}) {
  const calls = [];
  const fetches = [];
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
      const idsOnly = args.includes('--ids-only');
      // 実 CLI と同じく、選択型だけの生成物とキーを出す（§5.2-1）。
      const selected = args.includes('--types') ? get('--types').split(',') : ['typeA', 'typeB'];
      const after = { typeA: args.includes('--type-a-after') ? get('--type-a-after') : '',
        typeB: args.includes('--type-b-after') ? get('--type-b-after') : '' };
      fetches.push({ types: args.includes('--types') ? get('--types') : '', after });
      const candidates = { selected_types: selected, rows: [], parse_failures: [] };
      for (const type of selected) {
        const query = `example after:${after[type]}`;
        writeFileSync(path.join(output, `${type}-ids.json`), JSON.stringify({ type, query, message_ids: [], id_source: 'query' }));
        candidates[`${type}_query`] = query;
        candidates[`${type}_message_count`] = 0;
        if (type === 'typeB') {
          candidates.typeB_fetched_message_count = 0;
          candidates.excluded_typeB_preorder_messages = 0;
        }
      }
      if (cardFaults.amazonParse) {
        writeFileSync(path.join(output, 'parse-failures.json'),
          JSON.stringify({ issues: [{ type: cardFaults.amazonParse, missing: ['parsed rows'] }] }));
        return { exitCode: 1, treeStopped: true, failure: 'parse' };
      }
      writeFileSync(path.join(output, 'candidates.json'), JSON.stringify(candidates));
      return response({ ok: true, ids_only: idsOnly, selected_types: selected,
        typeA: { id_count: 0 }, typeB: { id_count: 0 } });
    }
    calls.push('amazon-apply');
    const directory = path.join(fixture.roots.amazon, 'backups', 'orders');
    mkdirSync(directory, { recursive: true });
    const backup = path.join(directory, 'fixture-orders.csv');
    writeFileSync(backup, readFileSync(fixture.ordersCsv));
    const isolated = get('--isolated-out');
    writeFileSync(isolated, '[]');
    // 実 CLI と同じく、置換後に対応表を更新する（取得元識別 §5.3）。
    const originFile = process.env.AMZ_GMAIL_ORIGIN_FILE ?? path.join(fixture.roots.amazon, 'data', 'gmail-origin.json');
    mkdirSync(path.dirname(originFile), { recursive: true });
    const originEntries = cardFaults.amazonOrigin === 'mismatch'
      ? [{ key_sha256: 'c'.repeat(64), count: 1 }] : [];
    writeFileSync(originFile, JSON.stringify(cardFaults.amazonOrigin === 'broken'
      ? { version: 1, key_spec: 'other', entries: [] }
      : { version: 1, key_spec: 'rowkeys_exact_v1', updated_at: new Date(0).toISOString(), entries: originEntries }));
    return response({ validation: { ok: true }, backup: { created: true, path: backup }, isolated_file: isolated,
      origin_mapping: { added: 0, removed: 0, total: 0 },
      excluded_invalid_type: 0, excluded_invalid_row: 0, excluded_empty_order_id: 0, excluded_amount_missing_typeA: 0,
      excluded_amount_missing_typeB: 0, excluded_pending_summary: 0, replaced_rows: [], replaced_typeB_summary_rows: 0,
      isolated_amount_diff_only: 0, appended: { total: cardFaults.amazonApply === 'mismatch' ? 1 : 0 },
      skipped_exact: 0, candidates: { total: 0 } });
  };
  return { calls, fetches, spawnStep };
}

function blockAmazonType(fixture, type) {
  const state = loadState(fixture.stateFile);
  recordTarget(state, 'amazon', type, { outcome: 'permanent', code: 'parse', range: { from: '2026-11-22', to: '2026-11-24' }, at: time });
  saveState(fixture.stateFile, state);
  return loadState(fixture.stateFile).amazon[type].failure.failure_id;
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
  approveCleanup(stateDir, roots, firstPlan.planId, time);
  const secondPlan = createCleanupPlan(stateDir, roots, time);
  assert.notEqual(firstPlan.planId, secondPlan.planId);
  assert.throws(() => executeCleanup(stateDir, roots, firstPlan.planId, time), /INVALID_CLEANUP_PLAN/);
  approveCleanup(stateDir, roots, secondPlan.planId, time);
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

test('a blocked Amazon type is skipped while the runnable type advances and the slot stays open', async (t) => {
  const fixture = profileFixture(t);
  const deps = { now: () => time, wait: async () => {} };
  const args = ['--profile', fixture.profile, '--test-weekly'];

  // 1: Type A だけブロック。検索は Type B だけで、A の期間と承認は保持される
  const failureId = blockAmazonType(fixture, 'type_a');
  const blockedA = syntheticSteps(fixture);
  assert.equal((await run(args, { ...deps, spawnStep: blockedA.spawnStep })).exitCode, 0);
  assert.deepEqual(blockedA.fetches.map(({ types }) => types), ['typeB']);
  assert.equal(blockedA.fetches[0].after.typeA, '');
  let state = loadState(fixture.stateFile);
  assert.equal(state.amazon.type_a.confirmed_through, '2026-11-21');
  assert.equal(state.amazon.type_a.last_outcome, 'permanent');
  assert.equal(state.amazon.type_b.confirmed_through, '2026-11-24');
  // 見送った対象があるので週次枠は未完了のまま
  assert.equal(state.last_run.completed_slot, '');
  const skippedEntry = JSON.parse(readFileSync(path.join(fixture.roots.runner, 'logs', 'summary.json'), 'utf8'))
    .entries.find((entry) => entry.provider === 'type_a' && entry.step === 'prepare');
  assert.equal(skippedEntry.checks.skipped, true);

  // 2: 型ごとの承認で解除。Type B は範囲が無いので Type A だけが走り、枠が閉じる
  assert.equal((await run(['--profile', fixture.profile, '--clear-failure', failureId, '--job', 'amazon'], deps)).exitCode, 0);
  const cleared = syntheticSteps(fixture);
  assert.equal((await run(args, { ...deps, spawnStep: cleared.spawnStep })).exitCode, 0);
  assert.deepEqual(cleared.fetches.map(({ types }) => types), ['typeA']);
  state = loadState(fixture.stateFile);
  assert.equal(state.amazon.type_a.confirmed_through, '2026-11-24');
  assert.equal(state.amazon.type_a.last_outcome, 'success');
  assert.deepEqual(state.cleared_failures, []);
  assert.equal(state.last_run.completed_slot, '2026-11-22');
});

test('both Amazon types blocked never start the child CLI', async (t) => {
  const fixture = profileFixture(t);
  blockAmazonType(fixture, 'type_a');
  blockAmazonType(fixture, 'type_b');
  const steps = syntheticSteps(fixture);
  assert.equal((await run(['--profile', fixture.profile, '--job', 'amazon'], { now: () => time, spawnStep: steps.spawnStep })).exitCode, 5);
  assert.deepEqual(steps.calls, []);
  assert.deepEqual(steps.fetches, []);
});

test('Amazon failures land on the type that caused them and on every type for shared steps', async (t) => {
  const parsed = profileFixture(t);
  const parseFault = syntheticSteps(parsed, { amazonParse: 'typeB' });
  assert.equal((await run(['--profile', parsed.profile, '--job', 'amazon'],
    { now: () => time, wait: async () => {}, spawnStep: parseFault.spawnStep })).exitCode, 2);
  let state = loadState(parsed.stateFile);
  // 帰属できた型だけが確定失敗。もう一方は未適用で据え置く
  assert.equal(state.amazon.type_b.last_outcome, 'permanent');
  assert.equal(state.amazon.type_b.failure.code, 'parse');
  assert.equal(state.amazon.type_a.last_outcome, 'not_run');
  assert.equal(state.amazon.type_a.failure, undefined);
  for (const type of ['type_a', 'type_b']) assert.equal(state.amazon[type].confirmed_through, '2026-11-21');
  assert.deepEqual(parseFault.calls, ['auth', 'amazon-fetch']);

  const shared = profileFixture(t);
  const applyFault = syntheticSteps(shared, { amazonApply: 'mismatch' });
  assert.equal((await run(['--profile', shared.profile, '--job', 'amazon'],
    { now: () => time, wait: async () => {}, spawnStep: applyFault.spawnStep })).exitCode, 2);
  state = loadState(shared.stateFile);
  // 共通 CSV の照合に由来する失敗は参加した全型に記録する
  for (const type of ['type_a', 'type_b']) {
    assert.equal(state.amazon[type].last_outcome, 'permanent');
    assert.equal(state.amazon[type].failure.code, 'verify_mismatch');
    assert.equal(state.amazon[type].confirmed_through, '2026-11-21');
  }
});

test('a mismatched or broken origin mapping stops the Amazon type without leaking keys', async (t) => {
  for (const fault of ['mismatch', 'broken']) {
    const fixture = profileFixture(t);
    const steps = syntheticSteps(fixture, { amazonOrigin: fault });
    const result = await run(['--profile', fixture.profile, '--job', 'amazon'],
      { now: () => time, wait: async () => {}, spawnStep: steps.spawnStep });
    assert.equal(result.exitCode, 2, fault);
    const state = loadState(fixture.stateFile);
    for (const type of ['type_a', 'type_b']) {
      assert.equal(state.amazon[type].last_outcome, 'permanent', fault);
      assert.equal(state.amazon[type].failure.code, 'verify_mismatch', fault);
      // 確認済み期間は進めない
      assert.equal(state.amazon[type].confirmed_through, '2026-11-21', fault);
    }
    // 定常ログに対応表の鍵・パスを出さない（failure_id は従来どおり出る）
    const summary = readFileSync(path.join(fixture.roots.runner, 'logs', 'summary.json'), 'utf8');
    assert.equal(summary.includes('c'.repeat(64)), false, fault);
    assert.equal(summary.includes('gmail-origin'), false, fault);
    assert.equal(summary.includes('key_sha256'), false, fault);
  }
});

test('legacy cleanup needs evidence, the origin policy and a one-time approval in range', async (t) => {
  const fixture = profileFixture(t);
  const { roots, stateDir, profile } = fixture;
  // 保持期限の起点は mtime なので、作成直後より少し後の時刻で判定する。
  const at = new Date(Date.now() + 5_000);
  const day = jstDay(at);
  const staging = path.join(roots.amazon, 'data', 'gmail-staging', 'amazon', day, 'run-legacy');
  mkdirSync(staging, { recursive: true });
  const legacy = path.join(staging, 'typeA-messages.jsonl');
  writeFileSync(legacy, '{"id":"legacy"}\n');
  const unresolved = path.join(staging, 'isolated.json');
  writeFileSync(unresolved, '[{"reason":"amount_diff"}]');
  const backupDir = path.join(roots.amazon, 'backups', 'orders');
  mkdirSync(backupDir, { recursive: true });
  const backup = `${day}-101010-orders.csv`;
  writeFileSync(path.join(backupDir, backup), 'synthetic backup');

  const planFor = () => {
    const { planId } = createCleanupPlan(stateDir, roots, at);
    const plan = JSON.parse(readFileSync(path.join(stateDir, 'cleanup-plans', `${planId}.json`), 'utf8'));
    return { planId, entries: plan.entries };
  };
  const entryFor = (entries, file) => entries.find((entry) => entry.path.toLowerCase() === file.toLowerCase());
  const evidenceFor = (entries, file, overrides = {}) => {
    const entry = entryFor(entries, file);
    assert.ok(entry, file);
    const { root, path: target, kind, size, mtime, sha256 } = entry;
    return { root, path: target, kind, size, mtime, sha256, origin_released: true,
      applied_proof: { kind: 'amazon_backup', ref: backup }, ...overrides };
  };
  const policyBody = { decided_at: at.toISOString(), method: 'mapping_table',
    mapping_file: 'amazon-tracker/data/gmail-origin.json', key_spec: 'rowkeys_exact_v1' };
  const policyFile = path.join(stateDir, 'origin-policy.json');
  const evidenceFile = path.join(stateDir, 'cleanup-evidence.json');
  const writePolicy = (body = policyBody) => {
    const id = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    writeFileSync(policyFile, JSON.stringify({ policy_id: id, ...body }));
    return id;
  };

  // 1: 証跡なしの承認では過去分を対象にしない
  let plan = planFor();
  assert.deepEqual(approveCleanup(stateDir, roots, plan.planId, at), { scope: 'verified', legacy: 0 });
  assert.deepEqual(executeCleanup(stateDir, roots, plan.planId, at), { removed: 0, retained: plan.entries.length, removed_legacy: 0 });
  assert.equal(existsSync(legacy), true);

  // 2: 決定記録が無い、または policy_id が合わない間は 1 件も承認しない
  plan = planFor();
  writeFileSync(evidenceFile, JSON.stringify({ origin_policy_id: 'd'.repeat(64), created_at: at.toISOString(),
    items: [evidenceFor(plan.entries, legacy)] }));
  assert.throws(() => approveCleanup(stateDir, roots, plan.planId, at, { includeLegacy: true }), /INVALID_CLEANUP_EVIDENCE/);
  assert.equal(existsSync(path.join(stateDir, 'cleanup-enabled')), false);
  const policy = writePolicy();
  assert.throws(() => approveCleanup(stateDir, roots, plan.planId, at, { includeLegacy: true }), /INVALID_CLEANUP_EVIDENCE/);
  // 本文を書き換えた決定記録は policy_id が一致しないので使えない
  writeFileSync(policyFile, JSON.stringify({ policy_id: policy, ...policyBody, method: 'rebuild' }));
  writeFileSync(evidenceFile, JSON.stringify({ origin_policy_id: policy, created_at: at.toISOString(),
    items: [evidenceFor(plan.entries, legacy)] }));
  assert.throws(() => approveCleanup(stateDir, roots, plan.planId, at, { includeLegacy: true }), /INVALID_CLEANUP_EVIDENCE/);
  writePolicy();

  // 3: 保全対象・未解決隔離・origin_released false・ref 書式違反・参照先欠落は承認に入らない
  for (const broken of [
    evidenceFor(plan.entries, legacy, { origin_released: false }),
    evidenceFor(plan.entries, legacy, { applied_proof: { kind: 'amazon_backup', ref: '../escape.csv' } }),
    evidenceFor(plan.entries, legacy, { applied_proof: { kind: 'amazon_backup', ref: 'missing-orders.csv' } }),
    evidenceFor(plan.entries, legacy, { applied_proof: { kind: 'unknown', ref: backup } }),
    evidenceFor(plan.entries, legacy, { sha256: 'e'.repeat(64) }),
    { ...evidenceFor(plan.entries, legacy), path: path.join(backupDir, backup) },
    evidenceFor(plan.entries, unresolved),
  ]) {
    writeFileSync(evidenceFile, JSON.stringify({ origin_policy_id: policy, created_at: at.toISOString(), items: [broken] }));
    assert.throws(() => approveCleanup(stateDir, roots, plan.planId, at, { includeLegacy: true }), /INVALID_CLEANUP_EVIDENCE/);
  }
  assert.equal(existsSync(legacy), true);
  assert.equal(existsSync(unresolved), true);

  // 4: 承認後に内容が差し替わった項目は削除しない
  writeFileSync(evidenceFile, JSON.stringify({ origin_policy_id: policy, created_at: at.toISOString(),
    items: [evidenceFor(plan.entries, legacy), evidenceFor(plan.entries, unresolved)] }));
  assert.deepEqual(approveCleanup(stateDir, roots, plan.planId, at, { includeLegacy: true }), { scope: 'verified+legacy', legacy: 1 });
  writeFileSync(legacy, '{"id":"changed after approval"}\n');
  assert.equal(executeCleanup(stateDir, roots, plan.planId, at).removed_legacy, 0);
  assert.equal(existsSync(legacy), true);
  assert.equal(existsSync(evidenceFile), false);

  // 5: 全条件を満たす集合だけが消え、承認は一度で消費される
  plan = planFor();
  writeFileSync(evidenceFile, JSON.stringify({ origin_policy_id: policy, created_at: at.toISOString(),
    items: [evidenceFor(plan.entries, legacy), evidenceFor(plan.entries, unresolved)] }));
  assert.deepEqual(approveCleanup(stateDir, roots, plan.planId, at, { includeLegacy: true }), { scope: 'verified+legacy', legacy: 1 });
  const executed = executeCleanup(stateDir, roots, plan.planId, at);
  assert.equal(executed.removed_legacy, 1);
  assert.equal(existsSync(legacy), false);
  assert.equal(existsSync(unresolved), true);
  assert.equal(existsSync(path.join(backupDir, backup)), true);
  assert.equal(existsSync(evidenceFile), false);
  assert.equal(existsSync(path.join(stateDir, 'cleanup-plans', `${plan.planId}.json`)), false);
  assert.deepEqual(executeCleanup(stateDir, roots, plan.planId, at), { removed: 0, retained: 0, removed_legacy: 0 });
  // 定常削除は照合済み台帳だけを見る
  writeFileSync(path.join(stateDir, 'auto-cleanup-enabled'), '');
  assert.equal(autoCleanup(stateDir, roots, at).removed, 0);

  // 6: --include-legacy は承認モード以外で拒否され、--include-legacy-state と取り違えても止まる
  const deps = { now: () => at, spawnStep: syntheticSteps(fixture).spawnStep };
  for (const args of [
    ['--profile', profile, '--cleanup-plan', '--include-legacy'],
    ['--profile', profile, '--restore-set', '--include-legacy'],
    ['--profile', profile, '--enable-cleanup', '--plan-id', 'f'.repeat(64), '--include-legacy-state'],
    ['--profile', profile, '--include-legacy'],
  ]) assert.equal((await run(args, deps)).exitCode, 1, args.join(' '));
});

test('a card payload is released only by a successful import_runs row for its provider and period', async (t) => {
  const fixture = profileFixture(t);
  const { roots, stateDir } = fixture;
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { return t.skip('node:sqlite unavailable'); }
  const at = new Date(Date.now() + 8 * 86_400_000);
  unlinkSync(fixture.cardDb);
  const db = new DatabaseSync(fixture.cardDb);
  try {
    db.exec(`CREATE TABLE import_runs (id INTEGER PRIMARY KEY, started_at TEXT, finished_at TEXT, status TEXT,
      provider TEXT, query_from_day TEXT, query_to_day TEXT, message_count INTEGER, parsed_count INTEGER,
      inserted_count INTEGER, duplicate_count INTEGER, failure_count INTEGER NOT NULL DEFAULT 0,
      ignored_count INTEGER, note TEXT)`);
    db.exec(`INSERT INTO import_runs (id, provider, query_from_day, query_to_day, failure_count, note) VALUES
      (7, 'smbc', '2026-11-01', '2026-11-07', 0, 'success'),
      (8, 'smbc', '2026-11-01', '2026-11-07', 2, 'failed'),
      (9, 'rakuten_card', '2026-11-01', '2026-11-07', 0, NULL)`);
  } finally { db.close(); }

  const payload = path.join(roots.card, 'data', 'import-smbc-2026-11-01-to-2026-11-07.json');
  writeFileSync(payload, '{"messages":[]}');
  const policyBody = { decided_at: at.toISOString(), method: 'mapping_table',
    mapping_file: 'amazon-tracker/data/gmail-origin.json', key_spec: 'rowkeys_exact_v1' };
  const policy = createHash('sha256').update(JSON.stringify(policyBody)).digest('hex');
  writeFileSync(path.join(stateDir, 'origin-policy.json'), JSON.stringify({ policy_id: policy, ...policyBody }));

  const approveWith = (ref) => {
    const { planId } = createCleanupPlan(stateDir, roots, at);
    const plan = JSON.parse(readFileSync(path.join(stateDir, 'cleanup-plans', `${planId}.json`), 'utf8'));
    const entry = plan.entries.find((candidate) => candidate.path.toLowerCase() === payload.toLowerCase());
    assert.ok(entry, 'payload is part of the plan');
    assert.equal(entry.kind, 'payload');
    const { root, path: file, kind, size, mtime, sha256 } = entry;
    writeFileSync(path.join(stateDir, 'cleanup-evidence.json'), JSON.stringify({ origin_policy_id: policy,
      created_at: at.toISOString(),
      items: [{ root, path: file, kind, size, mtime, sha256, origin_released: true,
        applied_proof: { kind: 'card_import_run', ref } }] }));
    return planId;
  };

  // 失敗した行、別 provider の行、存在しない行では承認されない
  for (const ref of ['8', '9', '404']) {
    assert.throws(() => approveCleanup(stateDir, roots, approveWith(ref), at, { includeLegacy: true }),
      /INVALID_CLEANUP_EVIDENCE/, ref);
  }
  assert.equal(existsSync(payload), true);

  const planId = approveWith('7');
  assert.deepEqual(approveCleanup(stateDir, roots, planId, at, { includeLegacy: true }), { scope: 'verified+legacy', legacy: 1 });
  assert.equal(executeCleanup(stateDir, roots, planId, at).removed_legacy, 1);
  assert.equal(existsSync(payload), false);
  // SQLite 本体と WAL / SHM は触らない
  assert.equal(existsSync(fixture.cardDb), true);
});
