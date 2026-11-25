import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { isTimestamp, loadState, replaceJson } from './state.mjs';
import { parseOrders } from './verify.mjs';

const CORE_FILES = ['orders.csv', 'credit-card.db', 'last-run.json'];
const TABLES = ['transactions', 'email_messages', 'transaction_sources', 'import_runs'];

async function getDatabase(cardRoot) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    return (file) => new DatabaseSync(file, { readOnly: true });
  } catch (error) {
    if (error.code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw error;
    const Database = createRequire(path.join(cardRoot, 'package.json'))('better-sqlite3');
    return (file) => new Database(file, { readonly: true, fileMustExist: true });
  }
}

function dbCounts(db) {
  const result = {};
  for (const table of TABLES) {
    if (db.prepare('SELECT name FROM sqlite_master WHERE type=\'table\' AND name=?').get(table)) {
      result[table] = db.prepare(`SELECT count(*) AS count FROM "${table}"`).get().count;
    }
  }
  if (!Number.isSafeInteger(result.transactions)) throw new Error('INVALID_BACKUP_DB');
  return result;
}

function fileDigest(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || realpathSync.native(file).toLowerCase() !== file.toLowerCase()) throw new Error('INVALID_RESTORE_FILE');
  return { sha256: createHash('sha256').update(readFileSync(file)).digest('hex'), bytes: stat.size };
}

async function validateFiles(directory, manifest, openDb) {
  const copies = path.join(directory, `.verify-${randomUUID()}`);
  mkdirSync(copies);
  const filenames = Object.keys(manifest.files);
  try {
    for (const name of filenames) {
      if (!CORE_FILES.includes(name) && !/^legacy-(?:amazon|card-\d+)\.md$/.test(name)) throw new Error('INVALID_RESTORE_FILE');
      const source = path.join(directory, name);
      const actual = fileDigest(source);
      if (actual.sha256 !== manifest.files[name].sha256 || actual.bytes !== manifest.files[name].bytes) {
        throw new Error('RESTORE_HASH_MISMATCH');
      }
      copyFileSync(source, path.join(copies, name));
      if (fileDigest(path.join(copies, name)).sha256 !== actual.sha256) throw new Error('RESTORE_HASH_MISMATCH');
    }
    const db = openDb(path.join(copies, 'credit-card.db'));
    try {
      const checks = db.prepare('PRAGMA quick_check').all();
      if (checks.length !== 1 || Object.values(checks[0])[0] !== 'ok' || JSON.stringify(dbCounts(db)) !== JSON.stringify(manifest.db_counts)) {
        throw new Error('RESTORE_DB_MISMATCH');
      }
    } finally { db.close(); }
    if (parseOrders(readFileSync(path.join(copies, 'orders.csv'), 'utf8')).rows.length !== manifest.csv_rows ||
        loadState(path.join(copies, 'last-run.json')).schema_version !== manifest.state_schema) throw new Error('RESTORE_CONTENT_MISMATCH');
  } finally {
    for (const name of readdirSync(copies)) unlinkSync(path.join(copies, name));
    rmdirSync(copies);
  }
}

export async function verifyRestoreSet(directory, cardRoot) {
  const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.generation !== path.basename(directory) || manifest.status !== 'verified' ||
      !isTimestamp(manifest.created_at) || !CORE_FILES.every((name) => manifest.files?.[name]) ||
      manifest.locks?.amazon !== true || manifest.locks?.card !== true) throw new Error('INCOMPLETE_RESTORE_SET');
  await validateFiles(directory, manifest, await getDatabase(cardRoot));
  return manifest;
}

function pruneGenerations(parent, active) {
  const verified = [];
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}T[\da-f.Z-]+$/.test(entry.name)) continue;
    const directory = path.join(parent, entry.name);
    try {
      fileDigest(path.join(directory, 'manifest.json'));
      const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
      const members = readdirSync(directory);
      const declared = Object.keys(manifest.files ?? {});
      if (manifest.generation !== entry.name || manifest.status !== 'verified' || !isTimestamp(manifest.created_at) ||
          declared.length + 1 !== members.length || !CORE_FILES.every((name) => declared.includes(name)) ||
          declared.some((name) => !CORE_FILES.includes(name) && !/^legacy-(?:amazon|card-\d+)\.md$/.test(name)) ||
          !declared.every((name) => members.includes(name))) continue;
      for (const name of declared) fileDigest(path.join(directory, name));
      verified.push({ directory, createdAt: manifest.created_at, members });
    } catch { /* An incomplete or altered generation is left for review. */ }
  }
  verified.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const discard = verified.filter(({ directory }) => directory !== active).slice(2);
  for (const { directory, members } of discard) {
    for (const name of members) unlinkSync(path.join(directory, name));
    rmdirSync(directory);
  }
}

export async function createRestoreSet({ stateDir, stateFile, ordersCsv, cardDb, cardRoot, lockHeld, at, legacyFiles = [] }) {
  if (!lockHeld?.amazon || !lockHeld?.card) throw new Error('RESTORE_LOCK_REQUIRED');
  const generation = `${at.toISOString().replaceAll(':', '-')}-${randomUUID()}`;
  const destination = path.join(stateDir, 'restore-sets', generation);
  const manifestFile = path.join(destination, 'manifest.json');
  const manifest = { generation, created_at: at.toISOString(), status: 'incomplete', locks: { amazon: true, card: true }, files: {} };
  const sources = new Map([['orders.csv', ordersCsv], ['credit-card.db', cardDb], ['last-run.json', stateFile], ...legacyFiles]);
  for (const name of sources.keys()) {
    if (!CORE_FILES.includes(name) && !/^legacy-(?:amazon|card-\d+)\.md$/.test(name)) throw new Error('INVALID_RESTORE_FILE');
  }
  mkdirSync(destination, { recursive: true });
  replaceJson(manifestFile, manifest);
  const openDb = await getDatabase(cardRoot);
  const db = openDb(cardDb);
  try {
    manifest.db_counts = dbCounts(db);
    const target = path.join(destination, 'credit-card.db');
    db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  } finally { db.close(); }
  for (const [name, source] of sources) {
    const target = path.join(destination, name);
    if (name !== 'credit-card.db') {
      fileDigest(source);
      copyFileSync(source, target);
    }
    manifest.files[name] = { ...fileDigest(target), source, acquired_at: new Date().toISOString() };
  }
  manifest.csv_rows = parseOrders(readFileSync(path.join(destination, 'orders.csv'), 'utf8')).rows.length;
  manifest.state_schema = loadState(path.join(destination, 'last-run.json')).schema_version;
  await validateFiles(destination, manifest, openDb);
  manifest.status = 'verified';
  replaceJson(manifestFile, manifest);
  pruneGenerations(path.dirname(destination), destination);
  return { generation, destination };
}
