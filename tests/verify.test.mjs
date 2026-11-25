import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectAmazonRows, legacyRowProof, verifyAmazonSource, verifyCardSets } from '../lib/verify.mjs';
import { columns } from './phase-fixtures.mjs';

const id = 'D01-0000000-0000002';
const makeRow = (name, price, total) => ({ 'Order ID': id, 'Order Date': '2026-11-20', 'Product Name': name,
  'Original Quantity': '1', 'Unit Price': `${price}`, 'Shipment Item Subtotal': `${price}`, 'Total Amount': `${total}`, 'Total Discounts': '0' });

function sourceFixture(type, messages, rows) {
  const after = 1795484399;
  const create = (key) => ({ after, messages: type === key ? messages : [], ids: { type: key,
    id_source: 'query', query: `example after:${after}`, message_ids: type === key ? messages.map(({ id: messageId }) => messageId) : [] } });
  return { sources: { typeA: create('typeA'), typeB: create('typeB') },
    candidates: { rows: rows.map(([message, row]) => ({ type, message_id: message, row })), parse_failures: [],
      typeA_query: `example after:${after}`, typeB_query: `example after:${after}`,
      typeA_message_count: type === 'typeA' ? messages.length : 0, typeB_message_count: type === 'typeB' ? messages.length : 0,
      typeB_fetched_message_count: type === 'typeB' ? messages.length : 0, excluded_typeB_preorder_messages: 0 } };
}

test('Amazon verifies the repeated Type A order total for each item and each notification', () => {
  const cases = [{ id: 'a1', body: `注文番号: ${id}\n* Item A\n￥1,200\n* Item B\n￥1,000\n合計: ￥2,200` },
    { id: 'a2', body: `注文番号: ${id}\n* Item C\n￥900\n合計: ￥900` }];
  const { candidates, sources } = sourceFixture('typeA', cases, [['a1', makeRow('Item A', 1200, 2200)],
    ['a1', makeRow('Item B', 1000, 2200)], ['a2', makeRow('Item C', 900, 900)]]);
  assert.doesNotThrow(() => verifyAmazonSource(candidates, sources));
  candidates.rows[1].row['Total Amount'] = '300';
  assert.throws(() => verifyAmazonSource(candidates, sources), /VERIFY_MISMATCH/);
});

test('Amazon detects a missing Type B item even when the remaining total matches', () => {
  const message = { id: 'b1', body: `注文番号: ${id}\nItem A\n販売者: seller\n￥600\nItem B\n販売者: seller\n￥800\n*総計: ￥1,400` };
  const { candidates, sources } = sourceFixture('typeB', [message], [['b1', makeRow('Item A', 600, 600)], ['b1', makeRow('Item B', 800, 800)]]);
  assert.doesNotThrow(() => verifyAmazonSource(candidates, sources));
  candidates.rows.pop();
  candidates.rows[0].row['Total Amount'] = '1400';
  assert.throws(() => verifyAmazonSource(candidates, sources), /VERIFY_MISMATCH/);
});

test('Amazon holds ambiguous summaries and replaces only an individually verified row', () => {
  const old = makeRow('Item A', 1400, 1400);
  const values = columns.map((name) => old[name] ?? '');
  const csv = `${columns.join(',')}\n${values.join(',')}\n`;
  const rows = [makeRow('Item A', 600, 600), makeRow('Item B', 800, 800)].map((row) => ({ type: 'typeB', row }));
  assert.deepEqual(expectAmazonRows(csv, { rows }).rows, [values]);
  const permitted = expectAmazonRows(csv, { rows }, [legacyRowProof(columns, values)]);
  assert.deepEqual(permitted.replaced, [values]);
  assert.equal(permitted.rows.length, 2);
});

test('card verification bounds real IDs rather than counts', () => {
  const evidence = { searched: ['prior', 'new'], processed: ['prior'], fetched: ['new'], payload: ['new'],
    applied: ['new'], classifications: [{ id: 'new', outcome: 'inserted' }] };
  assert.doesNotThrow(() => verifyCardSets(evidence));
  assert.throws(() => verifyCardSets({ ...evidence, payload: ['wrong'] }), /VERIFY_MISMATCH/);
  assert.throws(() => verifyCardSets({ ...evidence, fetched: [] }), /VERIFY_MISMATCH/);
});
