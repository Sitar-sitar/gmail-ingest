import { realpathSync, statSync } from 'node:fs';
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

export function resolveChildPaths({ amazonRoot, cardRoot, authFile }) {
  const amazon = verifiedPath(amazonRoot, { directory: true });
  const card = verifiedPath(cardRoot, { directory: true });
  return {
    amazonRoot: amazon,
    cardRoot: card,
    ordersCsv: verifiedPath(path.join(amazon, 'public', 'data', 'orders.csv')),
    cardDb: verifiedPath(path.join(card, 'data', 'credit-card.db')),
    authFile: verifiedPath(authFile, { failure: 'AUTH' }),
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
