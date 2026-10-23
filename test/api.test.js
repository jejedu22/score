const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openDb, createApp } = require('../server');

// Chaque test démarre un serveur neuf sur une base en mémoire (ou celle fournie)
let server;
async function start(db = openDb(':memory:')) {
  server = createApp(db);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, headers = { 'Content-Type': 'application/json' }) => {
    const r = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };
  const addPlayer = async name => (await call('POST', '/api/players', { name })).data.players.find(p => p.name === name).id;
  const addEvent = async name => (await call('POST', '/api/events', { name })).data.created;
  return { base, call, addPlayer, addEvent };
}
afterEach(() => server.close());

const fourPlayers = api => Promise.all(['A', 'B', 'C', 'D'].map(n => api.addPlayer(n)));

test('joueurs : ajout, nom nettoyé, doublon refusé', async () => {
  const { call } = await start();
  const { status, data } = await call('POST', '/api/players', { name: '  Alice   Martin ' });
  assert.equal(status, 200);
  assert.equal(data.players[0].name, 'Alice Martin');
  assert.equal((await call('POST', '/api/players', { name: 'alice martin' })).status, 409);
  assert.equal((await call('POST', '/api/players', { name: '   ' })).status, 400);
});

test('parties : scores arrondis à 10 et validations', async () => {
  const api = await start();
  const [a, b, c, d] = await fourPlayers(api);
  const eventId = await api.addEvent('Tournoi');
  const ok = await api.call('POST', '/api/games', { eventId, a: [a, b], b: [c, d], sa: 1275, sb: 984 });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.data.games[0].sa, ok.data.games[0].sb, ok.data.games[0].eventId], [1280, 980, eventId]);

  const bad = body => api.call('POST', '/api/games', { eventId, ...body }).then(r => r.status);
  assert.equal(await bad({ a: [a, a], b: [c, d], sa: 0, sb: 0 }), 400);            // joueur en double
  assert.equal(await bad({ a: [a, b, c], b: [d], sa: 0, sb: 0 }), 400);            // équipes mal formées
  assert.equal(await bad({ a: [a, b], b: [c, 'ffffffffff'], sa: 0, sb: 0 }), 400); // joueur inconnu
  assert.equal(await bad({ a: [a, b], b: [c, d], sa: -10, sb: 0 }), 400);
  assert.equal(await bad({ a: [a, b], b: [c, d], sa: 1e300, sb: 0 }), 400);
  assert.equal(await bad({ a: [a, b], b: [c, d], sa: 'x', sb: 0 }), 400);
  assert.equal(await bad({ eventId: 'ffffffffff', a: [a, b], b: [c, d], sa: 0, sb: 0 }), 400); // événement inconnu
  assert.equal(await bad({ eventId: undefined, a: [a, b], b: [c, d], sa: 0, sb: 0 }), 400);
});

test('événements : création, nom unique, renommage, suppression avec ses parties', async () => {
  const api = await start();
  const [a, b, c, d] = await fourPlayers(api);
  const e1 = await api.addEvent('Noël');
  const e2 = await api.addEvent('Pâques');
  assert.equal((await api.call('POST', '/api/events', { name: 'noël' })).status, 409);
  assert.equal((await api.call('PATCH', `/api/events/${e2}`, { name: 'Noël' })).status, 409);
  assert.equal((await api.call('PATCH', `/api/events/${e2}`, { name: 'Pâques 2027' })).data.events[1].name, 'Pâques 2027');
  assert.equal((await api.call('PATCH', '/api/events/ffffffffff', { name: 'X' })).status, 404);

  await api.call('POST', '/api/games', { eventId: e1, a: [a, b], b: [c, d], sa: 100, sb: 60 });
  await api.call('POST', '/api/games', { eventId: e2, a: [a, c], b: [b, d], sa: 90, sb: 70 });
  const { data } = await api.call('DELETE', `/api/events/${e1}`);
  assert.deepEqual(data.events.map(e => e.id), [e2]);
  assert.deepEqual(data.games.map(g => g.eventId), [e2]);   // les parties de Pâques sont intactes
  assert.equal(data.players.length, 4);                     // les joueurs sont conservés
});

