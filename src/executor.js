// executor.js
// SQL execution layer for the investigator. Routes every query through the
// public.agent_exec_sql(p_sql text) SECURITY DEFINER function in Supabase.
//
// Why not a direct Postgres connection:
//   Supabase's Supavisor pooler does not accept custom-role tenants (only
//   postgres.*). A direct connection via pg to db.PROJECT.supabase.co
//   requires IPv6 from Netlify Functions, which is not available. The
//   pg library path was producing "Tenant or user not found" auth rejections.
//
// Security posture (enforced at the DB layer, not here):
//   - SECURITY DEFINER function runs as postgres with BYPASSRLS
//   - function denylist rejects DDL/DML/admin keywords anywhere in input
//   - function rejects multi-statement input
//   - function requires leading SELECT or WITH
//   - function caps rows at 500 via outer LIMIT wrap
//   - EXECUTE on the function granted only to service_role (NOT anon/authenticated)
// The service-role JWT is held server-side in SUPABASE_SERVICE_KEY and is
// never exposed to the browser.

import { createClient } from "@supabase/supabase-js";

let _client = null;

function getClient() {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error("SUPABASE_URL environment variable is not set");
  if (!serviceKey) throw new Error("SUPABASE_SERVICE_KEY environment variable is not set");
  _client = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return _client;
}

/**
 * Execute a single SELECT/WITH query through agent_exec_sql.
 *
 * @param {string} sql
 * @returns {Promise<Object>} {
 *   rows: Object[], rowCount: number,
 *   error: string|null, isTimeout: boolean,
 *   truncated: boolean,    // true when result hit the 500-row cap
 *   injectedLimit: boolean, // DB-side wrapper always caps at 500
 *   finalSql: string,
 * }
 */
export async function executeQuery(sql) {
  if (typeof sql !== "string" || !sql.trim()) {
    return emptyResult("Empty SQL string", sql);
  }
  const finalSql = sql.trim();
  try {
    const client = getClient();
    const { data, error } = await client.rpc("agent_exec_sql", { p_sql: finalSql });
    if (error) {
      const msg = error.message || String(error);
      const isTimeout = /statement timeout|canceling statement/i.test(msg);
      return {
        rows: [], rowCount: 0,
        error: msg + (error.code ? " (code " + error.code + ")" : ""),
        isTimeout,
        truncated: false,
        injectedLimit: true,
        finalSql,
      };
    }
    const rows = Array.isArray(data) ? data : [];
    return {
      rows,
      rowCount: rows.length,
      error: null,
      isTimeout: false,
      truncated: rows.length >= 500,
      injectedLimit: true,
      finalSql,
    };
  } catch (err) {
    return {
      rows: [], rowCount: 0,
      error: err?.message || String(err),
      isTimeout: false,
      truncated: false,
      injectedLimit: true,
      finalSql,
    };
  }
}

function emptyResult(errorMsg, sql) {
  return {
    rows: [], rowCount: 0,
    error: errorMsg,
    isTimeout: false,
    truncated: false,
    injectedLimit: false,
    finalSql: sql || "",
  };
}

/**
 * Truncate long text fields so the investigator's context window stays small.
 * Fields > 400 chars become "<first 200 chars>... [truncated, full text in result]".
 * This affects the investigator view only — synthesizer receives full rows.
 */
export function truncateForInvestigator(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map(row => {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      if (typeof v === "string" && v.length > 400) {
        out[k] = v.slice(0, 200) + "... [truncated, full text in result]";
      } else {
        out[k] = v;
      }
    }
    return out;
  });
}

/**
 * Connection probe — returns the result of a minimal SELECT 1 via agent_exec_sql.
 * Used by the /api/bjl-query "pg-ping" diagnostic mode.
 */
export async function pingDb() {
  try {
    const client = getClient();
    const { data, error } = await client.rpc("agent_exec_sql", {
      p_sql: "SELECT 1 AS ok, current_user AS as_user, current_database() AS db",
    });
    if (error) {
      return { ok: false, error: error.message || String(error), code: error.code || null, detail: error.details || null };
    }
    const row = Array.isArray(data) && data.length > 0 ? data[0] : null;
    return { ok: !!row, row };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), code: null, detail: null };
  }
}
