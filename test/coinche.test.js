const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../public/coinche');

const points = { count: 'points', rounding: true };
const exact = { count: 'points', rounding: false };
const bid = { count: 'contract', rounding: true };

test('enchère + points faits : contrat réussi, défense calculée automatiquement', () => {
  // A prend 100, fait 107 → arrondi 110 ; défense 50 (total 160)
  assert.deepEqual(C.scoreDeal({ taker: 'a', contract: 100, points: 107 }, points), { pa: 210, pb: 50, made: true });
  // Sans arrondi : 107 et 55 (total 162)
  assert.deepEqual(C.scoreDeal({ taker: 'a', contract: 100, points: 107 }, exact), { pa: 207, pb: 55, made: true });
  // Le preneur est B
  assert.deepEqual(C.scoreDeal({ taker: 'b', contract: 80, points: 92 }, points), { pa: 70, pb: 170, made: true });
});

test('chute : la défense marque 160 + contrat (× coinche)', () => {
  assert.deepEqual(C.scoreDeal({ taker: 'a', contract: 120, points: 100 }, points), { pa: 0, pb: 280, made: false });
  assert.deepEqual(C.scoreDeal({ taker: 'a', contract: 120, coinche: 2, points: 100 }, points), { pa: 0, pb: 400, made: false });
  assert.deepEqual(C.scoreDeal({ taker: 'a', contract: 120, points: 100 }, exact), { pa: 0, pb: 282, made: false });
});

test('belote : +20 à l’équipe qui l’annonce, et compte pour atteindre le contrat', () => {
  // A prend 100, fait 85 + belote 20 = 105 → réussi
  assert.deepEqual(C.scoreDeal({ taker: 'a', contract: 100, points: 85, belote: 'a' }, points), { pa: 210, pb: 70, made: true });
  // Belote à la défense : gardée même si le preneur chute
  assert.deepEqual(C.scoreDeal({ taker: 'a', contract: 100, points: 85, belote: 'b' }, points), { pa: 0, pb: 280, made: false });
});

test('enchère seule : le contrat (× coinche), rien pour la défense', () => {
  assert.deepEqual(C.scoreDeal({ taker: 'a', contract: 110, coinche: 2, made: true }, bid), { pa: 220, pb: 0, made: true });
  assert.deepEqual(C.scoreDeal({ taker: 'b', contract: 110, made: false, belote: 'b' }, bid), { pa: 270, pb: 20, made: false });
});

test('capot : déclaré fait ou chuté, même en décompte des points', () => {
  assert.deepEqual(C.scoreDeal({ taker: 'a', contract: 250, made: true }, points), { pa: 250, pb: 0, made: true });
  assert.deepEqual(C.scoreDeal({ taker: 'a', contract: 250, made: false }, points), { pa: 0, pb: 410, made: false });
});

test('vérification des donnes', () => {
  assert.equal(C.checkDeal({ taker: 'a', contract: 100, points: 90 }, points), null);
  assert.match(C.checkDeal({ taker: 'x', contract: 100, points: 90 }, points), /pris/);
  assert.match(C.checkDeal({ taker: 'a', contract: 95, points: 90 }, points), /Contrat/);
  assert.match(C.checkDeal({ taker: 'a', contract: 100, points: 170 }, points), /162/);
  assert.match(C.checkDeal({ taker: 'a', contract: 100 }, bid), /fait ou chuté/);
  assert.equal(C.checkDeal({ taker: 'a', contract: 250, made: true }, points), null);
});

test('fin de partie : en points ou en nombre de donnes, pas d’égalité en phase finale', () => {
  const pts = { type: 'points', value: 1000 };
  assert.equal(C.isOver(990, 400, 6, pts), false);
  assert.equal(C.isOver(1010, 400, 7, pts), true);
  assert.equal(C.isOver(1010, 1010, 9, pts), false);          // égalité au-delà de l'objectif : on continue
  const rounds = { type: 'rounds', value: 4 };
  assert.equal(C.isOver(500, 300, 3, rounds), false);
  assert.equal(C.isOver(500, 500, 4, rounds), true);           // égalité admise hors phase finale
  assert.equal(C.isOver(500, 500, 4, rounds, true), false);    // phase finale : donne supplémentaire
});