test('matchs en cours : tables, joueur occupé, score saisi une seule fois', async () => {
  const api = await start();
  const ids = await Promise.all(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map(n => api.addPlayer(n)));
  const [a, b, c, d, e, f, g, h] = ids;
  const eventId = await api.addEvent('Tournoi');
  const launch = (x, y) => api.call('POST', '/api/games', { eventId, a: x, b: y });

  const t1 = (await launch([a, b], [c, d])).data.games[0];
  assert.deepEqual([t1.table, t1.sa, t1.sb, t1.finishedAt], [1, null, null, null]);
  const busy = await launch([a, e], [f, g]);
  assert.equal(busy.status, 409);
  assert.match(busy.data.error, /A joue déjà à la table 1/);
  const t2 = (await launch([e, f], [g, h])).data.games[1];
  assert.equal(t2.table, 2);

  assert.equal((await api.call('POST', '/api/games', { eventId, a: [e, f], b: [g, h], sa: 100 })).status, 400); // un seul score
  assert.equal((await api.call('PATCH', `/api/games/${t1.id}`, {})).status, 400);
  const done = await api.call('PATCH', `/api/games/${t1.id}`, { sa: 1275, sb: 984 });
  assert.equal(done.status, 200);
  const g1 = done.data.games.find(x => x.id === t1.id);
  assert.deepEqual([g1.sa, g1.sb, g1.table], [1280, 980, 1]);
  assert.ok(g1.finishedAt);
  assert.equal((await api.call('PATCH', `/api/games/${t1.id}`, { sa: 10, sb: 10 })).status, 409); // déjà saisi
  assert.equal((await api.call('PATCH', '/api/games/ffffffffff', { sa: 10, sb: 10 })).status, 404);

  // La table 1 est libérée et réattribuée ; A et B peuvent rejouer
  assert.equal((await launch([a, c], [b, d])).data.games.at(-1).table, 1);
  // Annuler un match en cours libère ses joueurs
  await api.call('DELETE', `/api/games/${t2.id}`);
  assert.equal((await launch([e, g], [f, h])).status, 200);
});

test('correction : score validé modifiable, conflit détecté', async () => {
  const api = await start();
  const [a, b, c, d] = await fourPlayers(api);
  const eventId = await api.addEvent('Tournoi');
  const g = (await api.call('POST', '/api/games', { eventId, a: [a, b], b: [c, d], sa: 1280, sb: 980 })).data.games[0];
  const fix = body => api.call('PUT', `/api/games/${g.id}/score`, body);

  const ok = await fix({ sa: 1004, sb: 1256, from: [1280, 980] });
  assert.equal(ok.status, 200);
  const after = ok.data.games[0];
  assert.deepEqual([after.sa, after.sb, after.finishedAt], [1000, 1260, g.finishedAt]); // arrondi, date conservée
  // Un autre terminal corrige à partir de l'ancien score : refusé
  const stale = await fix({ sa: 500, sb: 500, from: [1280, 980] });
  assert.equal(stale.status, 409);
  assert.match(stale.data.error, /1000 – 1260/);
  assert.equal((await fix({ sa: 500, sb: 500 })).status, 409);           // sans score de départ
  assert.equal((await fix({ sa: 500, from: [1000, 1260] })).status, 400); // score incomplet
  assert.equal((await api.call('PUT', '/api/games/ffffffffff/score', { sa: 1, sb: 1, from: [0, 0] })).status, 404);

  // Un match en cours ne se corrige pas : il se valide
  const t = (await api.call('POST', '/api/games', { eventId, a: [a, c], b: [b, d] })).data.games[1];
  assert.equal((await api.call('PUT', `/api/games/${t.id}/score`, { sa: 1, sb: 1, from: [null, null] })).status, 409);
});

