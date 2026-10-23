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

test('clôture : événement en lecture seule, réouvrable', async () => {
  const api = await start();
  const [a, b, c, d] = await fourPlayers(api);
  const eventId = await api.addEvent('Tournoi');
  const pending = (await api.call('POST', '/api/games', { eventId, a: [a, b], b: [c, d] })).data.games[0];
  assert.equal((await api.call('PATCH', `/api/events/${eventId}`, { closed: true })).status, 409);   // match en cours
  await api.call('PATCH', `/api/games/${pending.id}`, { sa: 100, sb: 60 });
  const closed = await api.call('PATCH', `/api/events/${eventId}`, { closed: true });
  assert.ok(closed.data.events[0].closedAt);
  // Plus aucune modification
  assert.equal((await api.call('POST', '/api/games', { eventId, a: [a, b], b: [c, d], sa: 1, sb: 2 })).status, 409);
  assert.equal((await api.call('PUT', `/api/games/${pending.id}/score`, { sa: 1, sb: 2, from: [100, 60] })).status, 409);
  assert.equal((await api.call('DELETE', `/api/games/${pending.id}`)).status, 409);
  assert.equal((await api.call('POST', `/api/events/${eventId}/plan`, { players: [a, b, c, d], rounds: 1 })).status, 409);
  // Renommer reste possible ; rouvrir rend la main
  assert.equal((await api.call('PATCH', `/api/events/${eventId}`, { name: 'Tournoi 2026' })).status, 200);
  const reopened = await api.call('PATCH', `/api/events/${eventId}`, { closed: false });
  assert.equal(reopened.data.events[0].closedAt, null);
  assert.equal((await api.call('DELETE', `/api/games/${pending.id}`)).status, 200);
});

test('mode équipe : équipes fixes, matchs entre équipes, mode verrouillé', async () => {
  const api = await start();
  const [a, b, c, d] = await fourPlayers(api);
  const eventId = (await api.call('POST', '/api/events', { name: 'Équipes', mode: 'team' })).data.created;
  assert.equal((await api.call('POST', '/api/events', { name: 'X', mode: 'autre' })).status, 400);
  const addTeam = body => api.call('POST', `/api/events/${eventId}/teams`, body);
  assert.equal((await addTeam({ players: [a, b], name: 'Les As' })).status, 200);
  assert.equal((await addTeam({ players: [a, c] })).status, 409);                 // A déjà dans une équipe
  assert.equal((await addTeam({ players: [c, c] })).status, 400);
  const { data } = await addTeam({ players: [c, d] });
  const [t1, t2] = data.teams;
  assert.deepEqual([t1.name, t2.name], ['Les As', 'C & D']);                      // nom par défaut
  assert.deepEqual(t2.players, [c, d]);
  // Un match d'équipes reprend les joueurs des équipes
  const g = (await api.call('POST', '/api/games', { eventId, teamA: t1.id, teamB: t2.id, sa: 1000, sb: 800 })).data.games[0];
  assert.deepEqual([g.a, g.b, g.teamA, g.teamB], [[a, b], [c, d], t1.id, t2.id]);
  assert.equal((await api.call('POST', '/api/games', { eventId, teamA: t1.id, teamB: t1.id })).status, 400);
  // Équipe et joueurs protégés tant qu'il y a des parties
  assert.equal((await api.call('DELETE', `/api/teams/${t1.id}`)).status, 409);
  assert.equal((await api.call('DELETE', `/api/players/${a}`)).status, 409);
  assert.equal((await api.call('PATCH', `/api/teams/${t1.id}`, { name: 'Les Rois' })).data.teams[0].name, 'Les Rois');
  // Mode non modifiable une fois des parties jouées ; planification individuelle refusée
  assert.equal((await api.call('PATCH', `/api/events/${eventId}`, { mode: 'individual' })).status, 409);
  assert.equal((await api.call('POST', `/api/events/${eventId}/plan`, { players: [a, b, c, d], rounds: 1 })).status, 400);
});

