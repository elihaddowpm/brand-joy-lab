#!/usr/bin/env node
/**
 * Getting the model's answer out of the model's reply.
 *
 * Job 43de542d produced a real connective read -- a gender direction-flip
 * across the travel arc, women leading on anticipation and men on flying and
 * renting the car -- as a complete, well-formed JSON object, inside a fenced
 * block, after a paragraph of prose. `stop_reason` was `end_turn`; nothing was
 * truncated. The harness threw all of it away.
 *
 * Two separate defects did that, and both are pinned here.
 *
 *   1. `extractJsonObjectSubstring` anchored on the FIRST `{` anywhere in the
 *      reply and brace-matched from there. One stray brace or unpaired quote
 *      in a preamble sends the scan off the end still open, and the unbalanced
 *      remainder fails to parse even though a complete object sits below it.
 *      A fenced block is where the model said its answer is, so it is read
 *      first now.
 *
 *   2. A parse failure returned straight out of `runFramePassWithGuard` with
 *      no second attempt. Every other way a read can fail gets a retry. This
 *      was the one that did not -- and it is the one where nothing was wrong
 *      with the read.
 *
 * Neither is a fabrication surface. The extractor only chooses which substring
 * to hand to JSON.parse; the retry only re-asks for the same answer in a
 * readable shape. A read recovered by either faces every latch it faced
 * before, which is what the last block below asserts.
 *
 * Exits non-zero on any failed assertion.
 */

const fs = require('fs');
const path = require('path');

// .env -> process.env, before anything requires the function module: it builds
// a Supabase client at import time. No network call is made by this file.
const envPath = path.join(__dirname, '..', '.env');
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const { extractJsonObjectSubstring, runFramePassParsed, FRAME_FORMAT_RETRY } =
  require(path.join(__dirname, '..', 'netlify', 'functions', 'bjl-query-background'));

const results = [];
function check(name, cond) { results.push([name, !!cond]); }

const parses = raw => {
  const slice = extractJsonObjectSubstring(raw);
  if (slice === null) return null;
  try { return JSON.parse(slice); } catch (e) { return undefined; }
};

// ---------------------------------------------------------------------------
// 1. The extractor.
// ---------------------------------------------------------------------------

// The shape of the reply that lost 43de542d, reduced to its mechanism: prose
// carrying an unbalanced brace, then the real answer in a fence. The prose
// below is the model's own opening line with a brace where the run had one.
const PREAMBLE_THEN_FENCE = `Looking across the evidence, I need to find something that crosses queries.

The travel arc splits {anticipation vs execution and the gender gap flips along it.

\`\`\`json
{
  "has_read": true,
  "read": "Women lead on the anticipation of a trip, men on its execution.",
  "evidence": [{ "item_name": "A Beach Trip", "score": 71.2, "n": 1453 }],
  "figures": [],
  "comparisons": [],
  "why_not": null
}
\`\`\``;

check('the read lost by job 43de542d is recovered',
  (parses(PREAMBLE_THEN_FENCE) || {}).has_read === true);

check('and it is the whole object, not a fragment of it',
  (parses(PREAMBLE_THEN_FENCE) || {}).read
    === 'Women lead on the anticipation of a trip, men on its execution.');

// An unpaired quote in the preamble breaks the scanner the same way a brace
// does -- it flips the string flag and swallows the rest of the reply.
check('an unpaired quote in the preamble no longer swallows the answer',
  (parses('The gap on "Taking a VACATION runs the other way.\n\n```json\n{ "has_read": false, "read": null }\n```') || {}).has_read === false);

check('a bare fence, no json tag, is read too',
  (parses('Here it is.\n\n```\n{ "has_read": true, "read": "x" }\n```') || {}).has_read === true);

// Non-regression: everything that worked before still works, unfenced.
check('unfenced: a bare object still parses',
  (parses('{ "has_read": true, "read": "x" }') || {}).has_read === true);

check('unfenced: lead-in prose before a bare object still parses',
  (parses('Here is the response:\n{ "has_read": true, "read": "x" }') || {}).has_read === true);

check('unfenced: trailing prose after a bare object still parses',
  (parses('{ "has_read": true, "read": "x" }\nThat is the read.') || {}).has_read === true);

check('nested objects and arrays still close at the right brace',
  JSON.stringify(parses('{ "a": { "b": [1, {"c": 2}] }, "d": 3 }'))
    === JSON.stringify({ a: { b: [1, { c: 2 }] }, d: 3 }));

check('braces and quotes inside a string still do not fool the counter',
  (parses('{ "read": "the {curly} one, \\"quoted\\", 1}2" }') || {}).read
    === 'the {curly} one, "quoted", 1}2');

check('no brace anywhere returns null',
  extractJsonObjectSubstring('there is no object here') === null);

// The truncation salvage path is load-bearing for the synthesizer, which pulls
// response_text out of a partial buffer. A cut-off reply has no closing fence,
// so it must still fall through to the old first-brace slice.
const TRUNCATED = '{ "response_text": "a long answer that stops mid';
check('a truncated object still returns the partial buffer for salvage',
  extractJsonObjectSubstring(TRUNCATED) === TRUNCATED);

