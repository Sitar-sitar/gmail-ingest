import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildChildEnv, resolveChildPaths } from '../lib/env.mjs';

function fixture(t) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'gmail ingest env ')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const amazonRoot = path.join(root, 'amazon-tracker');
  const cardRoot = path.join(root, 'credit-card-tracker');
  const authFile = path.join(root, 'gmail-ingest', 'data', 'gmail-auth', 'oauth.json');
  const ordersCsv = path.join(amazonRoot, 'public', 'data', 'orders.csv');
  const cardDb = path.join(cardRoot, 'data', 'credit-card.db');
  for (const file of [ordersCsv, cardDb, authFile]) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'synthetic fixture');
  }
  return { amazonRoot, cardRoot, authFile, ordersCsv, cardDb,
    originMapping: path.join(amazonRoot, 'data', 'gmail-origin.json') };
}

test('sets fixed destinations and only allows the explicit child environment', (t) => {
  const files = fixture(t);
  assert.deepEqual(resolveChildPaths(files), files);
  const parentEnv = Object.fromEntries([
    'AMZ_GMAIL_ACCESS_TOKEN', 'GMAIL_ACCESS_TOKEN', 'CREDIT_CARD_GMAIL_ACCESS_TOKEN',
    'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_GMAIL_AUTH_FILE',
    'AMZ_GMAIL_IMPORT_CANDIDATES_FILE', 'AMZ_GMAIL_IMPORT_ISOLATED_FILE', 'NODE_OPTIONS',
    'GMAIL_AUTH_FILE', 'GMAIL_INGEST_LOCK_TOKEN', 'AMZ_GMAIL_IMPORT_ORDERS_CSV', 'CREDIT_CARD_DB_PATH',
    'AMZ_GMAIL_ORIGIN_FILE',
  ].map((name) => [name, 'synthetic override']));
  parentEnv.Path = 'synthetic path';
  parentEnv.SYSTEMROOT = 'synthetic system root';
  assert.deepEqual(buildChildEnv(files, { parentEnv, lockToken: 'local owner' }), {
    PATH: 'synthetic path', SystemRoot: 'synthetic system root', GMAIL_AUTH_FILE: files.authFile,
    AMZ_GMAIL_IMPORT_ORDERS_CSV: files.ordersCsv, AMZ_GMAIL_ORIGIN_FILE: files.originMapping,
    CREDIT_CARD_DB_PATH: files.cardDb, GMAIL_INGEST_LOCK_TOKEN: 'local owner',
  });
});

test('rejects a redirect from a fixed path to another directory', (t) => {
  const files = fixture(t);
  const original = path.dirname(files.ordersCsv);
  const redirected = path.join(files.amazonRoot, 'redirected');
  renameSync(original, redirected);
  symlinkSync(redirected, original, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => resolveChildPaths(files), /OUTPUT_MISMATCH/);
});

test('rejects a hard-linked business file and missing auth', (t) => {
  const files = fixture(t);
  const linked = path.join(files.cardRoot, 'linked.db');
  linkSync(files.cardDb, linked);
  assert.throws(() => resolveChildPaths(files), /OUTPUT_MISMATCH/);
  rmSync(linked);
  rmSync(files.authFile);
  assert.throws(() => resolveChildPaths(files), /AUTH/);
});
