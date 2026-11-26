import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { isTimestamp, replaceJson } from './state.mjs';

const DAY = 86_400_000;
// 修正設計書_Gmail取り込み実装レビュー反映_Phase1_2026-11-26.md §5.1-1 / §5.1-2（方式 A）
const PROOF_KINDS = ['amazon_backup', 'amazon_run_log', 'card_import_run', 'card_staging_month'];
const REF = /^[A-Za-z0-9._-]{1,120}$/;
const CARD_PROVIDER = '(smbc|rakuten_card|jcb_ekenet)';
const HASH = /^[a-f0-9]{64}$/;
const RETENTION = { amazon_body: 0, card_body: 0, candidate: 7, ids: 7, payload: 7, empty_isolation: 7, isolation: 30, runner_log: 180 };

function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function childPath(root, file) {
  const relative = path.relative(root, file);
  return Boolean(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function kindFor(rootName, relative) {
  if (rootName === 'runner') return /^logs\/\d{4}-\d{2}-\d{2}\.json$/.test(relative) ? 'runner_log' : '';
  if (rootName === 'amazon') {
    if (/^backups\/orders\/isolated\/[^/]+\.json$/.test(relative)) return 'isolation';
    if (!/^data\/gmail-staging\/amazon\//.test(relative)) return '';
    if (/\/(typeA|typeB)-messages\.jsonl$/.test(relative)) return 'amazon_body';
    if (relative.endsWith('/candidates.json')) return 'candidate';
    if (/\/(typeA|typeB)-ids\.json$/.test(relative)) return 'ids';
    if (relative.endsWith('/isolated.json')) return 'isolation';
  }
  if (rootName === 'card') {
    if (/^quarantine\/gmail-import\/[^/]+\.json$/.test(relative)) return 'isolation';
    if (/^data\/gmail-staging\/.+\/messages\.jsonl$/.test(relative)) return 'card_body';
    if (/^data\/(?:gmail-staging\/.+\/)?import-(?:smbc|rakuten_card|jcb_ekenet)-[^/]+\.json$/.test(relative)) return 'payload';
    if (/^data\/gmail-staging\/.+\/ids\.json$/.test(relative)) return 'ids';
  }
  return '';
}

function identify(roots, rootName, file, excluded) {
  const root = roots[rootName];
  if (!root || !path.isAbsolute(file) || !childPath(root, file)) return null;
  const relative = path.relative(root, file).split(path.sep).join('/');
  const kind = kindFor(rootName, relative);
  if (!kind) return null;
  function exclude(reason) {
    excluded?.push({ root: rootName, path: file, kind, reason });
    return null;
  }
  let actual;
  let stat;
  try {
    actual = realpathSync.native(file);
    stat = lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return exclude('missing_file');
    throw error;
  }
  if (!stat.isFile()) return exclude('not_regular_file');
  if (!samePath(actual, file) || !childPath(root, actual)) return exclude('redirected_path');
  if (stat.nlink !== 1) return exclude('multiple_hardlinks');
  const contents = readFileSync(actual);
  let effectiveKind = kind;
  if (kind === 'isolation') {
    try { if (contents.toString().trim().replace(/\s/g, '') === '[]') effectiveKind = 'empty_isolation'; } catch { /* Retain unknown content. */ }
  }
  return { root: rootName, path: actual, kind: effectiveKind, size: stat.size, mtime: stat.mtimeMs,
    sha256: createHash('sha256').update(contents).digest('hex'),
    parse_failure: rootName === 'amazon' && existsSync(path.join(path.dirname(actual), 'parse-failures.json')) };
}

function sameFile(expected, current) {
  return current && !current.parse_failure && expected.root === current.root && samePath(expected.path, current.path) &&
    expected.kind === current.kind && expected.size === current.size && expected.mtime === current.mtime && expected.sha256 === current.sha256;
}

function readOptional(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

function remove(file) {
  try { unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function posix(file) {
  return file.split(path.sep).join('/');
}

function regularFile(file) {
  try {
    const stat = lstatSync(file);
    return stat.isFile() && samePath(realpathSync.native(file), path.normalize(file));
  } catch { return false; }
}

// 証跡があっても削除しない対象。計画の種別判定に加えて削除直前にも独立に効かせる（§5.1-2）。
function protectedTarget(roots, item) {
  if (!item || item.kind === 'isolation' || item.parse_failure === true) return true;
  const relative = (rootName) => (roots[rootName] && childPath(roots[rootName], item.path)
    ? posix(path.relative(roots[rootName], item.path)) : '');
  const amazon = relative('amazon');
  if (['public/data/orders.csv', 'dist/data/orders.csv', 'gmail-import-rules.md'].includes(amazon)) return true;
  if (/^backups\/orders\/[^/]+\.csv$/.test(amazon)) return true;
  if (/\.db(-wal|-shm)?$/.test(posix(item.path))) return true;
  if (relative('runner').startsWith('state/restore-sets/')) return true;
  return false;
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// その月の初日と末日。月単位の対象が 1 回の成功実行に包含されるかを見るために使う。
function monthRange(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null;
  const [year, index] = month.split('-').map(Number);
  const last = new Date(Date.UTC(year, index, 0)).getUTCDate();
  return [`${month}-01`, `${month}-${String(last).padStart(2, '0')}`];
}

// §5.1-4: 成否の正本は status 列。note は取り込みログのファイルパスを持つため成否判定に使えない。
function cardRunMatches(cardRoot, id, provider, from, to, { contains = false } = {}) {
  const database = path.join(cardRoot, 'data', 'credit-card.db');
  if (!regularFile(database)) return false;
  let open;
  try { ({ DatabaseSync: open } = createRequire(import.meta.url)('node:sqlite')); }
  catch { return false; }
  let db;
  try {
    // 読み取り専用で開き、SELECT だけを実行する。WAL / SHM には触らない。note は読まない。
    db = new open(database, { readOnly: true });
    const row = db.prepare('SELECT provider, query_from_day, query_to_day, failure_count, status FROM import_runs WHERE id = ?').get(id);
    if (!row || row.status !== 'success' || row.failure_count !== 0 || row.provider !== provider) return false;
    const runFrom = String(row.query_from_day ?? '');
    const runTo = String(row.query_to_day ?? '');
    if (!DAY_PATTERN.test(runFrom) || !DAY_PATTERN.test(runTo)) return false;
    // 期間を包含で見るのは月単位の対象だけ。日付で名付けられた payload は従来どおり一致を求める。
    if (contains) return runFrom <= from && runTo >= to;
    return runTo === to && (from === '' || runFrom === from);
  } catch { return false; }
  finally { try { db?.close(); } catch { /* read-only handle */ } }
}

function proofExists(roots, item, proof) {
  if (proof.kind === 'amazon_backup') {
    if (!regularFile(path.join(roots.amazon, 'backups', 'orders', proof.ref))) return false;
    const generation = /^(\d{4}-\d{2}-\d{2})-/.exec(proof.ref)?.[1];
    const directory = /\/gmail-staging\/amazon\/(\d{4}-\d{2}-\d{2})\//.exec(posix(item.path))?.[1];
    return Boolean(generation && directory && generation === directory);
  }
  if (proof.kind === 'amazon_run_log') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(proof.ref)) return false;
    const rules = path.join(roots.amazon, 'gmail-import-rules.md');
    if (!regularFile(rules)) return false;
    const names = readFileSync(rules, 'utf8').split(/\r?\n/).filter((line) => line.includes(proof.ref))
      .flatMap((line) => [...line.matchAll(/(\d{4}-\d{2}-\d{2}-\d{6}[A-Za-z0-9._-]*\.csv)/g)].map((match) => match[1]));
    return names.some((name) => regularFile(path.join(roots.amazon, 'backups', 'orders', name)));
  }
  if (!/^\d{1,15}$/.test(proof.ref)) return false;
  const target = posix(item.path);
  const runId = Number(proof.ref);
  if (proof.kind === 'card_staging_month') {
    // §5.1-4: 月別の取得ディレクトリ配下の本文・ids は、その月を包含する成功実行で解放する。
    if (!['card_body', 'ids'].includes(item.kind)) return false;
    const staged = new RegExp(`/data/gmail-staging/\\d{4}/(\\d{4}-\\d{2})/${CARD_PROVIDER}/`).exec(target);
    const range = staged ? monthRange(staged[1]) : null;
    return Boolean(range) && cardRunMatches(roots.card, runId, staged[2], range[0], range[1], { contains: true });
  }
  const payload = new RegExp(`/import-${CARD_PROVIDER}-(\\d{4}-\\d{2}-\\d{2})(?:-to-(\\d{4}-\\d{2}-\\d{2}))?\\.json$`).exec(target);
  if (payload) {
    const [, provider, firstDay, secondDay] = payload;
    return cardRunMatches(roots.card, runId, provider, secondDay ? firstDay : '', secondDay ?? firstDay);
  }
  // §5.1-4: 月で名付けられた payload（import-<provider>-<YYYY-MM>.json）もその月を包含する成功実行で解放する。
  const monthly = new RegExp(`/import-${CARD_PROVIDER}-(\\d{4}-\\d{2})\\.json$`).exec(target);
  const monthlyRange = monthly ? monthRange(monthly[2]) : null;
  return Boolean(monthlyRange) && cardRunMatches(roots.card, runId, monthly[1], monthlyRange[0], monthlyRange[1], { contains: true });
}

function policyId(stateDir) {
  const file = path.join(stateDir, 'origin-policy.json');
  const policy = readOptional(file, null);
  if (!policy || typeof policy !== 'object') return '';
  const { policy_id: id, ...body } = policy;
  // 取得元識別 §5.1: policy_id は policy_id を除いた本文の SHA-256
  return HASH.test(String(id)) && planHash(body) === id && policy.method === 'mapping_table' ? id : '';
}

function evidenceFile(stateDir) {
  return path.join(stateDir, 'cleanup-evidence.json');
}

function readEvidence(stateDir) {
  const file = evidenceFile(stateDir);
  let raw;
  try { raw = readFileSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let value;
  try { value = JSON.parse(raw.toString('utf8')); }
  catch { return null; }
  if (!value || typeof value !== 'object' || !Array.isArray(value.items)) return null;
  // §5.1-3: 決定記録の ID は Amazon の項目にだけ必要なので、台帳では任意とする。
  const id = value.origin_policy_id === undefined || value.origin_policy_id === '' ? '' : String(value.origin_policy_id);
  if (id !== '' && !HASH.test(id)) return null;
  return { ...value, origin_policy_id: id, sha256: createHash('sha256').update(raw).digest('hex') };
}

// §5.1-3: 取得元の決定記録を求めるのは Amazon の項目だけ。
const ORIGIN_SCOPED_ROOTS = ['amazon'];

function originSatisfied(item, evidencePolicyId, policy) {
  if (!ORIGIN_SCOPED_ROOTS.includes(item.root)) return true;
  return Boolean(policy) && evidencePolicyId === policy;
}

// 1 項目でも条件を欠けばその項目だけを保持する（§5.1-1 の削除前検証）。
function legacyEligible(roots, plan, item, at) {
  if (!item || typeof item !== 'object' || item.origin_released !== true) return false;
  const proof = item.applied_proof;
  if (!proof || !PROOF_KINDS.includes(proof.kind) || typeof proof.ref !== 'string' || !REF.test(proof.ref)) return false;
  if (!Object.hasOwn(RETENTION, item.kind) || typeof item.path !== 'string' || !path.isAbsolute(item.path)) return false;
  const entry = plan.entries.find((candidate) => candidate.root === item.root && samePath(String(candidate.path), item.path));
  if (!entry || entry.verified !== false) return false;
  for (const field of ['root', 'kind', 'size', 'mtime', 'sha256']) if (entry[field] !== item[field]) return false;
  if (protectedTarget(roots, entry) || protectedTarget(roots, item)) return false;
  if (!Number.isFinite(item.mtime) || at.valueOf() - item.mtime < RETENTION[item.kind] * DAY) return false;
  const current = identify(roots, item.root, item.path);
  if (!sameFile(item, current) || protectedTarget(roots, current)) return false;
  return proofExists(roots, item, proof);
}

export function retainVerifiedArtifacts(stateDir, roots, artifacts, at) {
  const file = path.join(stateDir, 'verified-artifacts.json');
  const previous = readOptional(file, []);
  if (!Array.isArray(previous)) throw new Error('INVALID_CLEANUP_LEDGER');
  const records = new Map(previous.filter((entry) => entry?.path).map((entry) => [entry.path, entry]));
  for (const { root, file: artifact } of artifacts) {
    const current = identify(roots, root, artifact);
    if (current && !current.parse_failure) records.set(current.path, { ...current, verified_at: at.toISOString() });
  }
  replaceJson(file, [...records.values()]);
}

export function autoCleanup(stateDir, roots, at, eligibleRoots = Object.keys(roots)) {
  const enabled = path.join(stateDir, 'auto-cleanup-enabled');
  if (!existsSync(enabled) || !lstatSync(enabled).isFile()) return { removed: 0, retained: 0 };
  const file = path.join(stateDir, 'verified-artifacts.json');
  const records = readOptional(file, []);
  if (!Array.isArray(records)) throw new Error('INVALID_CLEANUP_LEDGER');
  let removed = 0;
  const remaining = [];
  for (const record of records) {
    if (!eligibleRoots.includes(record.root)) {
      remaining.push(record);
      continue;
    }
    const current = identify(roots, record.root, record.path);
    if (!current) continue;
    const elapsed = at.valueOf() - Date.parse(record.verified_at);
    if (current.kind !== 'isolation' && isTimestamp(record.verified_at) && elapsed >= RETENTION[current.kind] * DAY && sameFile(record, current)) {
      unlinkSync(current.path);
      removed++;
    } else remaining.push(record);
  }
  replaceJson(file, remaining);
  return { removed, retained: remaining.length };
}

function filesUnder(root) {
  if (!existsSync(root) || !samePath(realpathSync.native(root), root) || !lstatSync(root).isDirectory()) return [];
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(file));
    if (entry.isFile()) files.push(file);
  }
  return files;
}

function planHash(body) {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

function planDirectory(stateDir) {
  return path.join(stateDir, 'cleanup-plans');
}

export function createCleanupPlan(stateDir, roots, at) {
  const known = readOptional(path.join(stateDir, 'verified-artifacts.json'), []);
  if (!Array.isArray(known)) throw new Error('INVALID_CLEANUP_LEDGER');
  const evidence = new Map(known.map((record) => [record.path, record]));
  const entries = [];
  const excluded = [];
  const folders = { runner: ['logs'], amazon: ['data/gmail-staging/amazon', 'backups/orders/isolated'], card: ['data', 'quarantine/gmail-import'] };
  for (const [root, locations] of Object.entries(folders)) {
    for (const location of locations) {
      for (const file of filesUnder(path.join(roots[root], location))) {
        const current = identify(roots, root, file, excluded);
        if (!current) continue;
        const record = evidence.get(current.path);
        const verified = Boolean(record && sameFile(record, current));
        const unresolved = current.kind === 'isolation';
        const age = at.valueOf() - (verified ? Date.parse(record.verified_at) : current.mtime);
        entries.push({ ...current, generated_by_runner: Boolean(record), verified, unresolved,
          eligible: verified && !unresolved && age >= RETENTION[current.kind] * DAY });
      }
    }
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  excluded.sort((left, right) => left.path.localeCompare(right.path));
  const body = { created_at: at.toISOString(), nonce: randomUUID(), entries, excluded };
  const planId = planHash(body);
  const directory = planDirectory(stateDir);
  mkdirSync(directory, { recursive: true });
  for (const file of readdirSync(directory)) {
    if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
    const previous = readOptional(path.join(directory, file), {});
    if (at.valueOf() - Date.parse(previous.created_at) >= 30 * DAY) remove(path.join(directory, file));
  }
  replaceJson(path.join(directory, `${planId}.json`), { plan_id: planId, ...body });
  replaceJson(path.join(directory, 'current.json'), { plan_id: planId });
  const excludedCounts = {};
  for (const { root, kind, reason } of excluded) {
    const key = `${root}:${kind}:${reason}`;
    excludedCounts[key] = (excludedCounts[key] ?? 0) + 1;
  }
  return { planId, eligible: entries.filter((entry) => entry.eligible).length,
    retained: entries.filter((entry) => !entry.eligible).length, excluded: excludedCounts };
}

function loadPlan(stateDir, planId, at) {
  const directory = planDirectory(stateDir);
  if (!HASH.test(planId) || readOptional(path.join(directory, 'current.json'), {}).plan_id !== planId) throw new Error('INVALID_CLEANUP_PLAN');
  const plan = readOptional(path.join(directory, `${planId}.json`), {});
  const { plan_id: id, ...body } = plan;
  const age = at.valueOf() - Date.parse(body.created_at);
  if (id !== planId || planHash(body) !== planId || !Array.isArray(body.entries) ||
      !isTimestamp(body.created_at) || age < 0 || age >= 30 * DAY) throw new Error('INVALID_CLEANUP_PLAN');
  return body;
}

export function approveCleanup(stateDir, roots, planId, at, { includeLegacy = false } = {}) {
  const plan = loadPlan(stateDir, planId, at);
  const approval = path.join(stateDir, 'cleanup-enabled');
  if (!includeLegacy) {
    replaceJson(approval, { plan_id: planId, approved_at: at.toISOString(), scope: 'verified' });
    return { scope: 'verified', legacy: 0 };
  }
  const evidence = readEvidence(stateDir);
  const policy = policyId(stateDir);
  if (!evidence) throw new Error('INVALID_CLEANUP_EVIDENCE');
  // §5.1-3: Amazon の項目は決定記録が無い・不一致なら 1 件も承認しない。他の root は妨げない。
  const approved = evidence.items.filter((item) => item && typeof item === 'object'
    && originSatisfied(item, evidence.origin_policy_id, policy) && legacyEligible(roots, plan, item, at));
  if (!approved.length) throw new Error('INVALID_CLEANUP_EVIDENCE');
  const paths = approved.map((item) => item.path);
  const scopedPolicy = approved.some((item) => ORIGIN_SCOPED_ROOTS.includes(item.root)) ? policy : '';
  replaceJson(approval, { plan_id: planId, approved_at: at.toISOString(), scope: 'verified+legacy',
    legacy: { origin_policy_id: scopedPolicy, evidence_sha256: evidence.sha256, paths } });
  return { scope: 'verified+legacy', legacy: paths.length };
}

export function executeCleanup(stateDir, roots, planId, at) {
  const approval = path.join(stateDir, 'cleanup-enabled');
  const granted = readOptional(approval, {});
  if (granted.plan_id !== planId) return { removed: 0, retained: 0, removed_legacy: 0 };
  const plan = loadPlan(stateDir, planId, at);
  const consumed = `${approval}.${randomUUID()}.consumed`;
  renameSync(approval, consumed);
  let removed = 0;
  let removedLegacy = 0;
  try {
    for (const entry of plan.entries) {
      if (!entry.eligible || entry.unresolved || !sameFile(entry, identify(roots, entry.root, entry.path))) continue;
      unlinkSync(entry.path);
      removed++;
    }
    // 承認の範囲を実行側のフラグで広げることはできない（§5.1-1）。
    if (granted.scope === 'verified+legacy') {
      const evidence = readEvidence(stateDir);
      const policy = policyId(stateDir);
      const allowed = new Set((granted.legacy?.paths ?? []).map((file) => (process.platform === 'win32' ? file.toLowerCase() : file)));
      // 承認時に Amazon を含まなければ origin_policy_id は空。承認後に決定記録が現れた・変わった回は 1 件も削除しない（§5.1-3）。
      const expectedPolicy = granted.legacy?.origin_policy_id === '' ? '' : policy;
      if (evidence && granted.legacy?.origin_policy_id === expectedPolicy
          && granted.legacy?.evidence_sha256 === evidence.sha256) {
        for (const item of evidence.items) {
          const key = process.platform === 'win32' ? String(item?.path ?? '').toLowerCase() : String(item?.path ?? '');
          if (!allowed.has(key) || !item || typeof item !== 'object') continue;
          if (!originSatisfied(item, evidence.origin_policy_id, policy) || !legacyEligible(roots, plan, item, at)) continue;
          unlinkSync(item.path);
          removedLegacy++;
        }
      }
    }
  } finally {
    remove(consumed);
    remove(path.join(planDirectory(stateDir), `${planId}.json`));
    remove(path.join(planDirectory(stateDir), 'current.json'));
    // 承認は 1 回の実行で消費する。証跡台帳も同時に削除する（§5.1-1）。
    remove(evidenceFile(stateDir));
  }
  return { removed, retained: plan.entries.length - removed, removed_legacy: removedLegacy };
}
