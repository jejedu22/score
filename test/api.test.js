const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb, createApp } = require('../server');

let server, base;
before(async () => {
  server = createApp(openDb(':memory:'));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const call = async (method, url, body, headers = { 'Content-Type': 'application/json' }) => {
  const r = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
};
const addPlayer = async name => (await call('POST', '/api/players', { name })).data.players.find(p => p.name === name).id;

test('joueurs : ajout, nom nettoyé, doublon refusé', async () => {
  await call('POST', '/api/reset', {});
  const { status, data } = await call('POST', '/api/players', { name: '  Alice   Martin ' });
  assert.equal(status, 200);
  assert.equal(data.players[0].name, 'Alice Martin');
  assert.equal((await call('POST', '/api/players', { name: 'alice martin' })).status, 409);
  assert.equal((await call('POST', '/api/players', { name: '   ' })).status, 400);
});

test('parties : scores arrondis à 10 et validations', async () => {
  await call('POST', '/api/reset', {});
  const [a, b, c, d] = [await addPlayer('A'), await addPlayer('B'), await addPlayer('C'), await addPlayer('D')];
  const ok = await call('POST', '/api/games', { a: [a, b], b: [c, d], sa: 1275, sb: 984 });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.data.games[0].sa, ok.data.games[0].sb], [1280, 980]);

  const bad = (body) => call('POST', '/api/games', body).then(r => r.status);
  assert.equal(await bad({ a: [a, a], b: [c, d], sa: 0, sb: 0 }), 400);            // joueur en double
  assert.equal(await bad({ a: [a, b, c], b: [d], sa: 0, sb: 0 }), 400);            // équipes mal formées
  assert.equal(await bad({ a: [a, b], b: [c, 'ffffffffff'], sa: 0, sb: 0 }), 400); // joueur inconnu
  assert.equal(await bad({ a: [a, b], b: [c, d], sa: -10, sb: 0 }), 400);
  assert.equal(await bad({ a: [a, b], b: [c, d], sa: 1e300, sb: 0 }), 400);
  assert.equal(await bad({ a: [a, b], b: [c, d], sa: 'x', sb: 0 }), 400);
});

test('suppression : joueur avec parties protégé', async () => {
  await call('POST', '/api/reset', {});
  const [a, b, c, d] = [await addPlayer('A'), await addPlayer('B'), await addPlayer('C'), await addPlayer('D')];
  const { data } = await call('POST', '/api/games', { a: [a, b], b: [c, d], sa: 100, sb: 60 });
  assert.equal((await call('DELETE', `/api/players/${a}`)).status, 409);
  assert.equal((await call('DELETE', `/api/games/${data.games[0].id}`)).status, 200);
  assert.equal((await call('DELETE', `/api/players/${a}`)).data.players.length, 3);
});

test('protection CSRF : écriture sans JSON refusée', async () => {
  const r = await call('POST', '/api/reset', undefined, { 'Content-Type': 'text/plain' });
  assert.equal(r.status, 415);
  assert.equal((await call('POST', '/api/players', null)).status, 400);
});

test('fichiers statiques', async () => {
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/manifest.webmanifest')).headers.get('content-type'), 'application/manifest+json');
  assert.equal((await fetch(base + '/../server.js')).status, 404);
  assert.equal((await fetch(base + '/%2e%2e/server.js')).status, 404);
});
