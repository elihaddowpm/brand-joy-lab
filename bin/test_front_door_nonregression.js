#!/usr/bin/env node
/**
 * Non-regression harness for bjl-front-door.js.
 *
 * The front door is shared by three surfaces. When history threading was added
 * for the Joy Map clarifying loop, only the Joy Map pane passes
 * session_history — the connections-beta pane and the investigator do not. The
 * safety claim is that absent history is a STRICT NO-OP: the module issues the
 * same model calls and the same SQL it issued before the feature existed, so
 * the two surfaces that pass no history cannot drift.
 *
 * "They pass no history so they're unaffected" is exactly the kind of
 * true-sounding assumption that becomes a silent break. This file makes it a
 * checked property instead of an argument. It runs two versions of the module
 * side by side against stubbed, deterministic Anthropic and Supabase clients
 * and compares three things per fixture:
 *
 *   1. every argument handed to anthropic.messages.create
 *   2. every argument handed to supabase.rpc
 *   3. the returned brief
 *
 * Because the clients are deterministic, any difference in the captured
 * payloads is a difference in the code under test and nothing else. This is a
 * structural comparison, not a behavioural sample.
 *
 * It then proves the new behaviour is REACHABLE — with history, the classifier
 * payload must actually change. Without that, the no-op result above could be
 * satisfied by a feature that never fires, and the file would be worthless.
 *
 * Two failure modes are worth naming because both make this file lie:
 *
 *   - A constant canned model reply sends every fixture down one branch, so
 *     the comparison covers a single path and reads as full coverage. The
 *     fixture table therefore carries its own shape and its own resolve/fail
 *     outcome, and the stubs return usable rows so the stages PAST entity
 *     resolution actually execute. That property is ASSERTED, not merely
 *     arranged: a run that walks one shape, or that never escalates, or that
 *     always escalates, exits non-zero however clean the comparison was.
 *     Branch diversity living only in the fixture table would be a check that
 *     trusts its next editor, which is what a mechanical gate exists to avoid.
 *   - require's cache is keyed on the realpath. Deleting the wrong key returns
 *     the previous fixture's module, whose stubs still write into the previous
 *     fixture's capture array, and every fixture after the first reads as
 *     total drift. Use require.resolve.
 *
 * Usage:
 *   node bin/test_front_door_nonregression.js
 *       compares HEAD's copy of the module against the working tree.
 *   node bin/test_front_door_nonregression.js <baseline.js> <candidate.js>
 *       compares two explicit files.
 *
 * No node_modules and no database — the dependencies are stubbed, so this runs
 * anywhere node runs. Exit 0 means no drift AND the feature is reachable AND
 * the degenerate histories no-op AND the run was branch-diverse.
 */
const Module = require('module');
const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');
const { execFileSync } = require('child_process');

const MODULE_PATH = 'netlify/functions/bjl-front-door.js';

function resolveInputs() {
  const [, , a, b] = process.argv;
  if (a && b) return { baseline: path.resolve(a), candidate: path.resolve(b), label: 'explicit files' };
  const repo = path.resolve(__dirname, '..');
  const head = execFileSync('git', ['show', `HEAD:${MODULE_PATH}`], { cwd: repo });
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fd-baseline-')), 'baseline.js');
  fs.writeFileSync(tmp, head);
  return { baseline: tmp, candidate: path.join(repo, MODULE_PATH), label: `HEAD:${MODULE_PATH} vs working tree` };
}

// Real queries from bjl_front_door_log for the two shared consumers, plus the
// Joy Map ones so the new path is exercised on the same fixtures. `shape` is
// what the stubbed classifier will return, so the table drives coverage across
// the shape switch. `resolves: false` makes the semantic picker return nothing,
// which is the zero-entity escalation branch.
const FIXTURES = [
  { surface: 'connections',         query: 'Mcdonalds',                               shape: 'brand_lookup',        resolves: true },
  { surface: 'connections',         query: 'Being a fan of something',                shape: 'item_connection',     resolves: true },
  { surface: 'connections',         query: 'Going to a fast food restaurant',         shape: 'item_connection',     resolves: true },
  { surface: 'connections',         query: "Where's the whitespace in NA beer?",      shape: 'territory_read',      resolves: true },
  { surface: 'connections',         query: 'List all joy scores above 60',            shape: 'data_pull',           resolves: true },
  { surface: 'investigator',        query: 'What connects to going to a theme park?', shape: 'item_connection',     resolves: true },
  { surface: 'investigator',        query: 'Tell me about Silver Dollar City',        shape: 'brand_lookup',        resolves: true },
  { surface: 'investigator',        query: "What's my angle for pitching Cox?",       shape: 'outreach_angle',      resolves: true },
  { surface: 'investigator',        query: 'what is the weather tomorrow',            shape: 'out_of_scope',        resolves: true },
  { surface: 'public',              query: 'what brings people joy',                  shape: 'needs_clarification', resolves: true },
  { surface: 'joy_map_connections', query: 'Hotwire Communications',                  shape: 'brand_lookup',        resolves: false },
  { surface: 'joy_map_connections', query: 'Theme parks',                             shape: 'territory_read',      resolves: true },
  { surface: 'joy_map_connections', query: 'parents who like togetherness',           shape: 'audience_comparison', resolves: false },
];

