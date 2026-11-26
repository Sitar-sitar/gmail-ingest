// 方式 A の証跡台帳 state/cleanup-evidence.json を、ローカルに既にある記録だけから組み立てる。
// Gmail へは問い合わせない。既定は dry-run で、--write を付けたときだけ台帳を書く。
// 使い方: node tools/build-cleanup-evidence.mjs --plan-id <id> [--roots card,amazon] [--write]
import { createRequire } from 'node:module';
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOTS = {
  runner: path.resolve(import.meta.dirname, '..'),
  amazon: path.resolve(import.meta.dirname, '..', '..', 'amazon-tracker'),
  card: path.resolve(import.meta.dirname, '..', '..', 'credit-card-tracker'),
};
const PROVIDER = '(smbc|rakuten_card|jcb_ekenet)';
// lib/cleanup.mjs と同じ保持期限（日）。承認時に落ちる項目を台帳へ入れないために使う。
const RETENTION = { amazon_body: 0, card_body: 0, candidate: 7, ids: 7, payload: 7, empty_isolation: 7, isolation: 30, runner_log: 180 };
const DAY = 86_400_000;

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function posix(file) {
  return file.split(path.sep).join('/');
}

function monthRange(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null;
  const [year, index] = month.split('-').map(Number);
  const last = new Date(Date.UTC(year, index, 0)).getUTCDate();
  return [`${month}-01`, `${month}-${String(last).padStart(2, '0')}`];
}

function successRuns() {
  const database = path.join(ROOTS.card, 'data', 'credit-card.db');
  if (!existsSync(database)) return [];
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    // status が成否の正本。note（ログのパス）は読まない。
    return db.prepare(`SELECT id, provider, query_from_day AS f, query_to_day AS t FROM import_runs
      WHERE status = 'success' AND failure_count = 0`).all();
  } finally { try { db.close(); } catch { /* read-only handle */ } }
}

function cardProof(runs, entry) {
  const target = posix(entry.path);
  const staged = new RegExp(`/data/gmail-staging/\\d{4}/(\\d{4}-\\d{2})/${PROVIDER}/`).exec(target);
  if (staged && ['card_body', 'ids'].includes(entry.kind)) {
    const range = monthRange(staged[1]);
    const run = range && runs.find((row) => row.provider === staged[2] && row.f <= range[0] && row.t >= range[1]);
    return run ? { kind: 'card_staging_month', ref: String(run.id) } : null;
  }
  const day = new RegExp(`/import-${PROVIDER}-(\\d{4}-\\d{2}-\\d{2})(?:-to-(\\d{4}-\\d{2}-\\d{2}))?\\.json$`).exec(target);
  if (day) {
    const [, provider, first, second] = day;
    const run = runs.find((row) => row.provider === provider && row.t === (second ?? first)
      && (second ? row.f === first : true));
    return run ? { kind: 'card_import_run', ref: String(run.id) } : null;
  }
  const month = new RegExp(`/import-${PROVIDER}-(\\d{4}-\\d{2})\\.json$`).exec(target);
  const range = month && monthRange(month[2]);
  if (!range) return null;
  const run = runs.find((row) => row.provider === month[1] && row.f <= range[0] && row.t >= range[1]);
  return run ? { kind: 'card_import_run', ref: String(run.id) } : null;
}

function amazonProof(entry) {
  const day = /\/gmail-staging\/amazon\/(\d{4}-\d{2}-\d{2})\//.exec(posix(entry.path))?.[1];
  if (!day) return null;
  const backups = path.join(ROOTS.amazon, 'backups', 'orders');
  if (!existsSync(backups)) return null;
  const match = readdirSync(backups).find((name) => name.startsWith(`${day}-`) && name.endsWith('.csv')
    && lstatSync(path.join(backups, name)).isFile());
  return match ? { kind: 'amazon_backup', ref: match } : null;
}

const planId = arg('--plan-id');
if (!/^[a-f0-9]{64}$/.test(planId)) throw new Error('--plan-id <64 hex> is required');
const selected = arg('--roots', 'card').split(',').map((value) => value.trim()).filter(Boolean);
if (selected.some((value) => !Object.hasOwn(ROOTS, value))) throw new Error('--roots takes a subset of runner,amazon,card');

const stateDir = path.join(ROOTS.runner, 'state');
const plan = JSON.parse(readFileSync(path.join(stateDir, 'cleanup-plans', `${planId}.json`), 'utf8'));
const runs = selected.includes('card') ? successRuns() : [];
const items = [];
const skipped = {};
for (const entry of plan.entries) {
  if (entry.verified !== false || entry.unresolved) continue;
  if (!selected.includes(entry.root)) { skipped[`${entry.root}:not_selected`] = (skipped[`${entry.root}:not_selected`] ?? 0) + 1; continue; }
  // 取得元識別 §5.7: 対応表が無い間は Amazon の成果物を取得元識別に不要と宣言できない。
  if (entry.root === 'amazon' && !existsSync(path.join(stateDir, 'origin-policy.json'))) {
    skipped['amazon:origin_policy_missing'] = (skipped['amazon:origin_policy_missing'] ?? 0) + 1;
    continue;
  }
  const proof = entry.root === 'card' ? cardProof(runs, entry) : entry.root === 'amazon' ? amazonProof(entry) : null;
  if (!proof) { skipped[`${entry.root}:${entry.kind}:no_proof`] = (skipped[`${entry.root}:${entry.kind}:no_proof`] ?? 0) + 1; continue; }
  const { root, path: file, kind, size, mtime, sha256 } = entry;
  if (!Number.isFinite(mtime) || Date.now() - mtime < (RETENTION[kind] ?? 0) * DAY) {
    skipped[`${entry.root}:${entry.kind}:within_retention`] = (skipped[`${entry.root}:${entry.kind}:within_retention`] ?? 0) + 1;
    continue;
  }
  items.push({ root, path: file, kind, size, mtime, sha256, origin_released: true, applied_proof: proof });
}

const byKind = {};
for (const item of items) byKind[`${item.root}:${item.kind}`] = (byKind[`${item.root}:${item.kind}`] ?? 0) + 1;
const bytes = items.reduce((sum, item) => sum + item.size, 0);
const body = { origin_policy_id: '', created_at: new Date().toISOString(), items };
if (process.argv.includes('--write')) writeFileSync(path.join(stateDir, 'cleanup-evidence.json'), JSON.stringify(body, null, 2));
// パス・ref は標準出力に出さない（件数と内訳だけを出す）。
process.stdout.write(`${JSON.stringify({ plan_id: planId, roots: selected, written: process.argv.includes('--write'),
  items: items.length, bytes, by_kind: byKind, skipped }, null, 2)}\n`);
