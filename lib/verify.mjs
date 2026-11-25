import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export class VerificationError extends Error {
  constructor() { super('VERIFY_MISMATCH'); }
}

function requireMatch(condition) {
  if (!condition) throw new VerificationError();
}

export function strictIds(values) {
  requireMatch(Array.isArray(values) && values.every((item) => typeof item === 'string' && item.length > 0));
  const ids = new Set(values);
  requireMatch(ids.size === values.length);
  return ids;
}

export function verifyCardSets({ searched, processed, fetched, payload, applied, classifications }) {
  const searchIds = strictIds(searched);
  const processedIds = strictIds(processed);
  const fetchedIds = strictIds(fetched);
  const payloadIds = strictIds(payload);
  const appliedIds = strictIds(applied);
  requireMatch(searchIds.size === processedIds.size + fetchedIds.size &&
    fetchedIds.size === payloadIds.size && fetchedIds.size === appliedIds.size);
  for (const id of processedIds) requireMatch(searchIds.has(id) && !fetchedIds.has(id));
  for (const id of fetchedIds) requireMatch(searchIds.has(id) && payloadIds.has(id) && appliedIds.has(id));
  requireMatch(Array.isArray(classifications));
  const classified = strictIds(classifications.map((value) => value?.id));
  requireMatch(classified.size === appliedIds.size);
  for (const { id, outcome } of classifications) {
    requireMatch(appliedIds.has(id) && ['inserted', 'duplicate', 'ignored', 'failed'].includes(outcome));
  }
}

export function readJsonLines(file) {
  return readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
}

function bodyLines(body) {
  return String(body ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function integer(value) {
  const cleaned = String(value ?? '').trim().replaceAll(',', '');
  return /^\d+$/.test(cleaned) && Number.isSafeInteger(Number(cleaned)) ? Number(cleaned) : NaN;
}

function yen(text) {
  const match = /[￥¥]\s*([\d,]+)|([\d,]+)\s*(?:JPY|円)/i.exec(text ?? '');
  return integer(match?.[1] ?? match?.[2]);
}

function firstMoney(lines) {
  return lines.map(yen).find(Number.isFinite);
}

function labeledMoney(lines, label) {
  const index = lines.findIndex((line) => label.test(line));
  if (index === -1) return undefined;
  return firstMoney(lines.slice(index, index + 4));
}

function amazonName(text) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(text ?? '').replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, value) => {
    if (!value.startsWith('#')) return entities[value.toLowerCase()] ?? match;
    const number = /^#x/i.test(value) ? Number.parseInt(value.slice(2), 16) : Number(value.slice(1));
    return number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : match;
  }).trim();
}

function preorder(message) {
  return /^お客様の(?:の)?予約注文/.test(amazonName(message.subject)) &&
    /発売日に[^\n]*請求/.test(message.body) && !/注文日[:：]|\*?総計[:：]/.test(message.body);
}

function itemBags(items) {
  return bag(items.map((item) => JSON.stringify(item)));
}

function verifyTypeA(message, candidates) {
  const lines = bodyLines(message.body);
  const items = [];
  for (const [index, line] of lines.entries()) {
    if (!line.startsWith('* ')) continue;
    const following = lines.slice(index + 1, index + 7);
    const quantity = integer(/^数量\s*:\s*(\d+)/.exec(following.slice(0, 4).find((part) => /^数量\s*:\s*\d+/.test(part)) ?? '')?.[1] ?? 1);
    const price = firstMoney(following.filter((part) => !/^数量\s*:/.test(part)));
    requireMatch(Number.isSafeInteger(price) && quantity > 0);
    items.push([line.slice(2).trim(), quantity, price]);
  }
  const totalLabel = lines.findIndex((line) => /合計/.test(line) && !/税引前/.test(line));
  const total = totalLabel < 0 ? items.reduce((sum, [, quantity, price]) => sum + quantity * price, 0) : firstMoney(lines.slice(totalLabel));
  requireMatch(items.length > 0 && total > 0 && sameBag(itemBags(items), itemBags(candidates.map((row) => [
    row['Product Name'], integer(row['Original Quantity']), integer(row['Unit Price']),
  ]))));
  for (const row of candidates) requireMatch(integer(row['Total Amount']) === total &&
    integer(row['Shipment Item Subtotal']) === integer(row['Unit Price']) * integer(row['Original Quantity']));
}

function sellerItems(body) {
  const lines = bodyLines(body);
  return lines.flatMap((line, index) => /^販売者[:：]/.test(line)
    ? [[amazonName(lines[index - 1]), 1, firstMoney(lines.slice(index + 1, index + 7))]] : []);
}