test('tournoi : poules, qualifiés, phase finale automatique, règles', async () => {
  const api = await start();
  const names = Array.from({ length: 16 }, (_, i) => `J${String(i).padStart(2, '0')}`);
  const ids = [];
  for (const n of names) ids.push(await api.addPlayer(n));
  const eventId = (await api.call('POST', '/api/events', { name: 'Coupe', mode: 'team' })).data.created;
  for (let i = 0; i < 16; i += 2) await api.call('POST', `/api/events/${eventId}/teams`, { players: [ids[i], ids[i + 1]] });
  const launch = body => api.call('POST', `/api/events/${eventId}/tournament`, body);
  assert.equal((await launch({ groups: 3, koSize: 4 })).status, 400);             // 4 ne se répartit pas en 3 poules
  assert.equal((await launch({ groups: 2, koSize: 16 })).status, 400);            // pas assez d'équipes

  // 8 équipes, 2 poules de 4, demi-finales (2 qualifiées par poule)
  let { status, data } = await launch({ groups: 2, koSize: 4 });
  assert.equal(status, 200);
  const ev = data.events[0];
  assert.deepEqual([ev.groups, ev.koSize], [2, 4]);
  const group = data.games.filter(g => g.stage === 'group');
  assert.equal(group.length, 12);                                                 // 2 × (4 × 3 / 2)
  assert.deepEqual([...new Set(group.map(g => g.round))].sort(), [1, 2, 3]);
  assert.ok(data.teams.every(t => t.grp === 0 || t.grp === 1));
  assert.ok(group.every(g => data.teams.find(t => t.id === g.teamA).grp === g.grp && data.teams.find(t => t.id === g.teamB).grp === g.grp));
  assert.equal((await api.call('POST', `/api/events/${eventId}/teams`, { players: [ids[0], ids[2]] })).status, 409);
  assert.equal((await api.call('POST', '/api/games', { eventId, teamA: data.teams[0].id, teamB: data.teams[1].id })).status, 409);
  assert.equal((await api.call('DELETE', `/api/games/${group[0].id}`)).status, 409);
  assert.equal((await api.call('POST', `/api/events/${eventId}/tournament/final`)).status, 409); // poules pas finies

  // Scores de poule : l'équipe créée en premier gagne toujours (classement prévisible)
  const order = data.teams.map(t => t.id);
  for (const g of group) {
    const aFirst = order.indexOf(g.teamA) < order.indexOf(g.teamB);
    await api.call('PATCH', `/api/games/${g.id}`, aFirst ? { sa: 1000, sb: 500 } : { sa: 500, sb: 1000 });
  }
  ({ data } = await api.call('POST', `/api/events/${eventId}/tournament/final`));
  const semis = data.games.filter(g => g.stage === 'ko');
  assert.equal(semis.length, 2);
  assert.ok(semis.every(g => g.ko === 4 && g.sa === null));
  const qualified = semis.flatMap(g => [g.teamA, g.teamB]);
  for (const grp of [0, 1]) {
    const best = order.filter(id => data.teams.find(t => t.id === id).grp === grp).slice(0, 2);
    assert.deepEqual(qualified.filter(id => best.includes(id)).sort(), [...best].sort());
  }
  for (const g of semis) assert.notEqual(data.teams.find(t => t.id === g.teamA).grp, data.teams.find(t => t.id === g.teamB).grp);
  // Poules figées une fois la phase finale lancée
  const played = data.games.find(g => g.id === group[0].id);
  const frozen = await api.call('PUT', `/api/games/${played.id}/score`, { sa: 1, sb: 2, from: [played.sa, played.sb] });
  assert.equal(frozen.status, 409);
  assert.match(frozen.data.error, /poules sont figés/);

  // Pas d'égalité ; la finale se crée quand les deux demies sont jouées
  assert.equal((await api.call('PATCH', `/api/games/${semis[0].id}`, { sa: 800, sb: 800 })).status, 400);
  await api.call('PATCH', `/api/games/${semis[0].id}`, { sa: 900, sb: 700 });
  assert.equal((await api.call('GET', '/api/state')).data.games.filter(g => g.stage === 'ko').length, 2);
  ({ data } = await api.call('PATCH', `/api/games/${semis[1].id}`, { sa: 600, sb: 1000 }));
  const final = data.games.find(g => g.stage === 'ko' && g.ko === 2);
  assert.deepEqual([final.teamA, final.teamB], [semis[0].teamA, semis[1].teamB]);
  // Correction d'une demie : même vainqueur accepté, vainqueur changé refusé
  assert.equal((await api.call('PUT', `/api/games/${semis[0].id}/score`, { sa: 950, sb: 700, from: [900, 700] })).status, 200);
  assert.equal((await api.call('PUT', `/api/games/${semis[0].id}/score`, { sa: 100, sb: 700, from: [950, 700] })).status, 409);
  ({ data } = await api.call('PATCH', `/api/games/${final.id}`, { sa: 1200, sb: 300 }));
  assert.equal(data.games.filter(g => g.stage === 'ko').length, 3);                // pas de tour après la finale
  assert.equal((await api.call('PATCH', `/api/events/${eventId}`, { closed: true })).status, 200);

  // Réinitialisation (après réouverture) : matchs du tournoi et tirage effacés, équipes conservées
  await api.call('PATCH', `/api/events/${eventId}`, { closed: false });
  ({ data } = await api.call('DELETE', `/api/events/${eventId}/tournament`));
  assert.equal(data.games.length, 0);
  assert.equal(data.teams.length, 8);
  assert.ok(data.teams.every(t => t.grp === null));
  assert.equal(data.events[0].groups, null);
});

