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
