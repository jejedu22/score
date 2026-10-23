const { test } = require('node:test');
const assert = require('node:assert/strict');
const t = require('../tournament');

test('configuration : qualifiés par poule et erreurs', () => {
  assert.equal(t.checkConfig(16, 4, 8), 2);
  assert.equal(t.checkConfig(9, 1, 4), 4);
  assert.throws(() => t.checkConfig(16, 3, 8), /ne se répartissent pas/);
  assert.throws(() => t.checkConfig(7, 4, 4), /au moins 2 par poule/);
  assert.throws(() => t.checkConfig(8, 2, 16), /au moins 16 équipes/);
  assert.throws(() => t.checkConfig(8, 2, 6), /Phase finale invalide/);
});

test('tirage : poules équilibrées, chaque équipe une fois', () => {
  const ids = Array.from({ length: 11 }, (_, i) => `t${i}`);
  const groups = t.drawGroups(ids, 3);
  assert.deepEqual(groups.map(g => g.length).sort(), [3, 4, 4]);
  assert.deepEqual(groups.flat().sort(), [...ids].sort());
});

test('chacun contre chacun : toutes les rencontres une fois, une seule par tour', () => {
  for (const n of [2, 3, 4, 5, 6]) {
    const ids = Array.from({ length: n }, (_, i) => `t${i}`);
    const rounds = t.roundRobin(ids);
    const seen = rounds.flatMap(r => r.pairs.map(p => [...p].sort().join()));
    assert.equal(seen.length, n * (n - 1) / 2);
    assert.equal(new Set(seen).size, seen.length);
    for (const r of rounds) {
      const inRound = [...r.pairs.flat(), ...(r.bye ? [r.bye] : [])];
      assert.equal(new Set(inRound).size, n);
    }
  }
});

test('classement de poule : victoires, points, écart', () => {
  const games = [
    { ta: 'A', tb: 'B', sa: 1000, sb: 600 }, { ta: 'C', tb: 'A', sa: 900, sb: 700 },
    { ta: 'B', tb: 'C', sa: 800, sb: 790 }, { ta: 'A', tb: 'C', sa: null, sb: null },
  ];
  // A, B, C : 1 victoire chacun ; points A 1700, C 1690, B 1400
  assert.deepEqual(t.standings(['A', 'B', 'C'], games).map(s => s.id), ['A', 'C', 'B']);
});

test('phase finale : croisement entre poules, têtes de série séparées', () => {
  const q = [['A1', 'A2'], ['B1', 'B2'], ['C1', 'C2'], ['D1', 'D2']];
  const round = t.firstKnockoutRound(q);
  assert.equal(round.length, 4);
  for (const [x, y] of round) assert.notEqual(x[0], y[0]);                   // jamais la même poule
  assert.deepEqual(round.flat().sort(), q.flat().sort());
  // Les deux meilleures têtes de série (A1, B1) sont dans des moitiés différentes du tableau
  const half = id => (round.findIndex(p => p.includes(id)) < 2 ? 0 : 1);
  assert.notEqual(half('A1'), half('B1'));
  assert.deepEqual(t.nextKnockoutRound(['w0', 'w1', 'w2', 'w3']), [['w0', 'w1'], ['w2', 'w3']]);
  assert.deepEqual(t.seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
});