test('tournoi : poule impaire, équipes exemptées au repos', async () => {
  const api = await start();
  const ids = [];
  for (let i = 0; i < 10; i++) ids.push(await api.addPlayer(`P${i}`));
  const eventId = (await api.call('POST', '/api/events', { name: 'Coupe', mode: 'team' })).data.created;
  for (let i = 0; i < 10; i += 2) await api.call('POST', `/api/events/${eventId}/teams`, { players: [ids[i], ids[i + 1]] });
  const { data } = await api.call('POST', `/api/events/${eventId}/tournament`, { groups: 1, koSize: 2 });
  assert.equal(data.games.length, 10);                                             // 5 équipes : 10 rencontres
  assert.equal(new Set(data.games.map(g => g.round)).size, 5);                     // 5 tours, une équipe exemptée par tour
  assert.equal(data.rests.length, 10);                                             // 2 joueurs × 5 tours
});

test('réglages : validation, couleurs modifiables même clos, arrondi désactivable', async () => {
  const api = await start();
  const [a, b, c, d] = await fourPlayers(api);
  const eventId = await api.addEvent('Soirée');
  const set = settings => api.call('PATCH', `/api/events/${eventId}`, { settings });
  const ev0 = (await api.call('GET', '/api/state')).data.events[0];
  assert.deepEqual([ev0.entry, ev0.endType, ev0.endValue, ev0.count, ev0.rounding, ev0.theme], ['total', 'points', 1000, 'points', true, 'vert']);
  assert.equal((await set({ entry: 'autre' })).status, 400);
  assert.equal((await set({ endType: 'rounds', endValue: 0 })).status, 400);
  assert.equal((await set({ endType: 'points', endValue: 50 })).status, 400);
  assert.equal((await set({ theme: 'rose' })).status, 400);
  assert.equal((await set({ rounding: 'oui' })).status, 400);
  const ok = await set({ entry: 'deals', endType: 'rounds', endValue: 8, count: 'contract', rounding: false, theme: 'bleu' });
  const ev = ok.data.events[0];
  assert.deepEqual([ev.entry, ev.endType, ev.endValue, ev.count, ev.rounding, ev.theme], ['deals', 'rounds', 8, 'contract', false, 'bleu']);
  // Sans arrondi, un score total est gardé tel quel
  const g = (await api.call('POST', '/api/games', { eventId, a: [a, b], b: [c, d], sa: 1275, sb: 984 })).data.games[0];
  assert.deepEqual([g.sa, g.sb], [1275, 984]);
  await api.call('PATCH', `/api/events/${eventId}`, { closed: true });
  assert.equal((await set({ theme: 'violet' })).status, 200);                      // couleurs : oui
  assert.equal((await set({ endValue: 6 })).status, 409);                          // règles : non
});

