#!/usr/bin/env node
/**
 * smoke_public_segments.js — the four fixtures for the public demo's
 * demographic layer (bjl_public_segment_read), documented in the
 * "Demographic segments" block of bjl-public-chat-background.js.
 *
 * ============================ READ THIS ============================
 * THIS IS NOT AN ISOLATED UNIT TEST. It stubs nothing at all. It calls
 * the retrieval functions of the real background worker directly:
 *   - the real Supabase database named in .env
 *   - the real bjl_public_segment_read, with its live guardrails
 * It does NOT call Anthropic and does NOT enqueue a job, so it costs
 * nothing and composes no answer — it proves the layer that feeds the
 * answer, not the prose. These cases are all READS. They create nothing
 * and mutate nothing.
 * Credentials come from .env at the repo root, so whichever database
 * that file points at is the one you are about to query.
 * ===================================================================
 *
 * Usage:  node bin/smoke_public_segments.js
 *
 * Exits non-zero if any assertion fails.
 *
 * ===================================================================
 * TWO HAZARDS THIS LAYER IS BUILT AROUND
 *
 * Both were live during the build. Both belong to the worst failure
 * class this tool has: wrong but plausible, with no error raised. They
 * are written up here because the code that avoids them looks like
 * over-caution unless you know what it is avoiding.
 *
 * ---- HAZARD 1: the id spaces collide, and question_id is aliased ----
 *
 * bjl_public_segment_read keys on bjl_items.item_id. It filters
 * bjl_responses.item_id and checks bjl_items.
 *
 * The public chat's retrieval layers do NOT carry that id.
 * bjl_scores_public_safe has no item_id column at all. retrieveScores
 * emits `question_id AS item_id`, and question_id is a DIFFERENT KEY
 * SPACE whose integers overlap bjl_items.item_id. Live at the time of
 * writing:
 *
 *   bjl_scores_public_safe.question_id   84 = "A Theme Park Trip"
 *   bjl_items.item_id                    84 = "I wanted to see or touch
 *                                              the item in person before
 *                                              buying"
 *   bjl_items.item_id                  1393 = "A Theme Park Trip"
 *
 * So passing the retrieved payload's `item_id` into the function returns
 * a full, well-formed, confidently wrong segment table: retail browsing
 * behaviour served to a visitor as theme-park demographics. Nothing
 * throws. Nothing logs. The numbers look right because they ARE right,
 * for a question nobody asked.
 *
 * The bridge is therefore item_name, resolved explicitly in
 * resolveSegmentItem, and never the payload's item_id field. The
 * database function's own public_safe gate is name-bridged for the same
 * reason, so the two integer spaces are never compared anywhere in the
 * stack.
 *
 * THIS TRAP IS NOT SPECIFIC TO DEMOGRAPHICS. Any future integration that
 * takes an id out of the public chat's retrieved payload and hands it to
 * anything keyed on bjl_items will hit it. The alias is the trap; the
 * field is called item_id and is not one.
 *
 * ---- HAZARD 2: loose topic matching is fine for prose, not for a cut ----
 *
 * The first build resolved the segment item by reusing the ordering of
 * the main score retrieval. That layer searches item_name OR question OR
 * category_key and ranks by hit count then n. It is tuned to feed prose,
 * where an adjacent row still reads as useful context.
 *
 * Handed a demographic cut, the same looseness resolved
 *
 *   "Does joy in going out to eat differ by region?"
 *
 * to "A Wellness Retreat or Spa Trip", which tied on hit count via its
 * question text and won the n tiebreak. The output would have been a
 * correct regional table about the wrong subject, presented as the
 * answer to a question about restaurants.
 *
 * resolveSegmentItem therefore runs its own match: item_name only, cue
 * language stripped first (the words naming the CUT are not the TOPIC),
 * ranked by how many topic terms the name actually covers, and it FAILS
 * CLOSED. No coverage means no item, which the prompt turns into silence
 * on demographics. A missing cut costs a follow-up question. A wrong cut
 * costs the visitor's trust in every number the tool has ever shown them.
 *
 * The geography and political cases below are guards of the same kind:
 * both refuse rather than fall through to "no data", because silence
 * would read as the corpus being empty rather than the cut being
 * unavailable.
 * ===================================================================
 */