// Two corpus items, enough for the shortlist, the picker and every capability
// lookup to succeed. The values are arbitrary but fixed.
const ITEMS = [
  { item_id: 1393, item_name: 'Going to a theme park', primary_topic: 'entertainment',
    canonical_brand: null, is_brand: false, is_location: false, hit_count: 2, in_centered: true },
  { item_id: 4856, item_name: 'Eating fast food', primary_topic: 'food_beverage',
    canonical_brand: 'McDonalds', is_brand: true, is_location: false, hit_count: 1, in_centered: true },
];

function cannedFor(system, messages, fx) {
  const query = messages[messages.length - 1].content;
  if (system.includes('You classify a strategist')) {
    return JSON.stringify({
      shape: fx.shape,
      shape_reasoning: 'canned',
      clarifying_question: fx.shape === 'needs_clarification' ? 'Which brand did you mean?' : null,
    });
  }
  if (system.includes('extract 2-5 short phrases')) {
    return JSON.stringify([query.slice(0, 20).toLowerCase(), 'theme park']);
  }
  return JSON.stringify({
    picks: fx.resolves ? ITEMS.map(i => i.item_id) : [],
    reason: 'canned',
    confidence: fx.resolves ? 'high' : 'low',
  });
}

// Routes on the SQL text: execute_read_sql is one rpc name carrying three
// structurally different queries, and returning one row shape for all of them
// would null out columns and hide branches.
function fakeReadSql(sql) {
  if (sql.includes('WITH matches AS')) return ITEMS;
  if (sql.includes('top_picks')) {
    return ITEMS.map(i => ({
      item_id: i.item_id, item_name: i.item_name, primary_topic: i.primary_topic,
      name_sim: 0.82, topic_match: true, respondents: 900, in_ledger: true, degree: 41,
    }));
  }
  if (sql.includes('WHERE item_name IN')) return ITEMS;
  return [];
}

function makeStubs(capture, fx) {
  class FakeAnthropic {
    constructor() {
      this.messages = {
        create: async (payload) => {
          const system = (payload.system || []).map(s => s.text).join('');
          capture.push({ kind: 'anthropic', payload });
          return { content: [{ type: 'text', text: cannedFor(system, payload.messages, fx) }] };
        },
      };
    }
  }

  const fakeSupabase = {
    from() {
      return {
        insert: async (row) => { capture.push({ kind: 'insert', row }); return { error: null }; },
        select() { return this; },
        eq() { return this; },
        single: async () => ({ data: null, error: null }),
      };
    },
    rpc: async (fn, args) => {
      capture.push({ kind: 'rpc', fn, args });
      if (fn === 'execute_read_sql') return { data: fakeReadSql(args.query_text), error: null };
      if (fn === 'bjl_item_capability') {
        return { data: ITEMS.map(i => ({ item_id: i.item_id, degree: 41, respondents: 900, in_ledger: true })), error: null };
      }
      if (fn === 'bjl_verbatim_depth') return { data: 137, error: null };
      return { data: [], error: null };
    },
  };

  return { FakeAnthropic, fakeSupabase };
}

function loadIsolated(file, capture, fx) {
  const { FakeAnthropic, fakeSupabase } = makeStubs(capture, fx);
  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === '@anthropic-ai/sdk') return { default: FakeAnthropic };
    if (request === '@supabase/supabase-js') return { createClient: () => fakeSupabase };
    if (request.endsWith('bjl-auth-helper')) {
      return { verifyAndAuthorize: async () => ({ ok: true, user: { email: 'x@y.z' } }) };
    }
    return origLoad.apply(this, arguments);
  };
  try {
    const key = require.resolve(path.resolve(file));
    delete require.cache[key];
    return require(key);
  } finally {
    Module._load = origLoad;
  }
}

