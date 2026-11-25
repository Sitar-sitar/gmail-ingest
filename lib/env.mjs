import { lstatSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

const SYSTEM_ENV = ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'];

function isSamePath(original, resolved) {
  return process.platform === 'win32'
    ? original.toLowerCase() === resolved.toLowerCase()
    : original === resolved;
}

function verifiedPath(file, { directory = false, failure = 'OUTPUT_MISMATCH' } = {}) {
  if (!path.isAbsolute(file)) throw new Error(failure);
  const expected = path.normalize(file);
  let actual;
  let stat;
  try {
    actual = realpathSync.native(expected);
    stat = statSync(actual);
  } catch {
    throw new Error(failure);
  }
  if (!isSamePath(expected, actual) || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) {
    throw new Error(failure);
  }
  return actual;
}

export function assertUnredirected(file) {
  if (!path.isAbsolute(file)) throw new Error('OUTPUT_MISMATCH');
  const expected = path.normalize(file);
  for (let portion = expected; ; portion = path.dirname(portion)) {
    try {
      const stat = lstatSync(portion);
      if (stat.isSymbolicLink() || (stat.isFile() && (stat.nlink !== 1 || portion !== expected)) ||
          !isSamePath(portion, realpathSync.native(portion))) throw new Error('OUTPUT_MISMATCH');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (path.dirname(portion) === portion) return expected;
  }
}

export function resolveChildPaths({ amazonRoot, cardRoot, authFile, checkAuth = true }) {
  const amazon = verifiedPath(amazonRoot, { directory: true });
  const card = verifiedPath(cardRoot, { directory: true });
  return {
    amazonRoot: amazon,
    cardRoot: card,
    ordersCsv: verifiedPath(path.join(amazon, 'public', 'data', 'orders.csv')),
    cardDb: verifiedPath(path.join(card, 'data', 'credit-card.db')),
    authFile: checkAuth ? verifiedPath(authFile, { failure: 'AUTH' }) : authFile,
  };
}

export function buildChildEnv(paths, { parentEnv = process.env, lockToken } = {}) {
  const inherited = new Map(Object.entries(parentEnv).map(([key, value]) => [key.toLowerCase(), value]));
  const environment = {};
  for (const name of SYSTEM_ENV) {
    const value = inherited.get(name.toLowerCase());
    if (typeof value === 'string') environment[name] = value;
  }
  environment.GMAIL_AUTH_FILE = paths.authFile;
  environment.AMZ_GMAIL_IMPORT_ORDERS_CSV = paths.ordersCsv;
  environment.CREDIT_CARD_DB_PATH = paths.cardDb;
  if (lockToken) environment.GMAIL_INGEST_LOCK_TOKEN = lockToken;
  return environment;
}