test('donnes : partie en points, double saisie, fin automatique, annulation', async () => {
  const api = await start();
  const [a, b, c, d] = await fourPlayers(api);
  const eventId = await api.addEvent('Coinche');
  await api.call('PATCH', `/api/events/${eventId}`, { settings: { entry: 'deals', endType: 'points', endValue: 500 } });
  const g = (await api.call('POST', '/api/games', { eventId, a: [a, b], b: [c, d] })).data.games[0];
  const deal = body => api.call('POST', `/api/games/${g.id}/deals`, body);
  const game = data => data.games.find(x => x.id === g.id);

  assert.equal((await deal({ idx: 0, taker: 'a', contract: 95, points: 100 })).status, 400);  // contrat invalide
  let r = await deal({ idx: 0, taker: 'a', contract: 100, points: 107 });                    // A : 210, B : 50
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.deals.map(x => [x.idx, x.pa, x.pb, x.made]), [[0, 210, 50, true]]);
  // Un autre téléphone qui n'a pas vu la donne 0 est refusé
  assert.equal((await deal({ idx: 0, taker: 'b', contract: 80, points: 90 })).status, 409);
  r = await deal({ idx: 1, taker: 'b', contract: 120, coinche: 2, points: 90, belote: 'a' });  // B chute coinché : A 160+240+20
  assert.deepEqual(r.data.deals.at(-1).pa, 420);
  assert.equal(game(r.data).sa, 630);                                                      // 630 ≥ 500 : partie finie
  assert.deepEqual([game(r.data).sa, game(r.data).sb], [630, 50]);
  assert.equal((await deal({ idx: 2, taker: 'a', contract: 80, points: 90 })).status, 409);  // partie terminée
  // Annuler la dernière donne rouvre la partie
  r = await api.call('DELETE', `/api/games/${g.id}/deals/last`);
  assert.equal(game(r.data).sa, null);
  assert.equal(r.data.deals.length, 1);
});

test('donnes : partie en nombre de donnes, égalité prolongée en phase finale', async () => {
  const api = await start();
  const ids = [];
  for (let i = 0; i < 8; i++) ids.push(await api.addPlayer(`P${i}`));
  const eventId = (await api.call('POST', '/api/events', { name: 'Coupe', mode: 'team' })).data.created;
  await api.call('PATCH', `/api/events/${eventId}`, { settings: { entry: 'deals', endType: 'rounds', endValue: 2, count: 'contract' } });
  for (let i = 0; i < 8; i += 2) await api.call('POST', `/api/events/${eventId}/teams`, { players: [ids[i], ids[i + 1]] });
  let { data } = await api.call('POST', `/api/events/${eventId}/tournament`, { groups: 1, koSize: 2 });
  const play = async (gameId, deals) => {
    let res;
    for (const [i, d] of deals.entries()) res = await api.call('POST', `/api/games/${gameId}/deals`, { idx: i, ...d });
    return res.data;
  };
  // Poule : égalité admise après 2 donnes (A fait 100, puis B fait 100)
  const tie = [{ taker: 'a', contract: 100, made: true }, { taker: 'b', contract: 100, made: true }];
  for (const g of data.games.filter(x => x.stage === 'group')) {
    const order = data.teams.map(t => t.id);
    data = await play(g.id, order.indexOf(g.teamA) < order.indexOf(g.teamB) ? [...tie.slice(0, 1), { taker: 'a', contract: 80, made: true }] : tie);
  }
  assert.ok(data.games.filter(x => x.stage === 'group').every(x => x.sa !== null));
  assert.ok(data.games.some(x => x.stage === 'group' && x.sa === x.sb));            // une égalité en poule
  ({ data } = await api.call('POST', `/api/events/${eventId}/tournament/final`));
  const final = data.games.find(x => x.stage === 'ko');
  data = await play(final.id, tie);
  assert.equal(data.games.find(x => x.id === final.id).sa, null);                   // 100 – 100 : on continue
  ({ data } = await api.call('POST', `/api/games/${final.id}/deals`, { idx: 2, taker: 'a', contract: 80, made: true }));
  const done = data.games.find(x => x.id === final.id);
  assert.deepEqual([done.sa, done.sb], [180, 100]);
  // Les poules sont figées : impossible d'annuler une donne de poule
  const groupGame = data.games.find(x => x.stage === 'group');
  assert.equal((await api.call('DELETE', `/api/games/${groupGame.id}/deals/last`)).status, 409);
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
    b: ['cccccccccc', 'dddddddddd'], sa: 100, sb: 60, table: null, round: null, finishedAt: 7,
    teamA: null, teamB: null, stage: null, grp: null, ko: null, slot: null }]);
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