const path = require('path');
const fs = require('fs');

const REPO = path.resolve(__dirname, '..');

const envPath = path.join(REPO, '.env');
if (!fs.existsSync(envPath)) {
  console.error(`No .env at ${envPath}. This harness runs against a live database and cannot proceed without one.`);
  process.exit(1);
}
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { _segments } = require(path.join(REPO, 'netlify/functions/bjl-public-chat-background.js'));
const { detectSegmentField, segmentTopicTerms, retrieveSegments } = _segments;

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

async function run(label, question) {
  console.log(`\n=== ${label} ===`);
  console.log(`  question     : "${question}"`);
  const seg = await retrieveSegments(question);
  console.log('  cue          :', seg.requested ? (seg.field || `(none) unavailable=${seg.unavailable}`) : '(no demographic cue)');
  console.log('  topic terms  :', segmentTopicTerms(question, detectSegmentField(question).cues).join(', ') || '—');
  if (seg.item) console.log('  read off     :', `${seg.item.item_id} "${seg.item.item_name}" (covers ${seg.item.covered})`);
  if (seg.unavailable) console.log('  unavailable  :', seg.unavailable);
  for (const r of seg.rows) {
    console.log(`    ${String(r.segment).padEnd(28)} n=${String(r.n).padStart(5)}  JI=${String(r.joy_index).padStart(6)}  vs_overall=${r.vs_overall > 0 ? '+' : ''}${r.vs_overall}`);
  }
  return seg;
}

const rowFor = (seg, name) => seg.rows.find(r => String(r.segment).toLowerCase() === name.toLowerCase());

async function caseGeneration() {
  // The headline fixture. "young people" must route to generation and the
  // topic must resolve to a real bjl_items.item_id — never a question_id,
  // which is a different key space that collides numerically. See the
  // id-space note on resolveSegmentItem.
  //
  // FIXTURE DIVERGENCE, deliberate. The original spec named item 1393
  // "A Theme Park Trip" (Millennial 66.2 / Boomer 24.1). The resolver
  // picks 4607 "Visiting a THEME PARK or amusement park" instead: both
  // names cover the same two topic terms, so the tiebreak is joy-row
  // count, and 4607 is the fuller fielding (4,058 rows against 3,093).
  // That is the intended rule and it matches house convention elsewhere
  // (global_extremes dedups to the highest-n row per concept; rung B picks
  // the fullest anchor). Both readings are true; this asserts the one the
  // rule produces. If the pick ever moves back to 1393, the tiebreak has
  // changed and that is worth knowing.
  const seg = await run('GENERATION — "young people" routes to a generation cut',
    'Do young people like theme parks more?');
  check('field is generation', seg.field === 'generation', seg.field);
  check('resolved to a real item', !!seg.item && Number.isFinite(seg.item.item_id), seg.item && `${seg.item.item_id}`);
  check('item is theme-park shaped', !!seg.item && /theme park/i.test(seg.item.item_name),
    seg.item && seg.item.item_name);
  check('picked the fullest fielding (4607, not 1393)', !!seg.item && seg.item.item_id === 4607,
    seg.item && `${seg.item.item_id}`);
  check('both topic terms covered', !!seg.item && seg.item.covered === 2, seg.item && `${seg.item.covered}`);
  const mil = rowFor(seg, 'Millennial');
  const boo = rowFor(seg, 'Boomer');
  check('Millennial 63.8', !!mil && mil.joy_index === 63.8, mil && `${mil.joy_index}`);
  check('Boomer 30', !!boo && boo.joy_index === 30, boo && `${boo.joy_index}`);
  // The finding the visitor actually gets: young skews hard positive. The
  // fixture divergence changes the size of the gap, not its direction.
  check('young well above old', !!mil && !!boo && (mil.joy_index - boo.joy_index) > 25,
    mil && boo && `${(mil.joy_index - boo.joy_index).toFixed(1)} points`);
  check('every row carries an n above the floor', seg.rows.length > 0 && seg.rows.every(r => r.n >= 60),
    seg.rows.map(r => `${r.segment}:${r.n}`).join(' '));
}

