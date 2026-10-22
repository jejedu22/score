// Serveur HTTP + SQLite (node:sqlite, aucune dépendance npm).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PUBLIC = path.join(__dirname, 'public');
const MAX_SCORE = 100_000;
const MAX_NAME = 40;

function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    a1 TEXT NOT NULL REFERENCES players(id), a2 TEXT NOT NULL REFERENCES players(id),
    b1 TEXT NOT NULL REFERENCES players(id), b2 TEXT NOT NULL REFERENCES players(id),
    sa INTEGER NOT NULL, sb INTEGER NOT NULL, created_at INTEGER NOT NULL
  );
  `);
  return db;
}

const uid = () => crypto.randomBytes(5).toString('hex');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const round10 = n => Math.round(n / 10) * 10;
const isId = v => typeof v === 'string' && /^[0-9a-f]{10}$/.test(v);

function match(routes, method, pathname) {
  for (const [key, handler] of Object.entries(routes)) {
    const [m, pattern] = key.split(' ');
    if (m !== method) continue;
    const pp = pattern.split('/'), ap = pathname.split('/');
    if (pp.length !== ap.length) continue;
    const params = {};
    if (pp.every((seg, i) => seg.startsWith(':') ? (params[seg.slice(1)] = ap[i], true) : seg === ap[i]))
      return { handler, params };
  }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

function serveStatic(req, pathname, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405).end();
  const file = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};

function createApp(db) {
  const transaction = fn => {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  };

  function getState() {
    const players = db.prepare('SELECT id, name FROM players ORDER BY created_at, rowid').all();
    const games = db.prepare('SELECT * FROM games ORDER BY created_at, rowid').all()
      .map(g => ({ id: g.id, a: [g.a1, g.a2], b: [g.b1, g.b2], sa: g.sa, sb: g.sb }));
    return { players, games };
  }

  const routes = {
    'GET /api/state': () => getState(),

    'POST /api/players': ({ body }) => {
      const name = String(body.name ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_NAME);
      if (!name) throw new HttpError(400, 'Nom requis');
      if (db.prepare('SELECT 1 FROM players WHERE name = ? COLLATE NOCASE').get(name))
        throw new HttpError(409, `« ${name} » existe déjà.`);
      db.prepare('INSERT INTO players (id, name, created_at) VALUES (?, ?, ?)').run(uid(), name, Date.now());
      return getState();
    },

    'DELETE /api/players/:id': ({ params }) => {
      const used = db.prepare('SELECT 1 FROM games WHERE ? IN (a1, a2, b1, b2) LIMIT 1').get(params.id);
      if (used) throw new HttpError(409, "Ce joueur a déjà des parties enregistrées : supprimez-les d'abord.");
      db.prepare('DELETE FROM players WHERE id = ?').run(params.id);
      return getState();
    },

    'POST /api/games': ({ body }) => {
      const { a, b } = body;
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 2 || b.length !== 2)
        throw new HttpError(400, 'Il faut 2 joueurs par équipe');
      const ids = [...a, ...b];
      if (!ids.every(isId) || new Set(ids).size !== 4) throw new HttpError(400, 'Il faut 4 joueurs différents');
      const known = db.prepare(`SELECT COUNT(*) AS n FROM players WHERE id IN (${ids.map(() => '?').join()})`).get(...ids).n;
      if (known !== 4) throw new HttpError(400, 'Joueur inconnu (supprimé depuis un autre appareil ?)');
      const sa = round10(Number(body.sa)), sb = round10(Number(body.sb));
      if (![sa, sb].every(n => Number.isInteger(n) && n >= 0 && n <= MAX_SCORE))
        throw new HttpError(400, `Scores invalides (entre 0 et ${MAX_SCORE})`);
      db.prepare('INSERT INTO games (id, a1, a2, b1, b2, sa, sb, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(uid(), ...ids, sa, sb, Date.now());
      return getState();
    },

    'DELETE /api/games/:id': ({ params }) => {
      db.prepare('DELETE FROM games WHERE id = ?').run(params.id);
      return getState();
    },

    'POST /api/reset': () => {
      transaction(() => db.exec('DELETE FROM games; DELETE FROM players;'));
      return getState();
    },
  };

  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname === '/healthz') return json(res, 200, { ok: true });
    if (!pathname.startsWith('/api/')) return serveStatic(req, pathname, res);

    const found = match(routes, req.method, pathname);
    if (!found) return json(res, 404, { error: 'Route inconnue' });
    try {
      // Exiger du JSON force un « preflight » CORS pour toute requête venant d'un autre site :
      // le navigateur la bloque, ce qui protège contre le CSRF (y compris derrière basicauth).
      if (req.method !== 'GET' && !String(req.headers['content-type']).startsWith('application/json'))
        throw new HttpError(415, 'Content-Type application/json requis');
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 10_000) throw new HttpError(413, 'Requête trop grande');
      }
      let body = {};
      if (raw) { try { body = JSON.parse(raw); } catch { throw new HttpError(400, 'JSON invalide'); } }
      if (typeof body !== 'object' || body === null) throw new HttpError(400, 'JSON invalide');
      json(res, 200, found.handler({ body, params: found.params }));
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      json(res, e.status || 500, { error: e.status ? e.message : 'Erreur serveur' });
    }
  });
}

module.exports = { openDb, createApp };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'belote.db');
  const db = openDb(dbPath);
  const server = createApp(db);
  server.listen(port, () => console.log(`Belote score sur :${port} (db: ${dbPath})`));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); db.close(); process.exit(0); });
}
