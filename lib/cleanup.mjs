import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { isTimestamp, replaceJson } from './state.mjs';

const DAY = 86_400_000;
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

function identify(roots, rootName, file) {
  const root = roots[rootName];
  if (!root || !path.isAbsolute(file) || !childPath(root, file)) return null;
  const relative = path.relative(root, file).split(path.sep).join('/');
  const kind = kindFor(rootName, relative);
  if (!kind) return null;
  let actual;
  let stat;
  try {
    actual = realpathSync.native(file);
    stat = lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.nlink !== 1 || !samePath(actual, file) || !childPath(root, actual)) return null;
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
  const folders = { runner: ['logs'], amazon: ['data/gmail-staging/amazon', 'backups/orders/isolated'], card: ['data', 'quarantine/gmail-import'] };
  for (const [root, locations] of Object.entries(folders)) {
    for (const location of locations) {
      for (const file of filesUnder(path.join(roots[root], location))) {
        const current = identify(roots, root, file);
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
  const body = { created_at: at.toISOString(), nonce: randomUUID(), entries };
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
  return { planId, eligible: entries.filter((entry) => entry.eligible).length, retained: entries.filter((entry) => !entry.eligible).length };
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

export function approveCleanup(stateDir, planId, at) {
  loadPlan(stateDir, planId, at);
  replaceJson(path.join(stateDir, 'cleanup-enabled'), { plan_id: planId, approved_at: at.toISOString() });
}

export function executeCleanup(stateDir, roots, planId, at) {
  const approval = path.join(stateDir, 'cleanup-enabled');
  if (readOptional(approval, {}).plan_id !== planId) return { removed: 0, retained: 0 };
  const plan = loadPlan(stateDir, planId, at);
  const consumed = `${approval}.${randomUUID()}.consumed`;
  renameSync(approval, consumed);
  let removed = 0;
  try {
    for (const entry of plan.entries) {
      if (!entry.eligible || entry.unresolved || !sameFile(entry, identify(roots, entry.root, entry.path))) continue;
      unlinkSync(entry.path);
      removed++;
    }
  } finally {
    remove(consumed);
    remove(path.join(planDirectory(stateDir), `${planId}.json`));
    remove(path.join(planDirectory(stateDir), 'current.json'));
  }
  return { removed, retained: plan.entries.length - removed };
}
