#!/usr/bin/env node
/**
 * smoke_public_segments.js — the fixtures for the public demo's
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
 * THE HAZARDS THIS LAYER IS BUILT AROUND
 *
 * Every one of these was live, and every one belongs to the worst failure
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
 *
 * ---- HAZARD 2, SECOND SIGHTING: generic verbs are not topics ----
 *
 * The same failure came back through a different door while the value
 * vocabulary was going in:
 *
 *   "Do people under 40 enjoy going to concerts more?"
 *
 * resolved to "Going OUT TO EAT at a full-service restaurant". The corpus
 * has no concert item at all — the nearest things are "Listening to LIVE
 * MUSIC" and "A Music- or Festival-Focused Trip" — so the only term that
 * matched anything was "going", which appears in 33 of the 904 public
 * item names. One generic verb was enough to turn a fail-closed into a
 * confident restaurant table under a concert question.
 *
 * Document frequency cannot separate these: "eat" appears in 54 names,
 * MORE than "going", because substring matching inflates common
 * fragments. The separation is grammatical, so SEGMENT_FRAMING_WORDS now
 * carries the generic verbs and quantifiers (going, doing, getting, like,
 * people, more, most, many) alongside the original measurement language.
 * That query now correctly returns no_scored_item, and the assertion for
 * it is below.
 *
 * ---- HAZARD 3: a routing miss narrated as a missing measurement ----
 *
 * A live visitor asked:
 *
 *   "What types of vacations bring more joy to the decisionmaker versus
 *    the influencer?"
 *
 * and was told the Lab hadn't measured that split. It has. It has
 * near-full panel coverage and the function serves it off any single item.
 * The routing had failed on a plural — `vacation\b` does not match
 * "vacations" — and the synthesizer, handed a null field, had no way to
 * tell "nothing was routed" from "nothing exists" and reached for the
 * worse of the two.
 *
 * That is the hazard, and it is not really about plurals: any routing gap
 * anywhere in this layer arrives at the synthesizer looking exactly like
 * an empty corpus. A visitor can catch a wrong number. They cannot catch
 * being told a question is unanswerable — they just stop asking.
 *
 * Two things guard it. The qualifiers are plural-safe, asserted in
 * casePartialSupport and in the cue unit. And prompt rule 13 forbids the
 * absence phrasing outright whenever a field or a vocabulary is present,
 * requiring instead that the surface's limit be scoped in a clause and the
 * supported portion served immediately after it.
 *
 * ---- A THIN MARGIN THAT IS DELIBERATELY LEFT THIN ----
 *
 * With "going" and the shared stopword "out" both removed, the region
 * fixture's query reduces to the single term "eat", and two candidates
 * cover it: "Going OUT TO EAT at a full-service restaurant" (5,407 joy
 * rows) and "Eating CANDY" (5,406). The correct item wins the joy-row
 * tiebreak by ONE ROW.
 *
 * That is not fixed with more machinery. It is fixed by the assertion
 * below pinning item_id 4594 exactly, so if the corpus shifts and the
 * pick flips to candy, this harness fails loudly instead of the demo
 * quietly answering a restaurant question with confectionery.
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
  // Pinned exactly. See "A THIN MARGIN" in the header: this beats
  // "Eating CANDY" by a single joy row, and a flip must be loud.
  check('read off "Going OUT TO EAT", not "Eating CANDY"', !!alt.item && alt.item.item_id === 4594,
    alt.item && `${alt.item.item_id} "${alt.item.item_name}"`);
}

// ---------------------------------------------------------------------
// The value vocabulary. SEGMENT_VALUES is the complete set of values each
// field can hold, and it travels to the synthesizer in the payload rather
// than being written into the prompt, so there is one place to correct it
// and no chance of a prompt copy drifting from the database.
//
// These three cases cover the three things it has to make possible:
// mapping a word the visitor used onto a value the corpus has, expanding
// a threshold into every value on the qualifying side, and telling a
// value that fell under the reporting floor apart from a value that was
// never a category.
// ---------------------------------------------------------------------

async function caseOccupationVocabulary() {
  // "Accountants" is the point. The first build hardcoded eight
  // professions into the occupation cue — nurses, teachers, doctors,
  // engineers, drivers, managers, retail workers, healthcare workers —
  // so a question naming any of the other twenty-five occupations did not
  // route at all and the visitor got a general answer with no indication
  // a cut had been declined. Routing is now by person-noun across the
  // whole vocabulary.
  //
  // It also carries the subject-naming rule: the resolver picked
  // "Listening to MUSIC" out of nine music-shaped items, and the prompt
  // requires the answer to open by naming it, because the visitor is the
  // only one who can tell us it picked wrong.
  const seg = await run('VOCABULARY — an occupation outside the old hardcoded eight',
    'How do accountants feel about listening to music?');
  check('field is occupation', seg.field === 'occupation', seg.field);
  check('resolved to "Listening to MUSIC"', !!seg.item && seg.item.item_id === 236,
    seg.item && `${seg.item.item_id} "${seg.item.item_name}"`);
  check('full occupation vocabulary travels with the result',
    seg.available_values.length === 33, `${seg.available_values.length}`);
  check('the mapped value is in the vocabulary', seg.available_values.includes('Accounting'));
  // The honest outcome for this particular question: Accounting is a real
  // category, but on this item its cell is under the floor of 60 and the
  // function never returns it. available_values is what lets the answer
  // say "too small to report on this measure" instead of "no such cut",
  // which are different sentences and only one of them is true.
  check('Accounting is under the floor on this item, so it is absent from rows',
    !rowFor(seg, 'Accounting'), seg.rows.map(r => r.segment).join(', '));
  check('every returned row still clears the floor', seg.rows.length > 0 && seg.rows.every(r => r.n >= 60),
    seg.rows.map(r => `${r.segment}:${r.n}`).join(' '));
}

async function caseIncomeThreshold() {
  // A threshold is not a value. "Below 50k" names a cut point, and the
  // three brackets under it are three separate rows with three separate
  // bases; the prompt reads across them and states each n rather than
  // averaging into a number nobody measured.
  const seg = await run('VOCABULARY — a threshold selects every qualifying bracket',
    'Do people making below 50k get less joy from taking a vacation?');
  check('field is income_bracket', seg.field === 'income_bracket', seg.field);
  check('resolved to "Taking a VACATION"', !!seg.item && /vacation/i.test(seg.item.item_name),
    seg.item && `${seg.item.item_id} "${seg.item.item_name}"`);
  check('all nine brackets are in the vocabulary', seg.available_values.length === 9,
    `${seg.available_values.length}`);
  // Ascending order is load-bearing: it is how "below" and "above" are
  // resolved into a set of values at all.
  check('vocabulary is ordered low to high',
    seg.available_values[0] === 'Less than $25,000'
    && seg.available_values[8] === '$200,000 or more',
    `${seg.available_values[0]} … ${seg.available_values[8]}`);
  const under50 = ['Less than $25,000', '$25,000 to $34,999', '$35,000 to $49,999'];
  const got = under50.filter(v => rowFor(seg, v));
  check('all three sub-50k brackets came back with their own n', got.length === 3,
    got.map(v => `${v}:${rowFor(seg, v).n}`).join(' '));
  // The finding itself, so the fixture fails if the gradient inverts.
  check('the gradient runs the way the answer will claim',
    rowFor(seg, 'Less than $25,000').joy_index < rowFor(seg, '$100,000 to $124,999').joy_index,
    `${rowFor(seg, 'Less than $25,000').joy_index} vs ${rowFor(seg, '$100,000 to $124,999').joy_index}`);
}

async function caseAgeThreshold() {
  // Ages are not stored; generation is. "Under 40" routes to generation
  // and the prompt is required to say the band is approximate rather than
  // present an age cut as a measured one.
  const seg = await run('VOCABULARY — an age threshold routes to generation',
    'Do people under 40 enjoy listening to live music?');
  check('field is generation', seg.field === 'generation', seg.field);
  check('resolved to "Listening to LIVE MUSIC"', !!seg.item && seg.item.item_id === 4625,
    seg.item && `${seg.item.item_id} "${seg.item.item_name}"`);
  check('all five generations are in the vocabulary', seg.available_values.length === 5,
    seg.available_values.join(', '));
  check('vocabulary is ordered youngest to oldest',
    seg.available_values[0] === 'Gen Z' && seg.available_values[4] === 'Silent',
    `${seg.available_values[0]} … ${seg.available_values[4]}`);
  const genz = rowFor(seg, 'Gen Z');
  const mil = rowFor(seg, 'Millennial');
  check('both under-40 generations came back with their own n', !!genz && !!mil,
    genz && mil && `Gen Z:${genz.n} Millennial:${mil.n}`);

  // Same cue, no such item. The corpus has no concert measure, so the
  // only honest outcome is silence on demographics — see HAZARD 2, SECOND
  // SIGHTING. Before the framing-word fix this returned a restaurant
  // table under a concert question.
  const none = await run('VOCABULARY — the same cue over a topic the corpus does not measure',
    'Do people under 40 enjoy going to concerts more?');
  check('fails closed', none.unavailable === 'no_scored_item', none.unavailable);
  check('no item resolved', !none.item);
  check('no rows', none.rows.length === 0, `${none.rows.length}`);
  // The vocabulary still travels, so the answer can name what generation
  // CAN do instead of going silent about the whole field.
  check('vocabulary still travels on a failed resolve', none.available_values.length === 5,
    none.available_values.join(', '));
}

async function caseNoCue() {
  // The common case: no demographic language, so the layer must stay
  // silent and cost nothing.
  const seg = await run('NO CUE — an ordinary question does not trigger a cut',
    'How joyful is going to the movies?');
  check('not requested', seg.requested === false, `${seg.requested}`);
  check('no rows', seg.rows.length === 0, `${seg.rows.length}`);
}

async function caseUnnamedField() {
  // The spec's founding fixture, and the one that routed nowhere until
  // now: a demographic question that names no demographic. It must not
  // fall through to a general answer, because the visitor asked who, and
  // a general answer silently declines the question they asked.
  //
  // The default is generation, and it is BOUNDED. One field, never a
  // sweep across all seven — with seven fields and a dozen segments each,
  // something always looks like a gap, and a sweep would present fishing
  // as a finding. The choice is declared in the answer and the other cuts
  // are named, so a cut the visitor did not choose is never mistaken for
  // the only one available or the strongest one found.
  const seg = await run('UNNAMED FIELD — demographic intent with no demographic named',
    'Who loves theme parks most?');
  check('routes rather than falling through', seg.requested === true, `${seg.requested}`);
  check('defaults to generation', seg.field === 'generation', seg.field);
  check('the default is flagged, so the answer must declare it', seg.field_defaulted === true,
    `${seg.field_defaulted}`);
  check('offers the other cuts by name',
    seg.other_fields.join(',') === 'occupation,income_bracket,region', seg.other_fields.join(', '));
  check('generation is not offered back to itself', !seg.other_fields.includes('generation'));
  // The intent pattern spans the sentence, so stripping the match would
  // take the subject with it. Only the framing verb is stripped, and the
  // topic still resolves to the same item as the explicit generation
  // fixture above.
  check('topic survives the cue strip', !!seg.item && seg.item.item_id === 4607,
    seg.item && `${seg.item.item_id} "${seg.item.item_name}"`);
  const mil = rowFor(seg, 'Millennial');
  const boo = rowFor(seg, 'Boomer');
  check('Millennial row with its n', !!mil && mil.n >= 60, mil && `n=${mil.n} JI=${mil.joy_index}`);
  check('Boomer row with its n', !!boo && boo.n >= 60, boo && `n=${boo.n} JI=${boo.joy_index}`);
  check('the split the answer will lead on', !!mil && !!boo && mil.joy_index > boo.joy_index,
    mil && boo && `${(mil.joy_index - boo.joy_index).toFixed(1)} points`);

  // An explicitly named field must never be overwritten by the default,
  // and must never carry the "I chose this for you" flag.
  const named = await run('UNNAMED FIELD — an explicit field still wins and is not flagged',
    'Which region loves theme parks most?');
  check('explicit field beats the default', named.field === 'region', named.field);
  check('not flagged as defaulted', named.field_defaulted === false, `${named.field_defaulted}`);
  check('no menu offered when the visitor chose', named.other_fields.length === 0,
    named.other_fields.join(', '));
}

async function casePartialSupport() {
  // The 18:25 defect, from a live visitor query. It came back as "the Lab
  // hasn't measured the decisionmaker versus influencer split directly" —
  // a false claim about the panel, on a split with near-full coverage that
  // the function serves off any single item.
  //
  // The cause was one missing character. The qualifier was
  // /\b(vacation|trip|travel|holiday|getaway)\b/ and `vacation\b` does not
  // match "vacations". So the cue matched, the qualifier failed on a
  // trailing s, the field came back null, and the synthesizer had nothing
  // to distinguish "no cut was routed" from "no such cut exists" — so it
  // narrated a routing miss as an absence of data. Every qualifier now
  // carries s? / (y|ies), and prompt rule 13 forbids the phrasing outright
  // whenever a field is served.
  const seg = await run('PARTIAL SUPPORT — a plural qualifier still routes (the 18:25 defect)',
    'What types of vacations bring more joy to the decisionmaker versus the influencer?');
  check('routes rather than reading as unmeasured', seg.field === 'decisionmaker_vacation', seg.field);
  check('nothing unavailable', seg.unavailable === null, seg.unavailable);
  // The second, independent bug in the same query. Once it routed, the
  // qualifier ("vacations") was being stripped along with the cue, leaving
  // the resolver searching on "type" and "bring" — which landed on item
  // 314, "have you experienced changes in the things that bring you joy".
  // Only the CUE is stripped now; the qualifier names the product domain,
  // which is the topic.
  check('resolved to "Taking a VACATION" (228, not 314)', !!seg.item && seg.item.item_id === 228,
    seg.item && `${seg.item.item_id} "${seg.item.item_name}"`);
  check('all five decision-role values travel', seg.available_values.length === 5,
    seg.available_values.join(', '));
  const share = rowFor(seg, 'Share equally in decision-making');
  const sole = rowFor(seg, 'Sole or primary decision-maker');
  const infl = rowFor(seg, 'Influence or participate in choosing');
  const not = rowFor(seg, 'Not involved in choosing');
  check('Share equally 79.1 n=3541', !!share && share.joy_index === 79.1 && share.n === 3541,
    share && `${share.joy_index} n=${share.n}`);
  check('Sole 76.2 n=4609', !!sole && sole.joy_index === 76.2 && sole.n === 4609,
    sole && `${sole.joy_index} n=${sole.n}`);
  check('Influence 68.6', !!infl && infl.joy_index === 68.6, infl && `${infl.joy_index} n=${infl.n}`);
  check('Not involved 58.1', !!not && not.joy_index === 58.1, not && `${not.joy_index} n=${not.n}`);
  // The gradient is the finding: agency tracks joy, monotonically, across
  // four rows all comfortably above the floor.
  check('the agency gradient is monotonic',
    !!share && !!sole && !!infl && !!not &&
    share.joy_index > sole.joy_index && sole.joy_index > infl.joy_index && infl.joy_index > not.joy_index,
    [share, sole, infl, not].filter(Boolean).map(r => r.joy_index).join(' > '));
}

async function caseIntersection() {
  // Two fields named, one cell read. Answering this as two separate cuts
  // is the wrong-but-plausible failure again: the generation row and the
  // gender row are both mostly about people who are not millennial women,
  // and stating them under a question about millennial women is a finding
  // about nobody.
  const seg = await run('INTERSECTION — two named fields read as one combined cell',
    'Do millennial women like coffee?');
  check('first field is generation', seg.field === 'generation', seg.field);
  check('second field is gender', seg.field2 === 'gender', `${seg.field2}`);
  check('the cross was not thin', seg.intersection_thin === false, `${seg.intersection_thin}`);
  check('resolved to "Drinking COFFEE"', !!seg.item && seg.item.item_id === 4765,
    seg.item && `${seg.item.item_id} "${seg.item.item_name}"`);
  check('both vocabularies travel',
    seg.available_values.length === 5 && seg.available_values2.length === 5,
    `${seg.available_values.length} × ${seg.available_values2.length}`);
  // The segment strings are combined cells, which is what lets the prompt
  // say "millennial women" without lying. If these ever come back as bare
  // "Millennial", the p_field2 overload stopped being used and rule 14's
  // fallback branch should have fired instead of silently degrading.
  check('every row is a combined cell', seg.rows.length > 0 && seg.rows.every(r => / × /.test(r.segment)),
    seg.rows.map(r => r.segment).slice(0, 3).join(' | '));
  const mf = rowFor(seg, 'Millennial × Female');
  check('Millennial × Female 56.6 n=597', !!mf && mf.joy_index === 56.6 && mf.n === 597,
    mf && `${mf.joy_index} n=${mf.n}`);
  check('and it carries its own vs_overall', !!mf && mf.vs_overall === 9.2, mf && `${mf.vs_overall}`);
  check('the floor applies to the intersection', seg.rows.every(r => r.n >= 60),
    seg.rows.map(r => `${r.segment}:${r.n}`).join(' '));
  // The cell the question asked about is the one the answer leads on, and
  // it is the top of the table — not an artefact of asking for it.
  check('the asked-for cell is the strongest', !!mf && seg.rows[0].segment === 'Millennial × Female',
    seg.rows[0] && seg.rows[0].segment);

  // One field named, no cross. field2 stays null so rule 14 does not fire
  // and no × ever appears in a single-cut answer.
  const single = await run('INTERSECTION — one named field is not crossed with anything',
    'Do millennials like coffee?');
  check('no second field', single.field2 === null, `${single.field2}`);
  check('nothing was requested to cross', single.field2_requested === null, `${single.field2_requested}`);
  check('rows are plain segments', single.rows.every(r => !/ × /.test(r.segment)),
    single.rows.map(r => r.segment).slice(0, 3).join(' | '));
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
    // The value vocabulary, routing on words the old cue list did not know.
    ['How do accountants feel about listening to music?', 'occupation'],
    ['What do plumbers enjoy?', 'occupation'],
    ['Do people making below 50k get less joy from a vacation?', 'income_bracket'],
    ['What about households over $150,000?', 'income_bracket'],
    ['Do people under 40 enjoy live music?', 'generation'],
    ['How about people in their sixties?', 'generation'],
    ['Is it different in the South?', 'region'],
    // Negative controls. Half the occupation vocabulary doubles as subject
    // matter, so these are the queries that would break if routing ever
    // matched bare value names instead of person-nouns — and the last two
    // are the reason the income cue requires a magnitude, not just a
    // dollar sign.
    ['What are the biggest drivers of joy?', null],
    ['How do people feel about the internet?', null],
    ['Is retail therapy joyful?', null],
    ['How joyful is a road trip out west?', null],
    ['Is a $50 dinner joyful?', null],
    // Demographic intent, no demographic named: defaults to generation.
    ['Who loves theme parks most?', 'generation'],
    ['Which group gets the most joy from cooking?', 'generation'],
    ['What kind of people enjoy camping?', 'generation'],
    // A bare "who" is not a demographic request. These must stay silent.
    ['Who is this brand for?', null],
    ['Who makes the best coffee?', null],
    // Plurals. Every one of these routed nowhere until the qualifiers grew
    // an s, and routing nowhere is what got narrated as "not measured".
    ['What types of vacations bring more joy to the decisionmaker versus the influencer?', 'decisionmaker_vacation'],
    ['Who decides on groceries in the household?', 'decisionmaker_groceries'],
    ['Do the people who plan the trips enjoy them more?', 'decisionmaker_vacation'],
  ];
  for (const [q, want] of expect) {
    const got = detectSegmentField(q).field;
    check(`"${q.slice(0, 46)}${q.length > 46 ? '…' : ''}" -> ${want || '(none)'}`, got === want, got || '(none)');
  }

  // Second-field detection, in isolation. The cap is two: a three-way cell
  // is under the floor almost everywhere, and an answer built on the cells
  // that happened to survive would be a survivorship artefact.
  const pairs = [
    ['Do millennial women like coffee?', 'generation', 'gender'],
    ['How do boomers in the South feel about vacations?', 'generation', 'region'],
    ['Do young people like theme parks more?', 'generation', null],
    ['Do men and women differ here?', 'gender', null],
  ];
  for (const [q, f1, f2] of pairs) {
    const got = detectSegmentField(q);
    check(`"${q.slice(0, 42)}${q.length > 42 ? '…' : ''}" -> ${f1} × ${f2 || '(none)'}`,
      got.field === f1 && got.field2 === f2, `${got.field} × ${got.field2 || '(none)'}`);
  }
  // Three named fields. Two survive, and which two is decided by cue
  // order, which carries no meaning — so the third cannot just vanish.
  // Reading generation × region under "millennial women in the South"
  // would answer about millennial southerners of both genders and look
  // exactly like an answer to the question asked.
  const three = detectSegmentField('Do millennial women in the South like coffee?');
  check('three named fields are capped at two',
    three.field === 'generation' && three.field2 === 'region', `${three.field} × ${three.field2}`);
  check('the dropped field is disclosed, not swallowed',
    three.fields_omitted.join(',') === 'gender', three.fields_omitted.join(', ') || '(none)');
  const two = detectSegmentField('Do millennial women like coffee?');
  check('nothing is dropped when two fit', two.fields_omitted.length === 0,
    two.fields_omitted.join(', ') || '(none)');
}

(async () => {
  caseCueUnit();
  await caseGeneration();
  await caseOccupation();
  await casePolitical();
  await caseGeography();
  await caseNoCue();
  await caseOccupationVocabulary();
  await caseIncomeThreshold();
  await caseAgeThreshold();
  await caseUnnamedField();
  await casePartialSupport();
  await caseIntersection();
  console.log(failures === 0 ? '\nAll assertions passed.' : `\n${failures} assertion(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('harness failed:', e); process.exit(1); });
