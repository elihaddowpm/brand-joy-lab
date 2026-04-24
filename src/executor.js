// executor.js
// SQL execution layer for the investigator. The smallest component and the
// most security-sensitive. Never trusts the investigator's SQL — denylist,
// parse, validate, then run against a dedicated read-only Postgres role.
//
// Connection uses SUPABASE_READONLY_URL (role: bjl_agent_readonly).
// Service role key is NEVER used here — that's reserved for the email path.

import pg from "pg";
import sqlParser from "node-sql-parser";

const { Pool } = pg;
const { Parser } = sqlParser;

// Patterns that reject a query before any database round-trip.
// The role enforces these at the DB level; this is belt-and-suspenders.
const DENYLIST_PATTERNS = [
  /\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|DROP|ALTER|CREATE|TRUNCATE|RENAME|GRANT|REVOKE|COPY|LOAD)\b/i,
  /\bSECURITY\s+DEFINER\b/i,
  /\bpg_(sleep|terminate|cancel)/i,
  /\\copy/i,
  // multiple statements: a ; followed by any non-whitespace content (one trailing ; is fine)
  /;\s*\S/,
];

// Module-scoped singletons so warm containers reuse the pool and parser.
let _pool = null;
let _parser = null;

function getPool() {
  if (_pool) return _pool;
  const connectionString = process.env.SUPABASE_READONLY_URL;
  if (!connectionString) {
    throw new Error("SUPABASE_READONLY_URL environment variable is not set");
  }
  _pool = new Pool({
    connectionString,
    max: 5,
    statement_timeout: 5000,
    query_timeout: 5500,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    // Supabase pooler requires SSL.
    ssl: { rejectUnauthorized: false },
  });
  _pool.on("error", (err) => {
    console.error("pg Pool error:", err?.message, err?.code);
  });
  return _pool;
}

/**
 * Lightweight connection probe — runs SELECT 1 against the readonly role.
 * Used by the /api/bjl-query diagnostic path to isolate connection issues
 * from investigator logic.
 */
export async function pingDb() {
  try {
    const pool = getPool();
    const client = await pool.connect();
    try {
      const result = await client.query("SELECT 1 AS ok, current_user AS as_user, current_database() AS db");
      return { ok: true, row: result.rows[0] };
    } finally {
      client.release();
    }
  } catch (err) {
    return {
      ok: false,
      error: err?.message || String(err),
      code: err?.code || null,
      detail: err?.detail || null,
    };
  }
}

function getParser() {
  if (!_parser) _parser = new Parser();
  return _parser;
}

/**
 * Execute a single SELECT query against the read-only BJL database.
 *
 * @param {string} sql - The SQL string the investigator wrote.
 * @returns {Promise<Object>} Result shape:
 *   {
 *     rows: Array<Object>,       // empty [] on error
 *     rowCount: number,          // 0 on error
 *     error: string | null,      // human-readable error, or null on success
 *     isTimeout: boolean,        // true if Postgres statement_timeout fired
 *     truncated: boolean,        // true if result hit injected LIMIT
 *     injectedLimit: boolean,    // true if we appended LIMIT 500
 *     finalSql: string,          // the SQL actually executed (after LIMIT injection)
 *   }
 */
export async function executeQuery(sql) {
  if (typeof sql !== "string" || !sql.trim()) {
    return emptyResult("Empty SQL string", { sql: "" });
  }

  const originalSql = sql.trim();

  // Check 1: pattern denylist — fast reject without DB round-trip.
  for (const pattern of DENYLIST_PATTERNS) {
    if (pattern.test(originalSql)) {
      return emptyResult("Query rejected by safety filter", { sql: originalSql });
    }
  }

  // Check 2: parse with node-sql-parser. Confirm single SELECT.
  try {
    const parser = getParser();
    const ast = parser.astify(originalSql, { database: "postgresql" });
    const statements = Array.isArray(ast) ? ast : [ast];
    if (statements.length !== 1) {
      return emptyResult("Only one statement per query", { sql: originalSql });
    }
    const topType = statements[0]?.type?.toLowerCase();
    if (topType !== "select") {
      return emptyResult("Only SELECT statements allowed", { sql: originalSql });
    }
  } catch (err) {
    // Parser fails on some legitimate PostgreSQL-specific SQL (custom operators,
    // ILIKE in certain contexts, RPC calls). In practice we still want to run
    // the query: the DB itself enforces SELECT-only through the readonly role +
    // denylist. Log the parse failure and continue — the DB will reject if the
    // statement is actually dangerous.
    console.warn("SQL parse warning (continuing):", err.message);
  }

  // Check 3: LIMIT injection.
  let finalSql = originalSql;
  if (finalSql.endsWith(";")) finalSql = finalSql.slice(0, -1);
  const hasLimit = /\bLIMIT\s+\d+\b/i.test(finalSql);
  if (!hasLimit) finalSql = finalSql + " LIMIT 500";

  // Check 4: execute with explicit per-query timeout (belt on top of role default).
  let client;
  try {
    const pool = getPool();
    client = await pool.connect();
    await client.query("SET LOCAL statement_timeout = 5000");
    const result = await client.query(finalSql);
    return {
      rows: result.rows || [],
      rowCount: result.rowCount ?? (result.rows ? result.rows.length : 0),
      error: null,
      isTimeout: false,
      truncated: !hasLimit && (result.rowCount ?? 0) >= 500,
      injectedLimit: !hasLimit,
      finalSql,
    };
  } catch (err) {
    // Postgres code 57014 = query_canceled (statement_timeout expired)
    const isTimeout = err && err.code === "57014";
    return {
      rows: [],
      rowCount: 0,
      error: err?.message || String(err),
      isTimeout,
      truncated: false,
      injectedLimit: !hasLimit,
      finalSql,
    };
  } finally {
    if (client) {
      try { client.release(); } catch (_) { /* no-op */ }
    }
  }
}

function emptyResult(errorMsg, { sql }) {
  return {
    rows: [],
    rowCount: 0,
    error: errorMsg,
    isTimeout: false,
    truncated: false,
    injectedLimit: false,
    finalSql: sql,
  };
}

/**
 * Truncate long text fields in a result set so the investigator's context
 * window stays manageable. Fields over 400 chars become
 * "<first 200 chars>... [truncated, full text in result]".
 * This is for the investigator's view ONLY — the synthesizer sees full rows.
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
