// Serveur HTTP + SQLite (node:sqlite, aucune dépendance npm).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const planner = require('./planner');
const tournament = require('./tournament');
const coinche = require('./public/coinche');

const PUBLIC = path.join(__dirname, 'public');
const MAX_SCORE = 100_000;
const MAX_NAME = 40;
const MAX_ROUNDS = 30;
const THEMES = ['vert', 'bleu', 'bordeaux', 'violet', 'orange', 'ardoise'];

const uid = () => crypto.randomBytes(5).toString('hex');
const cleanName = v => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_NAME);

// Rend facultatives des colonnes déclarées NOT NULL : SQLite impose de reconstruire la table.
// Clés étrangères désactivées le temps de l'opération, sinon DROP TABLE supprimerait en cascade (donnes).
function relaxNotNull(db, table, cols) {
  const info = db.prepare(`SELECT name, "notnull" AS nn FROM pragma_table_info('${table}')`).all();
  if (!info.some(c => cols.includes(c.name) && c.nn)) return;
  let sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).sql;
  for (const c of cols) sql = sql.replace(new RegExp(`\\b${c} TEXT NOT NULL`), `${c} TEXT`);
  sql = sql.replace(/^CREATE TABLE\s+"?\w+"?/, `CREATE TABLE ${table}_new`);
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.exec(`INSERT INTO ${table}_new SELECT * FROM ${table}; DROP TABLE ${table};
        ALTER TABLE ${table}_new RENAME TO ${table}; COMMIT`);
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  } finally { db.exec('PRAGMA foreign_keys = ON'); }
}

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
    -- Joueurs : NULL possible pour une équipe inscrite sans ses joueurs (mode équipe)
    a1 TEXT REFERENCES players(id), a2 TEXT REFERENCES players(id),
    b1 TEXT REFERENCES players(id), b2 TEXT REFERENCES players(id),
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
  // Colonnes ajoutées au fil des versions (ALTER TABLE suffit : colonnes facultatives)
  const addColumn = (table, col, def) => {
    if (!db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(col))
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  };
  addColumn('games', 'round', 'INTEGER');
  addColumn('games', 'team_a', 'TEXT');   // équipes (événement en mode équipe)
  addColumn('games', 'team_b', 'TEXT');
  addColumn('games', 'stage', 'TEXT');    // 'group' (poule) ou 'ko' (phase finale), NULL hors tournoi
  addColumn('games', 'grp', 'INTEGER');   // numéro de poule (0 = A)
  addColumn('games', 'ko', 'INTEGER');    // phase finale : nombre d'équipes du tour (8 = quarts)
  addColumn('games', 'slot', 'INTEGER');  // phase finale : position du match dans le tableau
  addColumn('events', 'mode', "TEXT NOT NULL DEFAULT 'individual'");   // 'individual' ou 'team'
  addColumn('events', 'closed_at', 'INTEGER');
  addColumn('events', 'groups', 'INTEGER');    // tournoi : nombre de poules (NULL = pas de tournoi)
  addColumn('events', 'ko_size', 'INTEGER');   // tournoi : équipes au premier tour de la phase finale
  // Réglages de partie : saisie du score final ou donne par donne, fin de partie, décompte, arrondi, couleurs
  addColumn('events', 'entry', "TEXT NOT NULL DEFAULT 'total'");        // 'total' ou 'deals'
  addColumn('events', 'end_type', "TEXT NOT NULL DEFAULT 'points'");    // 'points' ou 'rounds'
  addColumn('events', 'end_value', 'INTEGER NOT NULL DEFAULT 1000');
  addColumn('events', 'count_mode', "TEXT NOT NULL DEFAULT 'points'");  // 'contract' ou 'points'
  addColumn('events', 'rounding', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('events', 'theme', "TEXT NOT NULL DEFAULT 'vert'");
  db.exec(`
  -- Donnes d'une partie saisie donne par donne (points marqués calculés à la saisie)
  CREATE TABLE IF NOT EXISTS deals (
    game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    taker TEXT NOT NULL, contract INTEGER NOT NULL, coinche INTEGER NOT NULL, belote TEXT,
    points INTEGER, made INTEGER NOT NULL,
    pa INTEGER NOT NULL, pb INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (game_id, idx)
  );
  -- Équipes fixes d'un événement en mode équipe
  CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    p1 TEXT REFERENCES players(id), p2 TEXT REFERENCES players(id),   -- joueurs facultatifs
    grp INTEGER,
    created_at INTEGER NOT NULL
  );
  -- Joueurs au repos pour un tour planifié (nombre de joueurs non multiple de 4)
  CREATE TABLE IF NOT EXISTS rests (
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    round INTEGER NOT NULL,
    player_id TEXT NOT NULL REFERENCES players(id),
    PRIMARY KEY (event_id, round, player_id)
  );
  `);
  relaxNotNull(db, 'games', ['a1', 'a2', 'b1', 'b2']);
  relaxNotNull(db, 'teams', ['p1', 'p2']);
  db.exec('CREATE INDEX IF NOT EXISTS games_event ON games(event_id)');

  // Joueurs inscrits à chaque événement (un joueur garde son identité d'un événement à l'autre)
  const hadRoster = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'event_players'").get();
  db.exec(`CREATE TABLE IF NOT EXISTS event_players (
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    player_id TEXT NOT NULL REFERENCES players(id),
    PRIMARY KEY (event_id, player_id)
  )`);
  if (!hadRoster) {
    // Migration : chaque événement reçoit ceux qui y ont joué ; les événements ouverts, tous les joueurs
    // (avant, les joueurs étaient communs : rien ne disparaît des listes en cours)
    db.exec(`INSERT OR IGNORE INTO event_players (event_id, player_id)
      SELECT event_id, p FROM (SELECT event_id, a1 AS p FROM games UNION SELECT event_id, a2 FROM games
        UNION SELECT event_id, b1 FROM games UNION SELECT event_id, b2 FROM games
        UNION SELECT event_id, player_id FROM rests UNION SELECT event_id, p1 FROM teams UNION SELECT event_id, p2 FROM teams)
      WHERE p IS NOT NULL;
      INSERT OR IGNORE INTO event_players (event_id, player_id)
      SELECT e.id, p.id FROM events e, players p WHERE e.closed_at IS NULL`);
  }
  return db;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const round10 = n => Math.round(n / 10) * 10;
const isId = v => typeof v === 'string' && /^[0-9a-f]{10}$/.test(v);

// Scores tous deux vides → null (match en cours) ; sinon deux scores valides (arrondis à 10 si demandé)
function parseScores(body, rounding = true) {
  const empty = v => v === undefined || v === null || v === '';
  if (empty(body.sa) && empty(body.sb)) return null;
  if (empty(body.sa) || empty(body.sb)) throw new HttpError(400, 'Saisissez les deux scores');
  const scores = [Number(body.sa), Number(body.sb)].map(n => (rounding ? round10(n) : n));
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
    const events = db.prepare(`SELECT id, name, created_at AS createdAt, mode, closed_at AS closedAt,
      groups, ko_size AS koSize, entry, end_type AS endType, end_value AS endValue, count_mode AS count,
      rounding, theme FROM events ORDER BY created_at, rowid`).all().map(e => ({ ...e, rounding: !!e.rounding }));
    const players = db.prepare('SELECT id, name FROM players ORDER BY created_at, rowid').all();
    const games = db.prepare('SELECT * FROM games ORDER BY created_at, rowid').all()
      .map(g => ({ id: g.id, eventId: g.event_id, a: [g.a1, g.a2], b: [g.b1, g.b2], sa: g.sa, sb: g.sb,
        table: g.table_no, round: g.round, finishedAt: g.finished_at,
        teamA: g.team_a, teamB: g.team_b, stage: g.stage, grp: g.grp, ko: g.ko, slot: g.slot }));
    const rests = db.prepare('SELECT event_id AS eventId, round, player_id AS playerId FROM rests ORDER BY round').all();
    const teams = db.prepare(`SELECT id, event_id AS eventId, name, p1, p2, grp FROM teams ORDER BY created_at, rowid`).all()
      .map(({ p1, p2, ...t }) => ({ ...t, players: [p1, p2] }));
    const deals = db.prepare(`SELECT game_id AS gameId, idx, taker, contract, coinche, belote, points, made, pa, pb
      FROM deals ORDER BY game_id, idx`).all().map(d => ({ ...d, made: !!d.made }));
    const roster = db.prepare('SELECT event_id AS eventId, player_id AS playerId FROM event_players').all();
    return { events, players, games, rests, teams, deals, roster };
  }

  // Tour planifié en cours : le plus petit tour qui a encore des matchs sans score
  const currentRound = eventId =>
    db.prepare('SELECT MIN(round) AS r FROM games WHERE event_id = ? AND sa IS NULL AND round IS NOT NULL').get(eventId).r;

  const getEvent = id => {
    const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
    if (!ev) throw new HttpError(404, 'Événement introuvable (supprimé depuis un autre appareil ?)');
    return ev;
  };
  const assertOpen = ev => {
    if (ev.closed_at) throw new HttpError(409, `L'événement « ${ev.name} » est clos : rouvrez-le pour le modifier.`);
    return ev;
  };
  const gameOf = id => {
    const g = db.prepare('SELECT * FROM games WHERE id = ?').get(id);
    if (!g) throw new HttpError(404, 'Partie introuvable (supprimée depuis un autre appareil ?)');
    return g;
  };
  const nextRound = eventId => (db.prepare('SELECT MAX(round) AS r FROM games WHERE event_id = ?').get(eventId).r ?? 0) + 1;
  const insertGame = db.prepare(`INSERT INTO games (id, event_id, a1, a2, b1, b2, sa, sb, table_no, round, created_at,
    finished_at, team_a, team_b, stage, grp, ko, slot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  // Match entre deux équipes fixes : les joueurs sont repris de l'équipe
  const teamGame = (eventId, ta, tb, extra) => {
    const t = id => db.prepare('SELECT p1, p2 FROM teams WHERE id = ?').get(id);
    const [x, y] = [t(ta), t(tb)];
    insertGame.run(uid(), eventId, x.p1, x.p2, y.p1, y.p2, extra.sa ?? null, extra.sb ?? null, extra.table ?? null,
      extra.round ?? null, Date.now(), extra.sa != null ? Date.now() : null, ta, tb,
      extra.stage ?? null, extra.grp ?? null, extra.ko ?? null, extra.slot ?? null);
  };
  const winnerOf = g => (g.sa > g.sb ? g.team_a : g.team_b);
  // Un joueur qui joue dans un événement y est inscrit
  const enroll = (eventId, ids) => ids.filter(Boolean).forEach(id =>
    db.prepare('INSERT OR IGNORE INTO event_players (event_id, player_id) VALUES (?, ?)').run(eventId, id));
  const playerName = id => (id ? db.prepare('SELECT name FROM players WHERE id = ?').get(id)?.name : undefined);
  const scoring = ev => ({ count: ev.count_mode, rounding: !!ev.rounding });

  // Un résultat qui contredirait la suite du tournoi (poules figées, vainqueur déjà qualifié) est refusé
  function assertResultEditable(g, newScores) {
    if (g.stage === 'group' && db.prepare("SELECT 1 FROM games WHERE event_id = ? AND stage = 'ko'").get(g.event_id))
      throw new HttpError(409, 'La phase finale a commencé : les résultats des poules sont figés.');
    if (g.stage === 'ko' && g.sa !== null && db.prepare("SELECT 1 FROM games WHERE event_id = ? AND stage = 'ko' AND ko = ?").get(g.event_id, g.ko / 2)
      && (!newScores || (newScores[0] > newScores[1]) !== (g.sa > g.sb)))
      throw new HttpError(409, 'Le tour suivant est déjà lancé : cette modification changerait le vainqueur.');
  }

  // Validation des réglages de partie (PATCH /api/events/:id)
  function parseSettings(body, ev) {
    const s = {
      entry: body.entry ?? ev.entry, end_type: body.endType ?? ev.end_type, end_value: Number(body.endValue ?? ev.end_value),
      count_mode: body.count ?? ev.count_mode, rounding: body.rounding ?? !!ev.rounding, theme: body.theme ?? ev.theme,
    };
    if (!['total', 'deals'].includes(s.entry)) throw new HttpError(400, 'Mode de saisie invalide');
    if (!['points', 'rounds'].includes(s.end_type)) throw new HttpError(400, 'Fin de partie invalide');
    const [min, max] = s.end_type === 'rounds' ? [1, 50] : [100, 10_000];
    if (!Number.isInteger(s.end_value) || s.end_value < min || s.end_value > max)
      throw new HttpError(400, s.end_type === 'rounds' ? `Nombre de donnes : entre ${min} et ${max}` : `Objectif : entre ${min} et ${max} points`);
    if (!['contract', 'points'].includes(s.count_mode)) throw new HttpError(400, 'Décompte invalide');
    if (typeof s.rounding !== 'boolean') throw new HttpError(400, 'Arrondi invalide');
    if (!THEMES.includes(s.theme)) throw new HttpError(400, 'Couleurs invalides');
    return { ...s, rounding: s.rounding ? 1 : 0 };
  }

  // Phase finale : quand tous les matchs d'un tour sont joués, le tour suivant est créé
  function advanceKnockout(eventId, ko) {
    const games = db.prepare("SELECT * FROM games WHERE event_id = ? AND stage = 'ko' AND ko = ? ORDER BY slot").all(eventId, ko);
    if (ko <= 2 || games.some(g => g.sa === null)) return;
    if (db.prepare("SELECT 1 FROM games WHERE event_id = ? AND stage = 'ko' AND ko = ?").get(eventId, ko / 2)) return;
    const round = nextRound(eventId);
    tournament.nextKnockoutRound(games.map(winnerOf)).forEach(([ta, tb], i) =>
      teamGame(eventId, ta, tb, { table: i + 1, round, stage: 'ko', ko: ko / 2, slot: i }));
  }

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
      const mode = body.mode ?? 'individual';
      if (!['individual', 'team'].includes(mode)) throw new HttpError(400, 'Mode invalide');
      db.prepare('INSERT INTO events (id, name, created_at, mode) VALUES (?, ?, ?, ?)').run(id, eventName(body), Date.now(), mode);
      return { ...getState(), created: id };
    },

    // Renommer, changer de mode (tant que rien n'est joué), clore ou rouvrir
    'PATCH /api/events/:id': ({ params, body }) => {
      const ev = getEvent(params.id);
      transaction(() => {
        if (body.name !== undefined) db.prepare('UPDATE events SET name = ? WHERE id = ?').run(eventName(body, ev.id), ev.id);
        if (body.mode !== undefined && body.mode !== ev.mode) {
          assertOpen(ev);
          if (!['individual', 'team'].includes(body.mode)) throw new HttpError(400, 'Mode invalide');
          if (db.prepare('SELECT 1 FROM games WHERE event_id = ? UNION SELECT 1 FROM teams WHERE event_id = ?').get(ev.id, ev.id))
            throw new HttpError(409, 'Le mode ne peut plus changer : cet événement a déjà des parties ou des équipes.');
          db.prepare('UPDATE events SET mode = ? WHERE id = ?').run(body.mode, ev.id);
        }
        if (body.closed === true && !ev.closed_at) {
          if (db.prepare('SELECT 1 FROM games WHERE event_id = ? AND sa IS NULL').get(ev.id))
            throw new HttpError(409, 'Des parties sont encore en cours ou planifiées : saisissez leurs scores ou supprimez-les avant de clore.');
          db.prepare('UPDATE events SET closed_at = ? WHERE id = ?').run(Date.now(), ev.id);
        }
        if (body.closed === false) db.prepare('UPDATE events SET closed_at = NULL WHERE id = ?').run(ev.id);
        if (body.settings !== undefined) {
          if (typeof body.settings !== 'object' || body.settings === null) throw new HttpError(400, 'Réglages invalides');
          const s = parseSettings(body.settings, ev);
          // Les couleurs restent modifiables sur un événement clos, pas les règles de partie
          const rulesChanged = ['entry', 'end_type', 'end_value', 'count_mode', 'rounding'].some(k => s[k] !== ev[k]);
          if (rulesChanged) assertOpen(getEvent(ev.id));
          db.prepare(`UPDATE events SET entry = ?, end_type = ?, end_value = ?, count_mode = ?, rounding = ?, theme = ?
            WHERE id = ?`).run(s.entry, s.end_type, s.end_value, s.count_mode, s.rounding, s.theme, ev.id);
        }
      });
      return getState();
    },

    'DELETE /api/events/:id': ({ params }) => {
      transaction(() => {
        db.prepare('DELETE FROM games WHERE event_id = ?').run(params.id);
        db.prepare('DELETE FROM rests WHERE event_id = ?').run(params.id);
        db.prepare('DELETE FROM teams WHERE event_id = ?').run(params.id);
        db.prepare('DELETE FROM event_players WHERE event_id = ?').run(params.id);
        db.prepare('DELETE FROM events WHERE id = ?').run(params.id);
      });
      return getState();
    },

    // Planification automatique de plusieurs tours, ajoutés après les tours existants
    'POST /api/events/:id/plan': ({ params, body }) => {
      const ev = assertOpen(getEvent(params.id));
      if (ev.mode !== 'individual') throw new HttpError(400, 'La planification des partenaires concerne les événements en individuel.');
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
        throw new HttpError(409, 'Terminez ou annulez les parties en cours avant de planifier des tours.');

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
        enroll(params.id, players);
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
      assertOpen(getEvent(params.id));
      transaction(() => {
        db.prepare('DELETE FROM games WHERE event_id = ? AND sa IS NULL AND round IS NOT NULL AND stage IS NULL').run(params.id);
        db.prepare(`DELETE FROM rests WHERE event_id = ? AND round NOT IN
          (SELECT round FROM games WHERE event_id = ? AND round IS NOT NULL)`).run(params.id, params.id);
      });
      return getState();
    },

    'POST /api/events/:id/teams': ({ params, body }) => {
      const ev = assertOpen(getEvent(params.id));
      if (ev.mode !== 'team') throw new HttpError(400, "Cet événement n'est pas en mode équipe.");
      if (ev.groups) throw new HttpError(409, 'Le tournoi est lancé : les équipes ne peuvent plus changer.');
      // Joueurs facultatifs (0, 1 ou 2) : un nom d'équipe peut suffire
      const ids = (body.players ?? []).filter(Boolean);
      if (!Array.isArray(body.players ?? []) || ids.length > 2 || !ids.every(isId) || new Set(ids).size !== ids.length)
        throw new HttpError(400, 'Choisissez au plus 2 joueurs différents');
      const names = ids.map(playerName);
      if (names.includes(undefined)) throw new HttpError(400, 'Joueur inconnu (supprimé depuis un autre appareil ?)');
      for (const [i, id] of ids.entries()) {
        const other = db.prepare('SELECT name FROM teams WHERE event_id = ? AND ? IN (p1, p2)').get(ev.id, id);
        if (other) throw new HttpError(409, `${names[i]} fait déjà partie de l'équipe « ${other.name} ».`);
      }
      const name = cleanName(body.name) || names.join(' & ');
      if (!name) throw new HttpError(400, "Donnez un nom à l'équipe (ou choisissez ses joueurs)");
      if (db.prepare('SELECT 1 FROM teams WHERE event_id = ? AND name = ? COLLATE NOCASE').get(ev.id, name))
        throw new HttpError(409, `L'équipe « ${name} » existe déjà.`);
      transaction(() => {
        db.prepare('INSERT INTO teams (id, event_id, name, p1, p2, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(uid(), ev.id, name, ids[0] ?? null, ids[1] ?? null, Date.now());
        enroll(ev.id, ids);
      });
      return getState();
    },

    'PATCH /api/teams/:id': ({ params, body }) => {
      const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(params.id);
      if (!team) throw new HttpError(404, 'Équipe introuvable');
      assertOpen(getEvent(team.event_id));
      const name = cleanName(body.name);
      if (!name) throw new HttpError(400, 'Nom requis');
      if (db.prepare('SELECT 1 FROM teams WHERE event_id = ? AND name = ? COLLATE NOCASE AND id != ?').get(team.event_id, name, team.id))
        throw new HttpError(409, `L'équipe « ${name} » existe déjà.`);
      db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(name, team.id);
      return getState();
    },

    'DELETE /api/teams/:id': ({ params }) => {
      const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(params.id);
      if (!team) return getState();
      const ev = assertOpen(getEvent(team.event_id));
      if (ev.groups) throw new HttpError(409, 'Le tournoi est lancé : les équipes ne peuvent plus changer.');
      if (db.prepare('SELECT 1 FROM games WHERE ? IN (team_a, team_b)').get(team.id))
        throw new HttpError(409, "Cette équipe a des parties enregistrées : supprimez-les d'abord.");
      db.prepare('DELETE FROM teams WHERE id = ?').run(team.id);
      return getState();
    },

    // Lance le tournoi : tirage des poules et matchs de poule (chacun contre chacun), en tours
    'POST /api/events/:id/tournament': ({ params, body }) => {
      const ev = assertOpen(getEvent(params.id));
      if (ev.mode !== 'team') throw new HttpError(400, 'Le tournoi se joue en mode équipe.');
      if (ev.groups) throw new HttpError(409, 'Le tournoi est déjà lancé.');
      if (db.prepare('SELECT 1 FROM games WHERE event_id = ? AND sa IS NULL').get(ev.id))
        throw new HttpError(409, 'Terminez ou annulez les parties en cours avant de lancer le tournoi.');
      const teams = db.prepare('SELECT id FROM teams WHERE event_id = ? ORDER BY created_at, rowid').all(ev.id).map(t => t.id);
      const groups = Number(body.groups), koSize = Number(body.koSize);
      try { tournament.checkConfig(teams.length, groups, koSize); }
      catch (e) { throw new HttpError(400, e.message); }

      const drawn = tournament.drawGroups(teams, groups);
      const schedules = drawn.map(tournament.roundRobin);
      const first = nextRound(ev.id);
      transaction(() => {
        db.prepare('UPDATE events SET groups = ?, ko_size = ? WHERE id = ?').run(groups, koSize, ev.id);
        drawn.forEach((ids, g) => ids.forEach(id => db.prepare('UPDATE teams SET grp = ? WHERE id = ?').run(g, id)));
        // L'équipe exemptée d'un tour (poule impaire) est celle de la poule qui n'y joue pas : rien à stocker
        const rounds = Math.max(...schedules.map(s => s.length));
        for (let r = 0; r < rounds; r++) {
          let table = 0;
          schedules.forEach((sched, g) => {
            for (const [ta, tb] of sched[r]?.pairs ?? []) teamGame(ev.id, ta, tb, { table: ++table, round: first + r, stage: 'group', grp: g });
          });
        }
      });
      return getState();
    },

    // Phase finale : les meilleures équipes de chaque poule, croisées entre poules
    'POST /api/events/:id/tournament/final': ({ params }) => {
      const ev = assertOpen(getEvent(params.id));
      if (!ev.groups) throw new HttpError(409, "Le tournoi n'est pas lancé.");
      if (db.prepare("SELECT 1 FROM games WHERE event_id = ? AND stage = 'ko'").get(ev.id))
        throw new HttpError(409, 'La phase finale a déjà commencé.');
      if (db.prepare("SELECT 1 FROM games WHERE event_id = ? AND stage = 'group' AND sa IS NULL").get(ev.id))
        throw new HttpError(409, 'Toutes les parties de poule doivent être jouées avant la phase finale.');
      const perGroup = ev.ko_size / ev.groups;
      const games = db.prepare("SELECT team_a AS ta, team_b AS tb, sa, sb FROM games WHERE event_id = ? AND stage = 'group'").all(ev.id);
      const qualified = Array.from({ length: ev.groups }, (_, g) => {
        const ids = db.prepare('SELECT id FROM teams WHERE event_id = ? AND grp = ? ORDER BY name').all(ev.id, g).map(t => t.id);
        return tournament.standings(ids, games).slice(0, perGroup).map(t => t.id);
      });
      const round = nextRound(ev.id);
      transaction(() => tournament.firstKnockoutRound(qualified).forEach(([ta, tb], i) =>
        teamGame(ev.id, ta, tb, { table: i + 1, round, stage: 'ko', ko: ev.ko_size, slot: i })));
      return getState();
    },

    // Réinitialise le tournoi : supprime ses matchs (joués ou non) et le tirage des poules
    'DELETE /api/events/:id/tournament': ({ params }) => {
      const ev = assertOpen(getEvent(params.id));
      transaction(() => {
        db.prepare('DELETE FROM games WHERE event_id = ? AND stage IS NOT NULL').run(ev.id);
        db.prepare(`DELETE FROM rests WHERE event_id = ? AND round NOT IN
          (SELECT round FROM games WHERE event_id = ? AND round IS NOT NULL)`).run(ev.id, ev.id);
        db.prepare('UPDATE teams SET grp = NULL WHERE event_id = ?').run(ev.id);
        db.prepare('UPDATE events SET groups = NULL, ko_size = NULL WHERE id = ?').run(ev.id);
      });
      return getState();
    },

    // Inscrire des joueurs à un événement : par nom (joueur existant réutilisé, sinon créé) ou par ids
    'POST /api/events/:id/players': ({ params, body }) => {
      const ev = assertOpen(getEvent(params.id));
      let ids;
      if (body.ids !== undefined) {
        if (!Array.isArray(body.ids) || !body.ids.length || !body.ids.every(isId)) throw new HttpError(400, 'Liste de joueurs invalide');
        if (body.ids.some(id => !playerName(id))) throw new HttpError(400, 'Joueur inconnu (supprimé depuis un autre appareil ?)');
        ids = body.ids;
      } else {
        const name = cleanName(body.name);
        if (!name) throw new HttpError(400, 'Nom requis');
        const existing = db.prepare('SELECT id, name FROM players WHERE name = ? COLLATE NOCASE').get(name);
        if (existing && db.prepare('SELECT 1 FROM event_players WHERE event_id = ? AND player_id = ?').get(ev.id, existing.id))
          throw new HttpError(409, `« ${existing.name} » est déjà inscrit à cet événement.`);
        ids = [existing?.id ?? uid()];
        if (!existing) db.prepare('INSERT INTO players (id, name, created_at) VALUES (?, ?, ?)').run(ids[0], name, Date.now());
      }
      transaction(() => enroll(ev.id, ids));
      return getState();
    },

    'DELETE /api/events/:id/players/:player': ({ params }) => {
      const ev = assertOpen(getEvent(params.id));
      const pid = params.player;
      if (db.prepare('SELECT 1 FROM games WHERE event_id = ? AND ? IN (a1, a2, b1, b2)').get(ev.id, pid))
        throw new HttpError(409, 'Ce joueur a des parties (jouées ou planifiées) dans cet événement : supprimez-les d\'abord.');
      const team = db.prepare('SELECT name FROM teams WHERE event_id = ? AND ? IN (p1, p2)').get(ev.id, pid);
      if (team) throw new HttpError(409, `Ce joueur fait partie de l'équipe « ${team.name} ».`);
      transaction(() => {
        db.prepare('DELETE FROM rests WHERE event_id = ? AND player_id = ?').run(ev.id, pid);
        db.prepare('DELETE FROM event_players WHERE event_id = ? AND player_id = ?').run(ev.id, pid);
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
      const team = db.prepare('SELECT name FROM teams WHERE ? IN (p1, p2)').get(params.id);
      if (team) throw new HttpError(409, `Ce joueur fait partie de l'équipe « ${team.name} » : retirez-la d'abord.`);
      transaction(() => {
        db.prepare('DELETE FROM rests WHERE player_id = ?').run(params.id);
        db.prepare('DELETE FROM event_players WHERE player_id = ?').run(params.id);
        db.prepare('DELETE FROM players WHERE id = ?').run(params.id);
      });
      return getState();
    },

    'POST /api/games': ({ body }) => {
      const { eventId } = body;
      let { a, b } = body;
      if (!isId(eventId) || !db.prepare('SELECT 1 FROM events WHERE id = ?').get(eventId))
        throw new HttpError(400, 'Événement introuvable (supprimé depuis un autre appareil ?)');
      const ev = assertOpen(getEvent(eventId));
      let teamIds = [null, null], teams = null;
      if (ev.mode === 'team') {
        if (ev.groups) throw new HttpError(409, 'Pendant le tournoi, les parties sont générées automatiquement.');
        const team = id => isId(id) && db.prepare('SELECT * FROM teams WHERE id = ? AND event_id = ?').get(id, eventId);
        teams = [team(body.teamA), team(body.teamB)];
        const [ta, tb] = teams;
        if (!ta || !tb) throw new HttpError(400, 'Choisissez deux équipes de cet événement');
        if (ta.id === tb.id) throw new HttpError(400, 'Choisissez deux équipes différentes');
        [a, b, teamIds] = [[ta.p1, ta.p2], [tb.p1, tb.p2], [ta.id, tb.id]];   // joueurs éventuellement absents
      } else {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 2 || b.length !== 2)
          throw new HttpError(400, 'Il faut 2 joueurs par équipe');
        const ids = [...a, ...b];
        if (!ids.every(isId) || new Set(ids).size !== 4) throw new HttpError(400, 'Il faut 4 joueurs différents');
        const known = db.prepare(`SELECT COUNT(*) AS n FROM players WHERE id IN (${ids.map(() => '?').join()})`).get(...ids).n;
        if (known !== 4) throw new HttpError(400, 'Joueur inconnu (supprimé depuis un autre appareil ?)');
      }
      const ids = [...a, ...b];
      const scores = parseScores(body, !!ev.rounding);
      const now = Date.now();
      transaction(() => {
        // Un joueur ne peut pas être à deux tables à la fois : matchs ajoutés à la main en cours
        // et tables du tour planifié en cours (les tours suivants ne sont pas encore joués)
        const pending = db.prepare('SELECT * FROM games WHERE event_id = ? AND sa IS NULL').all(eventId);
        const round = currentRound(eventId);
        for (const g of pending.filter(g => g.round === null || g.round === round)) {
          // En équipes, on contrôle les équipes (leurs joueurs peuvent ne pas être renseignés)
          const who = teams ? teams.find(t => [g.team_a, g.team_b].includes(t.id))?.name
            : playerName(ids.find(id => [g.a1, g.a2, g.b1, g.b2].includes(id)));
          if (who) throw new HttpError(409, `${who} joue déjà à la table ${g.table_no}${g.round ? ` (tour ${g.round})` : ''}.`);
        }
        // Match en cours : première table libre (sans reprendre un numéro de table d'un tour planifié)
        let table = null;
        if (!scores) {
          const used = new Set(pending.map(g => g.table_no));
          for (table = 1; used.has(table); table++);
        }
        insertGame.run(uid(), eventId, ...ids, scores?.[0] ?? null, scores?.[1] ?? null, table, null, now,
          scores ? now : null, ...teamIds, null, null, null, null);
        enroll(eventId, ids);
      });
      return getState();
    },

    'PATCH /api/games/:id': ({ params, body }) => {
      const g = db.prepare('SELECT * FROM games WHERE id = ?').get(params.id);
      if (!g) throw new HttpError(404, 'Partie introuvable (annulé depuis un autre appareil ?)');
      const ev = assertOpen(getEvent(g.event_id));
      const scores = parseScores(body, !!ev.rounding);
      if (!scores) throw new HttpError(400, 'Saisissez les deux scores');
      if (g.stage === 'ko' && scores[0] === scores[1]) throw new HttpError(400, "Pas d'égalité en phase finale : il faut un vainqueur.");
      transaction(() => {
        const done = db.prepare('UPDATE games SET sa = ?, sb = ?, finished_at = ? WHERE id = ? AND sa IS NULL')
          .run(...scores, Date.now(), g.id).changes;
        if (!done) throw new HttpError(409, 'Le score de cette partie a déjà été saisi (depuis un autre appareil ?)');
        if (g.stage === 'ko') advanceKnockout(g.event_id, g.ko);
      });
      return getState();
    },

    // Correction d'une partie déjà validée. `from` = score affiché lors de la correction :
    // si un autre terminal l'a changé entre-temps, on refuse plutôt que d'écraser sa correction.
    'PUT /api/games/:id/score': ({ params, body }) => {
      const g = gameOf(params.id);
      const ev = assertOpen(getEvent(g.event_id));
      const scores = parseScores(body, !!ev.rounding);
      if (!scores) throw new HttpError(400, 'Saisissez les deux scores');
      if (g.sa === null) throw new HttpError(409, "Cette partie n'est pas terminée : saisissez son score dans l'onglet Partie.");
      if (g.stage === 'ko' && scores[0] === scores[1]) throw new HttpError(400, "Pas d'égalité en phase finale : il faut un vainqueur.");
      // Tournoi : une correction ne doit pas contredire la suite déjà générée
      assertResultEditable(g, scores);
      const from = body.from;
      if (!Array.isArray(from) || from[0] !== g.sa || from[1] !== g.sb)
        throw new HttpError(409, `Le score a été modifié entre-temps (${g.sa} – ${g.sb}) : vérifiez avant de corriger.`);
      db.prepare('UPDATE games SET sa = ?, sb = ? WHERE id = ?').run(...scores, params.id);
      return getState();
    },

    // Saisie donne par donne. `idx` = nombre de donnes connues du terminal : si une autre donne a été
    // saisie entre-temps (autre téléphone à la même table), on refuse plutôt que de la doubler.
    'POST /api/games/:id/deals': ({ params, body }) => {
      const g = gameOf(params.id);
      const ev = assertOpen(getEvent(g.event_id));
      if (g.sa !== null) throw new HttpError(409, 'Cette partie est terminée.');
      const count = db.prepare('SELECT COUNT(*) AS n FROM deals WHERE game_id = ?').get(g.id).n;
      if (body.idx !== count) throw new HttpError(409, 'Une donne vient d\'être saisie sur un autre appareil : vérifiez le score avant de continuer.');
      const deal = { taker: body.taker, contract: Number(body.contract), coinche: Number(body.coinche ?? 1), belote: body.belote ?? null,
        points: body.points === undefined || body.points === null || body.points === '' ? null : Number(body.points), made: body.made };
      const settings = scoring(ev);
      const err = coinche.checkDeal(deal, settings);
      if (err) throw new HttpError(400, err);
      const { pa, pb, made } = coinche.scoreDeal(deal, settings);
      transaction(() => {
        db.prepare(`INSERT INTO deals (game_id, idx, taker, contract, coinche, belote, points, made, pa, pb, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(g.id, count, deal.taker, deal.contract, deal.coinche, deal.belote,
          deal.contract === coinche.CAPOT || settings.count === 'contract' ? null : deal.points, made ? 1 : 0, pa, pb, Date.now());
        const { sa, sb, n } = db.prepare('SELECT SUM(pa) AS sa, SUM(pb) AS sb, COUNT(*) AS n FROM deals WHERE game_id = ?').get(g.id);
        if (coinche.isOver(sa, sb, n, { type: ev.end_type, value: ev.end_value }, g.stage === 'ko')) {
          db.prepare('UPDATE games SET sa = ?, sb = ?, finished_at = ? WHERE id = ?').run(sa, sb, Date.now(), g.id);
          if (g.stage === 'ko') advanceKnockout(g.event_id, g.ko);
        }
      });
      return getState();
    },

    // Annule la dernière donne (erreur de saisie) ; si elle avait terminé la partie, la partie reprend
    'DELETE /api/games/:id/deals/last': ({ params }) => {
      const g = gameOf(params.id);
      assertOpen(getEvent(g.event_id));
      const last = db.prepare('SELECT MAX(idx) AS i FROM deals WHERE game_id = ?').get(g.id).i;
      if (last === null) throw new HttpError(409, 'Aucune donne à annuler.');
      if (g.sa !== null) assertResultEditable(g, null);
      transaction(() => {
        db.prepare('DELETE FROM deals WHERE game_id = ? AND idx = ?').run(g.id, last);
        db.prepare('UPDATE games SET sa = NULL, sb = NULL, finished_at = NULL WHERE id = ?').run(g.id);
      });
      return getState();
    },

    'DELETE /api/games/:id': ({ params }) => {
      const g = db.prepare('SELECT * FROM games WHERE id = ?').get(params.id);
      if (!g) return getState();
      assertOpen(getEvent(g.event_id));
      if (g.stage) throw new HttpError(409, 'Les parties du tournoi ne se suppriment pas une par une : réinitialisez le tournoi si besoin.');
      db.prepare('DELETE FROM games WHERE id = ?').run(g.id);
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
