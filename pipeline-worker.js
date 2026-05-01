// ═══════════════════════════════════════════════
// ContentForge Studio V2 — Pipeline Worker Process
// Runs as a child_process.fork() from server.js
// Handles all pipeline execution in isolation from the HTTP server
// Communication: IPC messages via process.send() / process.on('message')
// ═══════════════════════════════════════════════
require('dotenv').config();

const BetterSqlite3 = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { marked } = require('marked');
const { initPipelineEngine, PipelineQueue } = require('./pipeline-engine');

const dbDir = path.join(__dirname, 'db');
const dbPath = path.join(dbDir, 'contentforge.db');

let db;
let pipelineQueue;

// ═══════ DB HELPERS (identical to server.js) ═══════
const _p = (p) => Array.isArray(p) ? p : (p === undefined || p === null ? [] : [p]);
function dbRun(sql, params = []) { return db.prepare(sql).run(..._p(params)); }
function dbGet(sql, params = []) { return db.prepare(sql).get(..._p(params)) || null; }
function dbAll(sql, params = []) { return db.prepare(sql).all(..._p(params)); }
function dbInsert(sql, params = []) { return Number(db.prepare(sql).run(..._p(params)).lastInsertRowid) || 0; }
function saveDb() {
  try { db.pragma('wal_checkpoint(PASSIVE)'); } catch (e) { console.error('[WORKER] DB checkpoint error:', e.message); }
}

// ═══════ PIPELINE LOG ═══════
function _logPipelineEvent(pipelineId, step, status, message, metadata, itemId, durationMs) {
  try {
    dbRun(
      'INSERT INTO pipeline_logs (pipeline_id, item_id, step, status, message, metadata, duration_ms) VALUES (?,?,?,?,?,?,?)',
      [pipelineId, itemId || null, step, status, message || null,
       metadata ? JSON.stringify(metadata) : null, durationMs || null]
    );
  } catch (e) { console.error('[WORKER] Log error:', e.message); }
}

// ═══════ POE API PROXY — calls server via IPC ═══════
// Worker doesn't make direct HTTP calls to Poe; it asks the server process
// to make the call (so server can apply rate limiting, key rotation, etc.)
// The server responds via IPC with the result.
let _pendingApiCalls = new Map(); // requestId -> { resolve, reject }
let _reqId = 0;

function callPoeAPI(bot, prompt, stream, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++_reqId;
    const timeout = setTimeout(() => {
      _pendingApiCalls.delete(id);
      reject(new Error('API call timeout (120s)'));
    }, 120000);

    _pendingApiCalls.set(id, {
      resolve: (result) => { clearTimeout(timeout); resolve(result); },
      reject: (err) => { clearTimeout(timeout); reject(err); }
    });

    process.send({ type: 'api_call', id, bot, prompt, stream: !!stream, params });
  });
}

// ═══════ IPC MESSAGE HANDLER ═══════
process.on('message', async (msg) => {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'api_response': {
      // Response from server for a callPoeAPI request
      const pending = _pendingApiCalls.get(msg.id);
      if (!pending) return;
      _pendingApiCalls.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error));
      } else {
        // Reconstruct a Response-like object from serialized data
        const fakeResp = {
          ok: msg.ok,
          status: msg.status,
          json: () => Promise.resolve(msg.body),
          text: () => Promise.resolve(JSON.stringify(msg.body))
        };
        pending.resolve(fakeResp);
      }
      break;
    }

    case 'cancel': {
      if (pipelineQueue && msg.pipelineId) {
        pipelineQueue.cancel(+msg.pipelineId);
        process.send({ type: 'cancelled', pipelineId: msg.pipelineId });
      }
      break;
    }

    case 'ping': {
      process.send({ type: 'pong', ts: Date.now(), running: pipelineQueue?.running?.size || 0 });
      break;
    }

    case 'stop': {
      console.log('[WORKER] Received stop signal, shutting down...');
      if (pipelineQueue) {
        // Cancel all running pipelines gracefully
        for (const [id] of pipelineQueue.running) {
          pipelineQueue.cancel(id);
        }
      }
      saveDb();
      process.exit(0);
      break;
    }
  }
});

// ═══════ INIT ═══════
async function init() {
  // Wait for DB to be available (server creates it first)
  let attempts = 0;
  while (!fs.existsSync(dbPath) && attempts < 30) {
    await new Promise(r => setTimeout(r, 500));
    attempts++;
  }

  if (!fs.existsSync(dbPath)) {
    console.error('[WORKER] DB file not found after 15s, exiting');
    process.exit(1);
  }

  // Open DB in WAL mode (safe for multiple processes)
  db = new BetterSqlite3(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000'); // Wait up to 5s if DB is locked

  // Auto-resume stuck pipelines
  const stuck = dbGet("SELECT COUNT(*) as c FROM pipelines WHERE status = 'running'")?.c || 0;
  if (stuck > 0) {
    dbRun("UPDATE pipelines SET status = 'queued', step_label = 'Tiếp tục sau restart...' WHERE status = 'running'");
    console.log(`[WORKER] Auto-resumed ${stuck} stuck pipeline(s)`);
  }

  // Init engine with our deps
  initPipelineEngine({
    dbGet, dbRun, dbAll, dbInsert,
    callPoeAPI,
    saveDb,
    logPipelineEvent: _logPipelineEvent
  });

  // Start queue
  pipelineQueue = new PipelineQueue({ maxConcurrent: 3, maxPerUser: 2 });
  pipelineQueue.start();

  // Notify server we're ready
  process.send({ type: 'ready', pid: process.pid });
  console.log(`[WORKER] Pipeline worker ready (PID: ${process.pid})`);

  // Periodic status report to server
  setInterval(() => {
    process.send({
      type: 'status',
      running: pipelineQueue.running.size,
      pids: [...pipelineQueue.running.keys()]
    });
  }, 5000);

  // Periodic DB checkpoint
  setInterval(saveDb, 30000);
}

// ═══════ ERROR HANDLING ═══════
process.on('uncaughtException', (err) => {
  console.error('[WORKER] Uncaught exception:', err);
  process.send({ type: 'error', message: err.message, stack: err.stack });
  // Don't exit — keep processing other pipelines
});

process.on('unhandledRejection', (reason) => {
  console.error('[WORKER] Unhandled rejection:', reason);
  process.send({ type: 'error', message: String(reason) });
});

init().catch(e => {
  console.error('[WORKER] Init failed:', e);
  process.exit(1);
});
