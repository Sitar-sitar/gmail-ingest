import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { saveState } from '../lib/state.mjs';

export const columns = ['Order ID', 'Order Date', 'Product Name', 'Original Quantity', 'Unit Price', 'Shipment Item Subtotal',
  'Total Amount', 'Total Discounts', ...Array.from({ length: 20 }, (_, index) => `Column ${index + 1}`)];
export const fingerprint = 'a'.repeat(64);
export const time = new Date('2026-11-25T12:00:00.000Z');

export function stateFixture(through = '2026-11-21') {
  const target = () => ({ confirmed_through: through, last_success: '', last_outcome: '' });
  return { schema_version: 2, account_fingerprint: fingerprint, business_from: '2026-01-01',
    amazon: { type_a: target(), type_b: target() }, credit_card: { smbc: target(), rakuten_card: target(), jcb_ekenet: target() },
    last_run: { started_at: '', finished_at: '', exit_code: null, attempted_slot: '', completed_slot: '' }, cleared_failures: [] };
}

export function temp(t, label) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), `Gmail ingest ${label} `)));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

export function profileFixture(t) {
  const profile = temp(t, 'profile');
  const roots = { runner: path.join(profile, 'gmail-ingest'), amazon: path.join(profile, 'amazon-tracker'), card: path.join(profile, 'credit-card-tracker') };
  const ordersCsv = path.join(roots.amazon, 'public', 'data', 'orders.csv');
  const cardDb = path.join(roots.card, 'data', 'credit-card.db');
  const authFile = path.join(roots.runner, 'data', 'gmail-auth', 'oauth.json');
  const stateDir = path.join(roots.runner, 'state');
  const stateFile = path.join(stateDir, 'last-run.json');
  for (const file of [ordersCsv, cardDb, authFile, stateFile]) mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(ordersCsv, `${columns.join(',')}\n`);
  writeFileSync(cardDb, 'synthetic DB');
  writeFileSync(authFile, '{}');
  saveState(stateFile, stateFixture());
  return { profile, roots, ordersCsv, cardDb, authFile, stateDir, stateFile };
}