async function caseOccupation() {
  const seg = await run('OCCUPATION — "nurses" routes to an occupation cut',
    'How do nurses feel about vacations?');
  check('field is occupation', seg.field === 'occupation', seg.field);
  check('rows returned', seg.rows.length > 0, `${seg.rows.length}`);
  const health = seg.rows.find(r => /health|medical/i.test(r.segment));
  check('a healthcare / medical row is present', !!health,
    health ? `${health.segment} n=${health.n} JI=${health.joy_index}` : seg.rows.map(r => r.segment).join(', '));
  check('healthcare row carries an n', !!health && Number.isFinite(health.n) && health.n >= 60,
    health && `${health.n}`);
  // The write-in bucket is excluded inside the function; if it ever shows
  // up here, the function has been changed underneath us.
  check('write-ins excluded', !seg.rows.some(r => /write.?in/i.test(r.segment)),
    seg.rows.map(r => r.segment).join(', '));
  // Non-answer buckets clear the floor on this item and would otherwise be
  // quotable as findings about people rather than about the questionnaire.
  check('non-answer buckets dropped',
    !seg.rows.some(r => /^(prefer not to answer|not applicable|other)$/i.test(String(r.segment).trim())),
    seg.rows.map(r => r.segment).join(', '));
}

async function casePolitical() {
  const seg = await run('POLITICAL — a party cut is declined, not attempted',
    'How do Democrats feel about going to the movies?');
  check('flagged unavailable: political', seg.unavailable === 'political', seg.unavailable);
  check('no field claimed', seg.field === null, seg.field);
  check('no rows', seg.rows.length === 0, `${seg.rows.length}`);
  check('no item resolved', !seg.item);
}

async function caseGeography() {
  // State and city are off the whitelist and always will be at this cell
  // size. The point of catching it here rather than letting it fall
  // through is that "no data" would read as the corpus being silent,
  // when the honest answer is that the cut is unavailable and region is.
  const seg = await run('GEOGRAPHY — state-level is refused and region is offered instead',
    'Can you show me joy by state?');
  check('flagged unavailable: geography_too_fine', seg.unavailable === 'geography_too_fine', seg.unavailable);
  check('no rows', seg.rows.length === 0, `${seg.rows.length}`);
  // The offer has to be real, so prove region actually works on the same
  // kind of question.
  const alt = await run('GEOGRAPHY — the region cut the answer offers instead',
    'Does joy in going out to eat differ by region?');
  check('region cut resolves', alt.field === 'region', alt.field);
  check('region returns rows', alt.rows.length > 0, `${alt.rows.length}`);
}

async function caseNoCue() {
  // The common case: no demographic language, so the layer must stay
  // silent and cost nothing.
  const seg = await run('NO CUE — an ordinary question does not trigger a cut',
    'How joyful is going to the movies?');
  check('not requested', seg.requested === false, `${seg.requested}`);
  check('no rows', seg.rows.length === 0, `${seg.rows.length}`);
}

function caseCueUnit() {
  // Cue routing in isolation, so a regression in the regexes is legible
  // without a database round trip.
  console.log('\n=== CUE ROUTING (no database) ===');
  const expect = [
    ['Do young people like theme parks more?', 'generation'],
    ['How do nurses feel about vacations?', 'occupation'],
    ['Does income change how people feel about travel?', 'income_bracket'],
    ['Any regional differences in grocery joy?', 'region'],
    ['Do men and women differ here?', 'gender'],
    ['How do the people who decide where the family goes on vacation feel?', 'decisionmaker_vacation'],
    ['What about whoever decides on groceries for the household?', 'decisionmaker_groceries'],
    ['How joyful is going to the movies?', null],
  ];
  for (const [q, want] of expect) {
    const got = detectSegmentField(q).field;
    check(`"${q.slice(0, 46)}${q.length > 46 ? '…' : ''}" -> ${want || '(none)'}`, got === want, got || '(none)');
  }
}

(async () => {
  caseCueUnit();
  await caseGeneration();
  await caseOccupation();
  await casePolitical();
  await caseGeography();
  await caseNoCue();
  console.log(failures === 0 ? '\nAll assertions passed.' : `\n${failures} assertion(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('harness failed:', e); process.exit(1); });
