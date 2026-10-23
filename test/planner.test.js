const { test } = require('node:test');
const assert = require('node:assert/strict');
const { plan, pairKey } = require('../planner');

const players = n => Array.from({ length: n }, (_, i) => `p${i}`);
const partners = rounds => rounds.flatMap(r => r.tables.flatMap(([a1, a2, b1, b2]) => [pairKey(a1, a2), pairKey(b1, b2)]));

test('chaque joueur apparaît une fois par tour, tables de 4', () => {
  for (const n of [4, 5, 7, 8, 10, 13]) {
    const { rounds } = plan(players(n), 3);
    assert.equal(rounds.length, 3);
    for (const r of rounds) {
      const seen = [...r.tables.flat(), ...r.rest];
      assert.equal(seen.length, n);
      assert.equal(new Set(seen).size, n);
      assert.equal(r.rest.length, n % 4);
      assert.ok(r.tables.every(t => t.length === 4));
    }
  }
});

test('aucun partenaire répété quand c’est possible, y compris un tournoi complet', () => {
  for (const [n, r] of [[8, 7], [12, 5], [10, 4], [16, 6]]) {
    const res = plan(players(n), r);
    assert.equal(res.partnerRepeats, 0, `${n} joueurs × ${r} tours`);
    const keys = partners(res.rounds);
    assert.equal(new Set(keys).size, keys.length);
  }
});

test('répétitions inévitables réduites au minimum', () => {
  // 8 joueurs, 10 tours : 10 partenaires pour 7 possibles → au moins 3 répétitions par joueur = 12 paires
  assert.equal(plan(players(8), 10).partnerRepeats, 12);
});

test('les parties passées sont prises en compte', () => {
  const first = plan(players(8), 3);
  const past = { games: first.rounds.flatMap(r => r.tables), rests: [] };
  const next = plan(players(8), 4, past);
  assert.equal(next.partnerRepeats, 0);
  const before = new Set(partners(first.rounds));
  assert.ok(partners(next.rounds).every(k => !before.has(k)));
});

test('repos répartis équitablement, en tenant compte des repos passés', () => {
  const rest = {};
  for (const r of plan(players(10), 5).rounds) for (const id of r.rest) rest[id] = (rest[id] ?? 0) + 1;
  assert.deepEqual(Object.values(rest), Array(10).fill(1));
  // p0 et p1 se sont déjà reposés : ils jouent le tour suivant
  const { rounds } = plan(players(6), 1, { games: [], rests: ['p0', 'p1'] });
  assert.ok(!rounds[0].rest.includes('p0') && !rounds[0].rest.includes('p1'));
});
