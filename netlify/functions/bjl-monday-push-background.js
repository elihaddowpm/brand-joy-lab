/**
 * bjl-monday-push-background.js — Push a captured submitted lead from
 * bjl_public_questions into Monday.com's "BJL Inbound Leads" board.
 * (Public Joy Lab Chat v7.4)
 *
 * Architecture:
 *   bjl-public-capture-lead.js (sync, public)
 *     → writes row to bjl_public_questions
 *     → fire-and-forget POST to this background function with {question_row_id}
 *     → returns 200 to the visitor (UX unblocked; Monday push happens out of band)
 *
 *   bjl-monday-push-background.js (this file, 15-min timeout)
 *     → loads the row by id
 *     → idempotency check: skip if monday_item_id already set
 *     → graceful skip if MONDAY_API_TOKEN missing (logs + exits 200)
 *     → calls Monday's create_item GraphQL mutation
 *     → writes monday_item_id back to the row for trace + idempotency
 *     → logs failures non-fatally (capture in Supabase is preserved either way)
 *
 * Column-value formats per Monday's API:
 *   text         → "string literal"
 *   long_text    → {"text": "string literal"}
 *   email        → {"email": "x@y.com", "text": "x@y.com"}
 *   status       → {"label": "BJL Inbound"}  or  {"index": 108}
 *   dropdown     → {"labels": ["general"]}
 *   numbers      → "42" (numeric string)
 *   date         → {"date": "2026-06-25", "time": "11:03:36"}
 *
 * Final column map for the board (locked 2026-06-25 by Eli):
 *   board_id    = 18419350124
 *   item_name   = "{first_name} {last_name}"
 *   columns:
 *     color_mm4nfc1p     Type           status     → always "BJL Inbound"
 *     email_mm4n5ces     Email          email      → email
 *     text_mm4nrdfr      Company        text       → company_name
 *     long_text_mm4n8w9d Their question long_text  → question
 *     long_text_mm4nm3mc What exploring long_text  → conversation_synthesis
 *     color_mm4nw5f4     Trigger        status     → mapped from trigger_source
 *     numeric_mm4nypyd   Engagement     numbers    → query_count
 *     dropdown_mm4nr4qx  Topic          dropdown   → category_guess (if in 12-label list)
 *     text_mm4nvpgh      Corpus Matches text       → matched_insight_slugs joined
 *     date_mm4ng7bb      Date           date       → created_at split into date + time
 *     text_mm4n60s       BJL Ref        text       → row id (idempotency key)
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_KEY      = process.env.SUPABASE_SERVICE_KEY;
const MONDAY_API_TOKEN  = process.env.MONDAY_API_TOKEN;
const MONDAY_API_URL    = 'https://api.monday.com/v2';
const MONDAY_BOARD_ID   = 18419350124;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Column IDs from the Monday API playground (verified 2026-06-25).
const COLS = {
  type:           'color_mm4nfc1p',
  email:          'email_mm4n5ces',
  company:        'text_mm4nrdfr',
  question:       'long_text_mm4n8w9d',
  exploring:      'long_text_mm4nm3mc',
  trigger:        'color_mm4nw5f4',
  engagement:     'numeric_mm4nypyd',
  topic:          'dropdown_mm4nr4qx',
  corpus_matches: 'text_mm4nvpgh',
  date:           'date_mm4ng7bb',
  bjl_ref:        'text_mm4n60s',
};

// Status-column label index map (so the push uses index, not raw label string —
// indices are stable across Monday's label-rename operations, label strings are not).
const TYPE_LABEL_BJL_INBOUND   = 108;
const TRIGGER_LABEL_INDEX = {
  hit_error:        1,
  no_answer:        2,   // 'No answer match'
  engaged_session:  7,
};

// 12 valid Topic dropdown labels. If category_guess from the synthesizer is
// not one of these, drop the Topic field rather than send an invalid label.
const VALID_TOPIC_LABELS = new Set([
  'general','personal_state','travel','food_beverage','home_life',
  'occasions_seasonal','kids_family','financial_services','retail',
  'telecommunications','entertainment','brand_dynamics',
]);

function triggerSourceToLabelIndex(triggerSource) {
  if (triggerSource === 'no_answer')          return TRIGGER_LABEL_INDEX.no_answer;
  if (triggerSource === 'consecutive_queries') return TRIGGER_LABEL_INDEX.engaged_session;
  if (triggerSource === 'error')              return TRIGGER_LABEL_INDEX.hit_error;
  return null;
}

function splitCreatedAt(createdAt) {
  // bjl_public_questions.created_at is a timestamptz like "2026-06-25T11:03:36Z"
  if (!createdAt) return null;
  try {
    const d = new Date(createdAt);
    if (isNaN(d.getTime())) return null;
    const yyyy = d.getUTCFullYear();
    const mm   = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd   = String(d.getUTCDate()).padStart(2, '0');
    const hh   = String(d.getUTCHours()).padStart(2, '0');
    const mi   = String(d.getUTCMinutes()).padStart(2, '0');
    const ss   = String(d.getUTCSeconds()).padStart(2, '0');
    return { date: `${yyyy}-${mm}-${dd}`, time: `${hh}:${mi}:${ss}` };
  } catch (_) { return null; }
}

function buildColumnValues(row) {
  const cv = {};

  // Always set Type to "BJL Inbound" (label index 108)
  cv[COLS.type] = { index: TYPE_LABEL_BJL_INBOUND };

  // Email (Monday's email-typed column expects {email, text})
  if (row.email) {
    cv[COLS.email] = { email: row.email, text: row.email };
  }

  // Company (optional)
  if (row.company_name) {
    cv[COLS.company] = row.company_name;
  }

  // Their question (long_text — wrapped in {text})
  if (row.question) {
    cv[COLS.question] = { text: row.question };
  }

  // What they're exploring (long_text — the conversation synthesis)
  if (row.conversation_synthesis) {
    cv[COLS.exploring] = { text: row.conversation_synthesis };
  }

  // Trigger (status — set by label index per the verified label map)
  const triggerIdx = triggerSourceToLabelIndex(row.trigger_source);
  if (triggerIdx !== null) {
    cv[COLS.trigger] = { index: triggerIdx };
  }

  // Engagement (numbers — Monday accepts numeric string)
  if (typeof row.query_count === 'number' && row.query_count > 0) {
    cv[COLS.engagement] = String(row.query_count);
  }

  // Topic (dropdown — only set if category_guess matches one of the 12 valid labels)
  if (row.category_guess && VALID_TOPIC_LABELS.has(row.category_guess)) {
    cv[COLS.topic] = { labels: [row.category_guess] };
  }

  // Corpus matches (text — comma-joined slugs)
  if (Array.isArray(row.matched_insight_slugs) && row.matched_insight_slugs.length > 0) {
    // text columns cap at ~255 chars; truncate safely
    const joined = row.matched_insight_slugs.join(', ');
    cv[COLS.corpus_matches] = joined.length > 250 ? joined.slice(0, 247) + '...' : joined;
  }

  // Captured timestamp (split into date + time)
  const dt = splitCreatedAt(row.created_at);
  if (dt) cv[COLS.date] = dt;

  // BJL ref — the Supabase row UUID, for round-trip lookup + idempotency trace
  cv[COLS.bjl_ref] = String(row.id);

  return cv;
}

async function callMondayCreateItem(itemName, columnValues) {
  const mutation = `
    mutation ($board_id: ID!, $item_name: String!, $column_values: JSON!) {
      create_item(
        board_id: $board_id,
        item_name: $item_name,
        column_values: $column_values,
        create_labels_if_missing: false
      ) {
        id
        name
      }
    }
  `;
  const variables = {
    board_id:      String(MONDAY_BOARD_ID),
    item_name:     itemName,
    column_values: JSON.stringify(columnValues),
  };

  const rsp = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': MONDAY_API_TOKEN,
      'API-Version':   '2024-04',
    },
    body: JSON.stringify({ query: mutation, variables }),
  });

  let payload = null;
  try { payload = await rsp.json(); } catch (_) { payload = null; }

  if (!rsp.ok) {
    throw new Error(`Monday API HTTP ${rsp.status}: ${JSON.stringify(payload || {}).slice(0, 500)}`);
  }
  if (payload && payload.errors) {
    throw new Error(`Monday API errors: ${JSON.stringify(payload.errors).slice(0, 500)}`);
  }
  const itemId = payload && payload.data && payload.data.create_item && payload.data.create_item.id;
  if (!itemId) {
    throw new Error(`Monday API returned no item id: ${JSON.stringify(payload || {}).slice(0, 500)}`);
  }
  return itemId;
}

exports.handler = async (event) => {
  // Background functions return their response to Netlify, not to a client.
  // Always return 200; failures are written to bjl_public_questions for trace.
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) {
    console.error('[bjl-monday-push] invalid JSON body');
    return { statusCode: 200, body: 'invalid body, skipped' };
  }

  const rowId = body.question_row_id;
  if (!rowId) {
    console.error('[bjl-monday-push] missing question_row_id');
    return { statusCode: 200, body: 'missing row id, skipped' };
  }

  if (!MONDAY_API_TOKEN) {
    console.warn('[bjl-monday-push] MONDAY_API_TOKEN not set; skipping push for row', rowId);
    return { statusCode: 200, body: 'no token, skipped' };
  }

  // Load the full row
  const { data: row, error: loadErr } = await supabase
    .from('bjl_public_questions')
    .select('*')
    .eq('id', rowId)
    .single();

  if (loadErr || !row) {
    console.error('[bjl-monday-push] row load failed:', loadErr ? loadErr.message : 'no row');
    return { statusCode: 200, body: 'row not found, skipped' };
  }

  // Only push submitted rows. Declined captures stay anonymous in Supabase
  // and never reach Monday.
  if (row.status !== 'submitted') {
    return { statusCode: 200, body: `row status='${row.status}', skipped` };
  }

  // Idempotency: never create a second Monday item for the same row.
  if (row.monday_item_id) {
    console.log('[bjl-monday-push] row already pushed, skipping. row=' + rowId + ' item=' + row.monday_item_id);
    return { statusCode: 200, body: 'already pushed, skipped' };
  }

  const firstName = (row.first_name || '').trim();
  const lastName  = (row.last_name  || '').trim();
  const itemName  = [firstName, lastName].filter(Boolean).join(' ') || row.email || `Lead ${rowId.slice(0, 8)}`;

  const columnValues = buildColumnValues(row);

  try {
    const itemId = await callMondayCreateItem(itemName, columnValues);

    // Persist the Monday item id back to bjl_public_questions for idempotency
    // + downstream trace (so the workbench can show "synced to Monday" later).
    const { error: updErr } = await supabase
      .from('bjl_public_questions')
      .update({ monday_item_id: itemId })
      .eq('id', rowId);
    if (updErr) {
      // The item exists on Monday but the writeback failed. Log loudly — the
      // next push attempt would create a duplicate. Acceptable on a single
      // failure; if it recurs, investigate the writeback path.
      console.error('[bjl-monday-push] item created in Monday but writeback to Supabase failed:', updErr.message, 'item_id=' + itemId, 'row=' + rowId);
    } else {
      console.log('[bjl-monday-push] pushed row ' + rowId + ' → Monday item ' + itemId);
    }
  } catch (err) {
    console.error('[bjl-monday-push] push failed for row ' + rowId + ':', err.message || err);
    // Leave the row untouched in Supabase. A future operator-driven retry can
    // re-dispatch by re-invoking this function with the same row id.
  }

  return { statusCode: 200, body: 'ok' };
};