test('planification : tours, repos, tour en cours, matchs à la main, suppression', async () => {
  const api = await start();
  const ids = await Promise.all(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'].map(n => api.addPlayer(n)));
  const eventId = await api.addEvent('Tournoi');
  const planFor = body => api.call('POST', `/api/events/${eventId}/plan`, body);

  assert.equal((await planFor({ players: ids.slice(0, 3), rounds: 2 })).status, 400);
  assert.equal((await planFor({ players: ids, rounds: 0 })).status, 400);
  assert.equal((await planFor({ players: [...ids.slice(0, 4), 'ffffffffff'], rounds: 1 })).status, 400);

  const { status, data } = await planFor({ players: ids, rounds: 3 });
  assert.equal(status, 200);
  assert.deepEqual([data.plan.from, data.plan.to, data.plan.partnerRepeats], [1, 3, 0]);
  assert.equal(data.games.length, 6);                                    // 10 joueurs → 2 tables × 3 tours
  assert.ok(data.games.every(g => g.sa === null && g.round >= 1 && [1, 2].includes(g.table)));
  assert.equal(data.rests.length, 6);                                    // 2 au repos × 3 tours
  for (const r of [1, 2, 3]) {
    const inRound = [...data.games.filter(g => g.round === r).flatMap(g => [...g.a, ...g.b]),
      ...data.rests.filter(x => x.round === r).map(x => x.playerId)];
    assert.equal(new Set(inRound).size, 10);
  }

  // Le tour 1 est en cours : ses joueurs ne peuvent pas jouer ailleurs
  const playing = data.games.find(g => g.round === 1).a;
  const rest3 = ids.filter(id => id !== playing[0]).slice(0, 3);
  const busy = await api.call('POST', '/api/games', { eventId, a: [playing[0], rest3[0]], b: rest3.slice(1) });
  assert.equal(busy.status, 409);
  assert.match(busy.data.error, /table \d \(tour 1\)/);
  // Scores du tour 1 saisis : le tour 2 devient le tour en cours
  for (const g of data.games.filter(g => g.round === 1))
    await api.call('PATCH', `/api/games/${g.id}`, { sa: 1000, sb: 600 });
  const inRound2 = data.games.find(g => g.round === 2).b[0];
  const others = ids.filter(id => id !== inRound2).slice(0, 3);
  const busy2 = await api.call('POST', '/api/games', { eventId, a: [inRound2, others[0]], b: others.slice(1) });
  assert.equal(busy2.status, 409);
  assert.match(busy2.data.error, /tour 2/);

  // Un second planning s'ajoute après le tour 3 et évite les partenaires déjà vus
  const more = await planFor({ players: ids, rounds: 2 });
  assert.deepEqual([more.data.plan.from, more.data.plan.to], [4, 5]);
  const pairs = more.data.games.flatMap(g => [g.a, g.b]).map(t => [...t].sort().join());
  assert.equal(new Set(pairs).size, pairs.length);

  // Supprimer le planning restant : seules les parties terminées (tour 1) et leurs repos restent
  const { data: after } = await api.call('DELETE', `/api/events/${eventId}/plan`);
  assert.ok(after.games.every(g => g.sa !== null && g.round === 1));
  assert.deepEqual([...new Set(after.rests.map(r => r.round))], [1]);
  // Un joueur qui s'est seulement reposé peut être supprimé
  const onlyRested = ids.find(id => !after.games.some(g => [...g.a, ...g.b].includes(id)));
  if (onlyRested) assert.equal((await api.call('DELETE', `/api/players/${onlyRested}`)).status, 200);
});

test('planification : matchs à la main à côté des tours planifiés', async () => {
  const api = await start();
  const ids = await Promise.all(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'].map(n => api.addPlayer(n)));
  const eventId = await api.addEvent('Tournoi');
  // 6 joueurs planifiés : 1 table + 2 au repos par tour ; les 4 autres jouent à la main
  await api.call('POST', `/api/events/${eventId}/plan`, { players: ids.slice(0, 6), rounds: 2 });
  const free = ids.slice(6);
  const adhoc = await api.call('POST', '/api/games', { eventId, a: free.slice(0, 2), b: free.slice(2) });
  assert.equal(adhoc.status, 200);
  const g = adhoc.data.games.find(g => g.round === null);
  assert.equal(g.table, 2);                    // la table 1 est celle des tours planifiés
  // Pas de nouveau planning tant qu'un match à la main est en cours
  assert.equal((await api.call('POST', `/api/events/${eventId}/plan`, { players: ids, rounds: 1 })).status, 409);
  await api.call('PATCH', `/api/games/${g.id}`, { sa: 500, sb: 400 });
  assert.equal((await api.call('POST', `/api/events/${eventId}/plan`, { players: ids, rounds: 1 })).data.plan.from, 3);
});

test('suppression : joueur avec parties protégé', async () => {
  const api = await start();
  const [a, b, c, d] = await fourPlayers(api);
  const eventId = await api.addEvent('Tournoi');
  const { data } = await api.call('POST', '/api/games', { eventId, a: [a, b], b: [c, d], sa: 100, sb: 60 });
  assert.equal((await api.call('DELETE', `/api/players/${a}`)).status, 409);
  assert.equal((await api.call('DELETE', `/api/games/${data.games[0].id}`)).status, 200);
  assert.equal((await api.call('DELETE', `/api/players/${a}`)).data.players.length, 3);
});

test('migration : une base sans événements range ses parties dans « Tournoi »', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'belote-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE players (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE games (id TEXT PRIMARY KEY, a1 TEXT NOT NULL, a2 TEXT NOT NULL, b1 TEXT NOT NULL, b2 TEXT NOT NULL,
      sa INTEGER NOT NULL, sb INTEGER NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO players VALUES ('aaaaaaaaaa','A',1),('bbbbbbbbbb','B',2),('cccccccccc','C',3),('dddddddddd','D',4);
    INSERT INTO games VALUES ('1111111111','aaaaaaaaaa','bbbbbbbbbb','cccccccccc','dddddddddd',1280,980,1000);
  `);
  old.close();

  const { call } = await start(openDb(file));
  const { data } = (await call('GET', '/api/state'));
  assert.equal(data.events.length, 1);
  assert.equal(data.events[0].name, 'Tournoi');
  assert.equal(data.events[0].createdAt, 1000);
  assert.deepEqual(data.games.map(g => [g.id, g.eventId, g.sa]), [['1111111111', data.events[0].id, 1280]]);
  server.close();
  // Réouverture : la migration ne se rejoue pas
  const again = await start(openDb(file));
  assert.equal((await again.call('GET', '/api/state')).data.events.length, 1);
});

test('migration : base avec événements mais sans matchs en cours', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'belote-')), 'v1.db');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE players (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE events (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE games (id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      a1 TEXT NOT NULL, a2 TEXT NOT NULL, b1 TEXT NOT NULL, b2 TEXT NOT NULL,
      sa INTEGER NOT NULL, sb INTEGER NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO players VALUES ('aaaaaaaaaa','A',1),('bbbbbbbbbb','B',2),('cccccccccc','C',3),('dddddddddd','D',4);
    INSERT INTO events VALUES ('eeeeeeeeee','Noël',5);
    INSERT INTO games VALUES ('1111111111','eeeeeeeeee','aaaaaaaaaa','bbbbbbbbbb','cccccccccc','dddddddddd',100,60,7);
  `);
  old.close();
  const { call } = await start(openDb(file));
  const { data } = await call('GET', '/api/state');
  assert.deepEqual(data.events.map(e => e.name), ['Noël']);
  assert.deepEqual(data.games, [{ id: '1111111111', eventId: 'eeeeeeeeee', a: ['aaaaaaaaaa', 'bbbbbbbbbb'],
    b: ['cccccccccc', 'dddddddddd'], sa: 100, sb: 60, table: null, round: null, finishedAt: 7 }]);
  // Un match en cours peut être créé après migration
  assert.equal((await call('POST', '/api/games', { eventId: 'eeeeeeeeee', a: ['aaaaaaaaaa', 'bbbbbbbbbb'],
    b: ['cccccccccc', 'dddddddddd'] })).data.games[1].table, 1);
});

test('protection CSRF : écriture sans JSON refusée', async () => {
  const { call } = await start();
  assert.equal((await call('POST', '/api/events', { name: 'X' }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await call('POST', '/api/players', null)).status, 400);
});

test('fichiers statiques', async () => {
  const { base } = await start();
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/manifest.webmanifest')).headers.get('content-type'), 'application/manifest+json');
  assert.equal((await fetch(base + '/../server.js')).status, 404);
  assert.equal((await fetch(base + '/%2e%2e/server.js')).status, 404);
});
