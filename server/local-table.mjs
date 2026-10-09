// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const key = item => JSON.stringify([item.pk, item.sk]);
const copy = value => value === undefined ? undefined : structuredClone(value);
const failure = name => Object.assign(new Error(name), { name });

// A deliberately small, fail-closed interpreter for the DynamoDB expressions used by the API.
// Transactions run under one promise queue and commit via a single atomic JSON-file rename.
function condition(expression, row, names = {}, values = {}) {
  if (!expression) return true;
  const tokens = expression.match(/attribute_not_exists|attribute_exists|attribute_type|AND|OR|<=|>=|<>|[=<>(),]|[#:a-zA-Z_][\w#:-]*/g) || [];
  let position = 0;
  const consume = expected => { const token = tokens[position++]; if (expected && token !== expected) throw new Error(`Unsupported local condition: ${expression}`); return token; };
  const value = token => token.startsWith(':') ? values[token] : row?.[names[token] || token];
  function atom() {
    if (tokens[position] === '(') { consume('('); const result = or(); consume(')'); return result; }
    const token = consume();
    if (['attribute_exists', 'attribute_not_exists', 'attribute_type'].includes(token)) {
      consume('('); const field = value(consume());
      let result = token === 'attribute_exists' ? field !== undefined : field === undefined;
      if (token === 'attribute_type') { consume(','); const type = value(consume()); if (type !== 'NULL') throw new Error('Unsupported local attribute type'); result = field === null; }
      consume(')'); return result;
    }
    const a = value(token), operator = consume(), b = value(consume());
    if (a === undefined || b === undefined) return false;
    switch (operator) { case '=': return a === b; case '<>': return a !== b; case '<': return a < b; case '<=': return a <= b; case '>': return a > b; case '>=': return a >= b; default: throw new Error('Unsupported local comparison'); }
  }
  function and() { let result = atom(); while (tokens[position] === 'AND') { consume(); const next = atom(); result = result && next; } return result; }
  function or() { let result = and(); while (tokens[position] === 'OR') { consume(); const next = and(); result = result || next; } return result; }
  const result = or();
  if (position !== tokens.length) throw new Error(`Unsupported local condition: ${expression}`);
  return result;
}
function update(row, input) {
  const names = input.ExpressionAttributeNames || {}, values = input.ExpressionAttributeValues || {};
  const name = value => names[value] || value;
  const expression = input.UpdateExpression;
  for (const [, operation, body] of expression.matchAll(/\b(SET|ADD|REMOVE)\s+([\s\S]*?)(?=\s+(?:SET|ADD|REMOVE)\s+|$)/g)) {
    for (const part of body.split(/,(?![^()]*\))/).map(value => value.trim())) {
      if (operation === 'REMOVE') { delete row[name(part)]; continue; }
      if (operation === 'ADD') { const [field, token] = part.split(/\s+/); if (typeof values[token] !== 'number') throw new Error('Unsupported local ADD'); row[name(field)] = (row[name(field)] || 0) + values[token]; continue; }
      const match = part.match(/^([#\w]+)\s*=\s*(.*)$/);
      if (!match) throw new Error('Unsupported local SET');
      const [, field, rhs] = match;
      const fallback = rhs.match(/^if_not_exists\(([#\w]+),\s*(:\w+)\)$/);
      if (!fallback && !Object.hasOwn(values, rhs)) throw new Error(`Unsupported local SET value: ${rhs}`);
      row[name(field)] = fallback ? (row[name(fallback[1])] ?? values[fallback[2]]) : values[rhs];
    }
  }
  return row;
}
export async function createLocalTable(file) {
  await mkdir(dirname(file), { recursive: true });
  let rows;
  try { rows = new Map(JSON.parse(await readFile(file, 'utf8')).map(row => [key(row), row])); } catch (error) { if (error.code !== 'ENOENT') throw error; rows = new Map(); }
  let queue = Promise.resolve();
  function mutate(table, type, input) {
    const recordKey = key(input.Key || input.Item), existing = table.get(recordKey);
    if (!condition(input.ConditionExpression, existing, input.ExpressionAttributeNames, input.ExpressionAttributeValues)) throw failure('ConditionalCheckFailedException');
    if (type === 'Put') table.set(recordKey, copy(input.Item));
    else if (type === 'Delete') table.delete(recordKey);
    else if (type === 'Update') table.set(recordKey, update(copy(existing || input.Key), input));
    else throw new Error(`Unsupported local mutation: ${type}`);
  }
  return {
    send(command) {
      const result = queue.then(async () => {
        const input = command.input, type = command.constructor.name;
        if (type === 'GetCommand') return { Item: copy(rows.get(key(input.Key))) };
        if (type === 'QueryCommand') {
          if (input.KeyConditionExpression !== 'pk = :pk AND begins_with(sk, :prefix)') throw new Error('Unsupported local query');
          return { Items: copy([...rows.values()].filter(row => row.pk === input.ExpressionAttributeValues[':pk'] && row.sk.startsWith(input.ExpressionAttributeValues[':prefix'])).sort((a, b) => a.sk.localeCompare(b.sk))) };
        }
        const draft = new Map([...rows].map(([k, row]) => [k, copy(row)]));
        if (type === 'TransactWriteCommand') {
          try { for (const operation of input.TransactItems) { const [kind, data] = Object.entries(operation)[0]; mutate(draft, kind, data); } }
          catch (error) { if (error.name === 'ConditionalCheckFailedException') throw failure('TransactionCanceledException'); throw error; }
        } else mutate(draft, type.replace(/Command$/, ''), input);
        await writeFile(`${file}.next`, JSON.stringify([...draft.values()], null, 2));
        await rename(`${file}.next`, file);
        rows = draft;
        return {};
      });
      queue = result.catch(() => {});
      return result;
    },
  };
}