function verifyTypeB(message, candidates) {
  const lines = bodyLines(message.body);
  const total = labeledMoney(lines, /^\*?\s*総計[:：]/) ?? labeledMoney(lines, /^合計[:：]/);
  const discount = labeledMoney(lines, /^(?:キャンペーン|プロモーション)[:：]/) ?? 0;
  const htmlItems = sellerItems(message.html_body);
  const items = htmlItems.length ? htmlItems : sellerItems(message.body);
  // Older single-item notifications can identify the item in the subject.
  const subjectItem = /^Amazon\.co\.jpでのご注文:\s*(.+)$/i.exec(amazonName(message.subject))?.[1];
  if (items.length === 1 && subjectItem) items[0][0] = subjectItem;
  if (items.length === 0 && subjectItem && Number.isSafeInteger(total)) items.push([subjectItem, 1, total]);
  requireMatch(items.length > 0 && items.every(([name, , amount]) => name && Number.isSafeInteger(amount)) &&
    sameBag(itemBags(items), itemBags(candidates.map((row) => [
      row['Product Name'], integer(row['Original Quantity']), integer(row['Unit Price']),
    ]))) && candidates.every((row) => integer(row['Unit Price']) === integer(row['Shipment Item Subtotal'])));
  requireMatch(candidates.reduce((sum, row) => sum + integer(row['Total Amount']), 0) === total &&
    candidates.reduce((sum, row) => sum + integer(row['Total Discounts']), 0) === discount);
}

export function verifyAmazonSource(candidates, sources) {
  requireMatch(Array.isArray(candidates?.rows) && Array.isArray(candidates.parse_failures) && candidates.parse_failures.length === 0);
  for (const candidate of candidates.rows) {
    requireMatch(['typeA', 'typeB'].includes(candidate?.type) && typeof candidate.message_id === 'string' &&
      ['Order ID', 'Order Date', 'Product Name', 'Unit Price', 'Total Amount'].every((key) => String(candidate.row?.[key] ?? '').trim()));
  }
  for (const type of ['typeA', 'typeB']) {
    const { ids, messages, after } = sources[type];
    const allIds = strictIds(ids.message_ids);
    const fetched = strictIds(messages.map((message) => message.id));
    const dateToken = String(after).replaceAll('-', '/');
    requireMatch(ids.type === type && ids.id_source === 'query' && ids.query === candidates[`${type}_query`] &&
      ids.query?.endsWith(` after:${dateToken}`) && allIds.size === fetched.size && [...allIds].every((id) => fetched.has(id)));
    const eligible = messages.filter((message) => type === 'typeA' || !preorder(message));
    requireMatch(candidates[`${type}_message_count`] === eligible.length);
    if (type === 'typeB') requireMatch(candidates.typeB_fetched_message_count === messages.length &&
      candidates.excluded_typeB_preorder_messages === messages.length - eligible.length);
    const eligibleIds = new Set(eligible.map((message) => message.id));
    const rows = candidates.rows.filter((candidate) => candidate.type === type);
    requireMatch(rows.every(({ message_id: id }) => eligibleIds.has(id)));
    for (const message of eligible) {
      const own = rows.filter(({ message_id: id }) => id === message.id).map(({ row }) => row);
      const orderId = /\b[A-Z0-9]{3}-\d{7}-\d{7}\b/.exec(message.body)?.[0];
      requireMatch(orderId && own.length > 0 && own.every((row) => row['Order ID'] === orderId));
      if (type === 'typeA') verifyTypeA(message, own);
      else verifyTypeB(message, own);
    }
  }
}

export function parseOrders(text) {
  const parsed = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && char === ',') {
      row.push(field);
      field = '';
    } else if (!quoted && char === '\n') {
      row.push(field);
      parsed.push(row);
      row = [];
      field = '';
    } else if (quoted || char !== '\r') field += char;
  }
  requireMatch(!quoted);
  if (row.length || field) parsed.push([...row, field]);
  const [header = [], ...data] = parsed;
  const rows = data.filter((value) => value.length > 1 || value[0] !== '');
  const id = header.indexOf('Order ID');
  requireMatch(header.length === 28 && new Set(header).size === 28 && id >= 0 &&
    rows.every((value) => value.length === 28 && value[id].trim()));
  return { header, rows };
}