check('a truncated object inside an unclosed fence still returns the partial',
  extractJsonObjectSubstring('```json\n' + TRUNCATED).includes('"response_text"'));

// A fence holding nothing usable must not shadow a real object below it.
check('an empty fence does not shadow the object after it',
  (parses('```json\n\n```\n{ "has_read": true, "read": "x" }') || {}).has_read === true);

// ---------------------------------------------------------------------------
// 2. The retry policy.
//
// `runFramePassParsed` takes its caller by injection, so the policy is pinned
// without the network. `calls` records what each attempt was handed.
// ---------------------------------------------------------------------------
const UNPARSEABLE = { has_read: false, read: null, evidence: [], why_not: null,
                      _parse_failed: true, _raw_tail: '...', _stop_reason: 'end_turn' };
const GOOD = { has_read: true, read: 'a recovered read', evidence: [{ item_name: 'x' }],
               comparisons: [], figures: [], why_not: null };
const NO_CORNER = { has_read: false, read: null, evidence: [], why_not: 'nothing crossed' };

function spy(...replies) {
  const calls = [];
  const call = async (triage, scratch, ctx) => {
    calls.push(ctx && ctx.__frame_retry_prefix ? ctx.__frame_retry_prefix : null);
    return replies[Math.min(calls.length - 1, replies.length - 1)];
  };
  return { calls, call };
}

(async () => {
  {
    const s = spy(GOOD);
    const out = await runFramePassParsed({}, [], {}, s.call);
    check('a reply that parses is not retried', s.calls.length === 1);
    check('and it is handed back untouched', out.read === 'a recovered read');
  }

  {
    const s = spy(NO_CORNER);
    await runFramePassParsed({}, [], {}, s.call);
    check('an honest no_corner is not retried either', s.calls.length === 1);
  }

  {
    const s = spy(UNPARSEABLE, GOOD);
    const out = await runFramePassParsed({}, [], {}, s.call);
    check('a parse failure is retried exactly once', s.calls.length === 2);
    check('the retry carries the format instruction', s.calls[1] === FRAME_FORMAT_RETRY);
    check('the first attempt carried no prefix', s.calls[0] === null);
    check('a read recovered on the retry is returned', out.has_read === true);
    check('and it is not flagged as exhausted', out._parse_retry_exhausted !== true);
  }

  {
    const s = spy(UNPARSEABLE, UNPARSEABLE);
    const out = await runFramePassParsed({}, [], {}, s.call);
    check('two parse failures stop, they do not loop', s.calls.length === 2);
    check('and the exhaustion is recorded rather than silent',
      out._parse_retry_exhausted === true && out._parse_failed === true);
  }

  // On the guard-failure path the context already carries the failure list.
  // Asking for better formatting must not cost the read its diagnosis.
  {
    const GUARD_PREFIX = 'RETRY. Your previous connective read did not verify. failures: [...]';
    const s = spy(UNPARSEABLE, GOOD);
    await runFramePassParsed({}, [], { __frame_retry_prefix: GUARD_PREFIX }, s.call);
    // Defensive reads: with the retry taken out there is no second call at
    // all, and a suite that throws is a worse proof than one that fails.
    check('a guard-retry prefix survives a parse retry',
      (s.calls[1] || '').includes(GUARD_PREFIX));
    check('with the format instruction ahead of it',
      (s.calls[1] || '').indexOf(FRAME_FORMAT_RETRY) === 0);
  }

  // The re-ask must not be a nudge toward finding something. It asks for the
  // same answer in a readable shape, and says so in as many words.
  check('the format retry asks for the same answer, not a better one',
    FRAME_FORMAT_RETRY.includes('Give the SAME answer you gave before')
    && FRAME_FORMAT_RETRY.includes('do not produce a read if you did not have one'));

  check('the format retry does not offer the model a reason to reach further',
    !/find a connection|look harder|try again to find|stronger read/i.test(FRAME_FORMAT_RETRY));

  // ---------------------------------------------------------------------------
  // 3. Recovery buys a guard evaluation, not a pass.
  //
  // The read recovered above is fabricated: 'A Beach Trip' at 71.2 sits on no
  // row here. Coming back through a fence must not spare it anything.
  // ---------------------------------------------------------------------------
  const { runConnectiveReadGuard } = require(
    path.join(__dirname, '..', 'netlify', 'functions', 'bjl-cross-domain-provenance-guard'));

  const recovered = parses(PREAMBLE_THEN_FENCE);
  const verdict = runConnectiveReadGuard({
    connective_read: recovered,
    scratch: [{
      type: 'query',
      query: 'SELECT i.item_name, ROUND(AVG(r.joy_index)::numeric,1) AS ji, COUNT(*) AS n '
           + 'FROM bjl_responses r JOIN bjl_items i ON i.item_id = r.item_id GROUP BY 1',
      result: [{ item_name: 'A Beach Trip', ji: 64.0, n: 900 }],
    }],
  });
  check('a recovered read still faces the guard, and this one fails it',
    verdict.ok === false && verdict.failures.length > 0);

  // ---------------------------------------------------------------------------
  const failed = results.filter(r => !r[1]);
  for (const [name, ok] of results) console.log((ok ? '  PASS  ' : '  FAIL  ') + name);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' assertions passed');
  if (failed.length) process.exit(1);
})();