(async () => {
  process.env.SUPABASE_URL = 'http://stub';
  process.env.SUPABASE_SERVICE_KEY = 'stub';
  process.env.ANTHROPIC_API_KEY = 'stub';

  const { baseline, candidate, label } = resolveInputs();
  console.log(`front-door non-regression: ${label}\n`);

  let mismatches = 0;

  // Branch coverage, tallied from what the run actually DID — not from what
  // FIXTURES declares. Reading the declarations back would certify the table
  // against itself and pass a run whose stubs collapsed every row onto one
  // path while the `shape` column still looked varied.
  //
  // `escalated_from` is the discriminator that makes the shape switch
  // observable from outside: on escalation the brief's own shape is rewritten
  // to needs_clarification, so the branch actually walked is the pre-escalation
  // shape when there is one and the final shape otherwise.
  const shapesWalked = new Map();
  const escalationOutcomes = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);

  for (const fx of FIXTURES) {
    const oldCap = [];
    const newCap = [];
    const oldMod = loadIsolated(baseline, oldCap, fx);
    const newMod = loadIsolated(candidate, newCap, fx);

    // NO session_history — exactly how connections-beta and the investigator
    // call this module today.
    const ctx = { surface: fx.surface, user_email: 'regress@bjl' };
    const oldBrief = await oldMod.bjlFrontDoor(fx.query, { ...ctx });
    const newBrief = await newMod.bjlFrontDoor(fx.query, { ...ctx });

    bump(shapesWalked, newBrief.escalated_from || newBrief.shape);
    bump(escalationOutcomes, newBrief.escalated_from ? 'escalated' : 'resolved');

    const oldCalls = oldCap.filter(c => c.kind === 'anthropic').map(c => c.payload);
    const newCalls = newCap.filter(c => c.kind === 'anthropic').map(c => c.payload);
    const oldSql = oldCap.filter(c => c.kind === 'rpc');
    const newSql = newCap.filter(c => c.kind === 'rpc');

    // escalated_from is new and additive, so it is excluded by name rather than
    // by a blanket "ignore keys the baseline didn't have" — which would hide
    // any future addition too.
    const stripNew = (b) => { const c = { ...b }; delete c.escalated_from; return c; };

    const checks = [
      ['MODEL-CALL', newCalls, oldCalls],
      ['SQL', newSql, oldSql],
      ['BRIEF', stripNew(newBrief), stripNew(oldBrief)],
    ];

    let ok = true;
    for (const [name, got, want] of checks) {
      try {
        assert.deepStrictEqual(got, want);
      } catch (e) {
        ok = false;
        mismatches++;
        console.log(`\n${name} DRIFT  [${fx.surface}] "${fx.query}"`);
        console.log(e.message.split('\n').slice(0, 30).join('\n'));
      }
    }

    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${fx.surface.padEnd(20)} ${JSON.stringify(fx.query).padEnd(44)} ` +
      `calls=${oldCalls.length} sql=${oldSql.length} shape=${oldBrief.shape}` +
      (newBrief.escalated_from ? ` escalated_from=${newBrief.escalated_from}` : '')
    );
  }

  console.log(`\n${FIXTURES.length} fixtures compared, ${mismatches} drift(s).`);

  // The check on the check. Printed in full on pass, not merely consumed by the
  // exit code: a silent pass that also happens to be diverse is one refactor
  // away from a silent pass that is not, and nobody would see the difference.
  // Shown, the way a near-zero floor_r is shown rather than asserted.
  const shapeList = [...shapesWalked.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const diverse = shapeList.length > 1
    && escalationOutcomes.has('escalated')
    && escalationOutcomes.has('resolved');
  console.log(
    `branch coverage: ${shapeList.length} shape(s) walked — ` +
    shapeList.map(([s, n]) => `${s}×${n}`).join(', ')
  );
  console.log(
    `escalation outcomes: ` +
    ['resolved', 'escalated'].map(k => `${k}=${escalationOutcomes.get(k) || 0}`).join(' ') +
    (diverse ? '' : '   <-- COLLAPSED: this run proves one path, not the switch')
  );

  // Reachability. If threading never fires, every assertion above passes
  // trivially and this file certifies nothing.
  const cap = [];
  const mod = loadIsolated(candidate, cap, { shape: 'brand_lookup', resolves: false });
  await mod.bjlFrontDoor('the budget travel category', {
    surface: 'joy_map_connections',
    user_email: 'regress@bjl',
    session_history: [
      { role: 'user', content: 'Hostelling International USA' },
      { role: 'assistant', content: "I couldn't find that brand in the corpus by name. Can you tell me the exact brand name, or the category it competes in?" },
    ],
  });
  const withHist = cap.filter(c => c.kind === 'anthropic')[0].payload;
  const threaded = withHist.messages.length === 3
    && withHist.messages[0].content === 'Hostelling International USA'
    && withHist.system[0].text.includes('CONVERSATION IN PROGRESS');
  console.log(`history threading reachable: ${threaded ? 'YES' : 'NO'} (messages=${withHist.messages.length})`);

  // Degenerate histories must fall back to the no-op, not to a repaired
  // reconstruction of a conversation that did not happen.
  const DEGENERATE = [
    ['empty array', []],
    ['null', null],
    ['non-alternating', [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }]],
    ['assistant first', [{ role: 'assistant', content: 'a' }]],
    ['junk entries', [{ nope: 1 }, 'string', null]],
  ];
  let degenerateOk = true;
  for (const [name, history] of DEGENERATE) {
    const c = [];
    const m = loadIsolated(candidate, c, { shape: 'out_of_scope', resolves: true });
    await m.bjlFrontDoor('Mcdonalds', { surface: 'connections', user_email: 'regress@bjl', session_history: history });
    const p = c.filter(x => x.kind === 'anthropic')[0].payload;
    const isNoop = p.messages.length === 1 && !p.system[0].text.includes('CONVERSATION IN PROGRESS');
    if (!isNoop) degenerateOk = false;
    console.log(`  degenerate history "${name}" -> ${isNoop ? 'no-op' : 'NOT A NO-OP'}`);
  }

  process.exit(mismatches === 0 && threaded && degenerateOk && diverse ? 0 : 1);
})();