function bag(values) {
  const result = new Map();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

function sameBag(first, second) {
  return first.size === second.size && [...first].every(([key, count]) => second.get(key) === count);
}

function moneyKey(value) {
  const decimal = String(value ?? '').trim().replaceAll(',', '');
  return /^-?\d+(\.\d+)?$/.test(decimal) && Number.isFinite(Number(decimal)) ? String(Number(decimal)) : '';
}

function rowKeys(row) {
  const id = row['Order ID'].trim();
  const name = row['Product Name'].trim();
  const quantity = row['Original Quantity'].trim();
  const date = /^\d{4}-\d{2}-\d{2}/.exec(row['Order Date'])?.[0] ?? '';
  const partial = [name, quantity, date].join('|');
  const amount = [moneyKey(row['Unit Price']), moneyKey(row['Total Amount'])].join('|');
  return { id, name, quantity, date, partial, amount, exact: [id, name, quantity, amount, date].join('|') };
}

export function legacyRowProof(header, row) {
  return createHash('sha256').update(JSON.stringify([header, row])).digest('hex');
}

export function expectAmazonRows(csvBefore, candidates, approvedSummaries = []) {
  const before = parseOrders(csvBefore);
  requireMatch(before.rows.every((row) => row.every((value) => !/[\r\n]/.test(value))));
  const rowValues = (row) => before.header.map((name) => String(row[name] ?? ''));
  const keyed = (values) => rowKeys(Object.fromEntries(before.header.map((field, index) => [field, values[index]])));
  const existing = before.rows.map((values) => ({ values, ...keyed(values) }));
  const incoming = candidates.rows.map(({ type, row }) => ({ type, values: rowValues(row), ...keyed(rowValues(row)) }));
  const previousCounts = bag(existing.map(({ id }) => id));
  const candidatesByOrder = groupDigitalOrders(incoming);
  const replaced = [];
  const pending = new Set();
  const replaceIds = new Set();
  for (const prior of existing) {
    const group = candidatesByOrder.get(prior.id) ?? [];
    if (group.length < 2 || previousCounts.get(prior.id) !== 1 ||
        prior.quantity !== '1' || !group.every(({ date }) => date === prior.date) ||
        !group.some(({ name }) => name === prior.name) || prior.amount.split('|').some((part) => !part)) continue;
    if (approvedSummaries.includes(legacyRowProof(before.header, prior.values))) {
      replaced.push(prior);
      replaceIds.add(prior.id);
    } else pending.add(prior.id);
  }
  const retained = existing.filter((row) => !replaceIds.has(row.id));
  const appended = [];
  const outcome = { duplicate: 0, excluded: 0, isolated: 0, pending: 0 };
  const known = [...retained];
  const exact = new Set(known.map((row) => row.exact));
  const amounts = new Map();
  for (const row of known) {
    const values = amounts.get(row.partial) ?? new Set();
    values.add(row.amount);
    amounts.set(row.partial, values);
  }
  for (const row of incoming) {
    const money = row.amount.split('|');
    if (!row.id || money.some((value) => !value || (row.type === 'typeA' && Number(value) === 0))) outcome.excluded++;
    else if (row.type === 'typeB' && pending.has(row.id)) outcome.pending++;
    else if (exact.has(row.exact)) outcome.duplicate++;
    else {
      const values = amounts.get(row.partial);
      if (values && !values.has(row.amount) && !replaceIds.has(row.id)) outcome.isolated++;
      else {
        appended.push(row.values);
        exact.add(row.exact);
        amounts.set(row.partial, new Set([...(values ?? []), row.amount]));
      }
    }
  }
  return { header: before.header, rows: [...retained.map((row) => row.values), ...appended.map((row) => row.map((value) => value.replace(/[\r\n]+/g, ' ')))],
    replaced: replaced.map((row) => row.values), appended: appended.length, outcome };
}

function groupDigitalOrders(incoming) {
  const groups = new Map();
  for (const row of incoming) {
    if (row.type !== 'typeB') continue;
    const group = groups.get(row.id) ?? [];
    group.push(row);
    groups.set(row.id, group);
  }
  return groups;
}

export function verifyAmazonApplied({ expected, csvBefore, csvAfter, backup, isolation, stats, candidateCount }) {
  const actual = parseOrders(csvAfter);
  const excluded = ['invalid_type', 'invalid_row', 'empty_order_id', 'amount_missing_typeA', 'amount_missing_typeB']
    .map((field) => stats[`excluded_${field}`]);
  requireMatch(excluded.every((count) => Number.isSafeInteger(count) && count >= 0));
  const excludedCount = excluded.reduce((sum, value) => sum + value, 0);
  requireMatch(stats.validation?.ok === true && stats.backup?.created === true && backup === csvBefore &&
    JSON.stringify(actual.header) === JSON.stringify(expected.header) && sameBag(itemBags(actual.rows), itemBags(expected.rows)) &&
    Array.isArray(isolation) && isolation.length === expected.outcome.isolated &&
    stats.isolated_amount_diff_only === expected.outcome.isolated && stats.appended?.total === expected.appended &&
    stats.skipped_exact === expected.outcome.duplicate && excludedCount === expected.outcome.excluded &&
    stats.excluded_pending_summary === expected.outcome.pending && stats.replaced_typeB_summary_rows === expected.replaced.length &&
    Array.isArray(stats.replaced_rows) && sameBag(itemBags(stats.replaced_rows), itemBags(expected.replaced)) &&
    stats.candidates?.total === candidateCount &&
    candidateCount === expected.appended + expected.outcome.duplicate + excludedCount + isolation.length + expected.outcome.pending);
}
