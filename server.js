// Serveur HTTP + SQLite (node:sqlite, aucune dépendance npm).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const planner = require('./planner');

const PUBLIC = path.join(__dirname, 'public');
const MAX_SCORE = 100_000;
const MAX_NAME = 40;
const MAX_ROUNDS = 30;

const uid = () => crypto.randomBytes(5).toString('hex');
const cleanName = v => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_NAME);

function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  `);
  const gamesTable = name => `
  CREATE TABLE ${name} (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    a1 TEXT NOT NULL REFERENCES players(id), a2 TEXT NOT NULL REFERENCES players(id),
    b1 TEXT NOT NULL REFERENCES players(id), b2 TEXT NOT NULL REFERENCES players(id),
    -- Scores NULL = match en cours (équipes formées, score saisi à la fin)
    sa INTEGER, sb INTEGER, table_no INTEGER,
    round INTEGER,   -- numéro de tour pour les parties planifiées, NULL pour un match ajouté à la main
    created_at INTEGER NOT NULL, finished_at INTEGER
  );`;
  const cols = db.prepare("SELECT name FROM pragma_table_info('games')").all().map(c => c.name);
  if (!cols.length) {
    db.exec(gamesTable('games'));
  } else if (!cols.includes('table_no')) {
    // Mise à niveau d'une ancienne base (reconstruction de la table, SQLite ne sait pas modifier les colonnes)
    db.exec('BEGIN');
    try {
      let eventId = null;
      if (!cols.includes('event_id')) {
        // Base sans événements : les parties existantes rejoignent un événement « Tournoi »
        const first = db.prepare('SELECT MIN(created_at) AS t FROM games').get().t;
        eventId = uid();
        if (first !== null) db.prepare('INSERT INTO events (id, name, created_at) VALUES (?, ?, ?)').run(eventId, 'Tournoi', first);
      }
      db.exec(gamesTable('games_new'));
      db.prepare(`INSERT INTO games_new (id, event_id, a1, a2, b1, b2, sa, sb, created_at, finished_at)
        SELECT id, ${eventId ? '?' : 'event_id'}, a1, a2, b1, b2, sa, sb, created_at, created_at FROM games`)
        .run(...(eventId ? [eventId] : []));
      db.exec('DROP TABLE games; ALTER TABLE games_new RENAME TO games; COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  else if (!cols.includes('round')) db.exec('ALTER TABLE games ADD COLUMN round INTEGER');
  db.exec(`
  CREATE INDEX IF NOT EXISTS games_event ON games(event_id);
  -- Joueurs au repos pour un tour planifié (nombre de joueurs non multiple de 4)
  CREATE TABLE IF NOT EXISTS rests (
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    round INTEGER NOT NULL,
    player_id TEXT NOT NULL REFERENCES players(id),
    PRIMARY KEY (event_id, round, player_id)
  );
  `);
  return db;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const round10 = n => Math.round(n / 10) * 10;
const isId = v => typeof v === 'string' && /^[0-9a-f]{10}$/.test(v);

// Scores tous deux vides → null (match en cours) ; sinon deux scores valides arrondis à 10
function parseScores(body) {
  const empty = v => v === undefined || v === null || v === '';
  if (empty(body.sa) && empty(body.sb)) return null;
  if (empty(body.sa) || empty(body.sb)) throw new HttpError(400, 'Saisissez les deux scores');
  const scores = [round10(Number(body.sa)), round10(Number(body.sb))];
  if (!scores.every(n => Number.isInteger(n) && n >= 0 && n <= MAX_SCORE))
    throw new HttpError(400, `Scores invalides (entre 0 et ${MAX_SCORE})`);
  return scores;
}

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

  // Les joueurs sont communs à tous les événements ; chaque partie appartient à un événement.
  function getState() {
    const events = db.prepare('SELECT id, name, created_at AS createdAt FROM events ORDER BY created_at, rowid').all();
    const players = db.prepare('SELECT id, name FROM players ORDER BY created_at, rowid').all();
    const games = db.prepare('SELECT * FROM games ORDER BY created_at, rowid').all()
      .map(g => ({ id: g.id, eventId: g.event_id, a: [g.a1, g.a2], b: [g.b1, g.b2], sa: g.sa, sb: g.sb,
        table: g.table_no, round: g.round, finishedAt: g.finished_at }));
    const rests = db.prepare('SELECT event_id AS eventId, round, player_id AS playerId FROM rests ORDER BY round').all();
    return { events, players, games, rests };
  }

  // Tour planifié en cours : le plus petit tour qui a encore des matchs sans score
  const currentRound = eventId =>
    db.prepare('SELECT MIN(round) AS r FROM games WHERE event_id = ? AND sa IS NULL AND round IS NOT NULL').get(eventId).r;

  const eventName = (body, exceptId = '') => {
    const name = cleanName(body.name);
    if (!name) throw new HttpError(400, 'Nom requis');
    if (db.prepare('SELECT 1 FROM events WHERE name = ? COLLATE NOCASE AND id != ?').get(name, exceptId))
      throw new HttpError(409, `L'événement « ${name} » existe déjà.`);
    return name;
  };

  const routes = {
    'GET /api/state': () => getState(),

    'POST /api/events': ({ body }) => {
      const id = uid();
      db.prepare('INSERT INTO events (id, name, created_at) VALUES (?, ?, ?)').run(id, eventName(body), Date.now());
      return { ...getState(), created: id };
    },

    'PATCH /api/events/:id': ({ params, body }) => {
      const name = eventName(body, params.id);
      if (!db.prepare('UPDATE events SET name = ? WHERE id = ?').run(name, params.id).changes)
        throw new HttpError(404, 'Événement introuvable');
      return getState();
    },

    'DELETE /api/events/:id': ({ params }) => {
      transaction(() => {
        db.prepare('DELETE FROM games WHERE event_id = ?').run(params.id);
        db.prepare('DELETE FROM rests WHERE event_id = ?').run(params.id);
        db.prepare('DELETE FROM events WHERE id = ?').run(params.id);
      });
      return getState();
    },

    // Planification automatique de plusieurs tours, ajoutés après les tours existants
    'POST /api/events/:id/plan': ({ params, body }) => {
      if (!db.prepare('SELECT 1 FROM events WHERE id = ?').get(params.id)) throw new HttpError(404, 'Événement introuvable');
      const { players } = body;
      const rounds = Number(body.rounds);
      if (!Array.isArray(players) || !players.every(isId) || new Set(players).size !== players.length)
        throw new HttpError(400, 'Liste de joueurs invalide');
      if (players.length < 4) throw new HttpError(400, 'Il faut au moins 4 joueurs');
      const known = db.prepare(`SELECT COUNT(*) AS n FROM players WHERE id IN (${players.map(() => '?').join()})`).get(...players).n;
      if (known !== players.length) throw new HttpError(400, 'Joueur inconnu (supprimé depuis un autre appareil ?)');
      if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDS)
        throw new HttpError(400, `Nombre de tours invalide (entre 1 et ${MAX_ROUNDS})`);
      if (db.prepare('SELECT 1 FROM games WHERE event_id = ? AND sa IS NULL AND round IS NULL').get(params.id))
        throw new HttpError(409, 'Terminez ou annulez les matchs en cours avant de planifier des tours.');

      // Tout ce qui a été joué ou prévu dans l'événement compte pour éviter les répétitions
      const games = db.prepare('SELECT a1, a2, b1, b2 FROM games WHERE event_id = ?').all(params.id)
        .map(g => [g.a1, g.a2, g.b1, g.b2]);
      const rests = db.prepare('SELECT player_id FROM rests WHERE event_id = ?').all(params.id).map(r => r.player_id);
      const result = planner.plan(players, rounds, { games, rests });

      const first = (db.prepare('SELECT MAX(round) AS r FROM games WHERE event_id = ?').get(params.id).r ?? 0) + 1;
      const now = Date.now();
      transaction(() => {
        const addGame = db.prepare(`INSERT INTO games (id, event_id, a1, a2, b1, b2, table_no, round, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const addRest = db.prepare('INSERT INTO rests (event_id, round, player_id) VALUES (?, ?, ?)');
        result.rounds.forEach(({ tables, rest }, i) => {
          tables.forEach((t, j) => addGame.run(uid(), params.id, ...t, j + 1, first + i, now));
          rest.forEach(id => addRest.run(params.id, first + i, id));
        });
      });
      return { ...getState(), plan: { from: first, to: first + rounds - 1,
        partnerRepeats: result.partnerRepeats, opponentRepeats: result.opponentRepeats } };
    },

    // Supprime les matchs planifiés pas encore joués (les parties terminées restent)
    'DELETE /api/events/:id/plan': ({ params }) => {
      transaction(() => {
        db.prepare('DELETE FROM games WHERE event_id = ? AND sa IS NULL AND round IS NOT NULL').run(params.id);
        db.prepare(`DELETE FROM rests WHERE event_id = ? AND round NOT IN
          (SELECT round FROM games WHERE event_id = ? AND round IS NOT NULL)`).run(params.id, params.id);
      });
      return getState();
    },

    'POST /api/players': ({ body }) => {
      const name = cleanName(body.name);
      if (!name) throw new HttpError(400, 'Nom requis');
      if (db.prepare('SELECT 1 FROM players WHERE name = ? COLLATE NOCASE').get(name))
        throw new HttpError(409, `« ${name} » existe déjà.`);
      db.prepare('INSERT INTO players (id, name, created_at) VALUES (?, ?, ?)').run(uid(), name, Date.now());
      return getState();
    },

    'DELETE /api/players/:id': ({ params }) => {
      const used = db.prepare('SELECT 1 FROM games WHERE ? IN (a1, a2, b1, b2) LIMIT 1').get(params.id);
      if (used) throw new HttpError(409, "Ce joueur a des parties enregistrées dans un événement : supprimez-les d'abord.");
      transaction(() => {
        db.prepare('DELETE FROM rests WHERE player_id = ?').run(params.id);
        db.prepare('DELETE FROM players WHERE id = ?').run(params.id);
      });
      return getState();
    },

    'POST /api/games': ({ body }) => {
      const { a, b, eventId } = body;
      if (!isId(eventId) || !db.prepare('SELECT 1 FROM events WHERE id = ?').get(eventId))
        throw new HttpError(400, 'Événement introuvable (supprimé depuis un autre appareil ?)');
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 2 || b.length !== 2)
        throw new HttpError(400, 'Il faut 2 joueurs par équipe');
      const ids = [...a, ...b];
      if (!ids.every(isId) || new Set(ids).size !== 4) throw new HttpError(400, 'Il faut 4 joueurs différents');
      const known = db.prepare(`SELECT COUNT(*) AS n FROM players WHERE id IN (${ids.map(() => '?').join()})`).get(...ids).n;
      if (known !== 4) throw new HttpError(400, 'Joueur inconnu (supprimé depuis un autre appareil ?)');
      const scores = parseScores(body);
      const now = Date.now();
      transaction(() => {
        // Un joueur ne peut pas être à deux tables à la fois : matchs ajoutés à la main en cours
        // et tables du tour planifié en cours (les tours suivants ne sont pas encore joués)
        const pending = db.prepare('SELECT * FROM games WHERE event_id = ? AND sa IS NULL').all(eventId);
        const round = currentRound(eventId);
        for (const g of pending.filter(g => g.round === null || g.round === round)) {
          const busy = ids.find(id => [g.a1, g.a2, g.b1, g.b2].includes(id));
          if (busy) {
            const who = db.prepare('SELECT name FROM players WHERE id = ?').get(busy).name;
            throw new HttpError(409, `${who} joue déjà à la table ${g.table_no}${g.round ? ` (tour ${g.round})` : ''}.`);
          }
        }
        // Match en cours : première table libre (sans reprendre un numéro de table d'un tour planifié)
        let table = null;
        if (!scores) {
          const used = new Set(pending.map(g => g.table_no));
          for (table = 1; used.has(table); table++);
        }
        db.prepare(`INSERT INTO games (id, event_id, a1, a2, b1, b2, sa, sb, table_no, created_at, finished_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(uid(), eventId, ...ids, scores?.[0] ?? null, scores?.[1] ?? null, table, now, scores ? now : null);
      });
      return getState();
    },

    'PATCH /api/games/:id': ({ params, body }) => {
      const scores = parseScores(body);
      if (!scores) throw new HttpError(400, 'Saisissez les deux scores');
      const done = db.prepare('UPDATE games SET sa = ?, sb = ?, finished_at = ? WHERE id = ? AND sa IS NULL')
        .run(...scores, Date.now(), params.id).changes;
      if (!done) {
        if (!db.prepare('SELECT 1 FROM games WHERE id = ?').get(params.id))
          throw new HttpError(404, 'Match introuvable (annulé depuis un autre appareil ?)');
        throw new HttpError(409, 'Le score de ce match a déjà été saisi (depuis un autre appareil ?)');
      }
      return getState();
    },

    // Correction d'une partie déjà validée. `from` = score affiché lors de la correction :
    // si un autre terminal l'a changé entre-temps, on refuse plutôt que d'écraser sa correction.
    'PUT /api/games/:id/score': ({ params, body }) => {
      const scores = parseScores(body);
      if (!scores) throw new HttpError(400, 'Saisissez les deux scores');
      const g = db.prepare('SELECT sa, sb FROM games WHERE id = ?').get(params.id);
      if (!g) throw new HttpError(404, 'Partie introuvable (supprimée depuis un autre appareil ?)');
      if (g.sa === null) throw new HttpError(409, "Ce match n'est pas terminé : saisissez son score dans l'onglet Partie.");
      const from = body.from;
      if (!Array.isArray(from) || from[0] !== g.sa || from[1] !== g.sb)
        throw new HttpError(409, `Le score a été modifié entre-temps (${g.sa} – ${g.sb}) : vérifiez avant de corriger.`);
      db.prepare('UPDATE games SET sa = ?, sb = ? WHERE id = ?').run(...scores, params.id);
      return getState();
    },

    'DELETE /api/games/:id': ({ params }) => {
      db.prepare('DELETE FROM games WHERE id = ?').run(params.id);
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
