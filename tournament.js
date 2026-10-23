// Tournoi par équipes : poules (chacun contre chacun) puis phase finale à élimination directe.
// Fonctions pures : le serveur s'occupe de la base, ce module des règles.

const KO_SIZES = [2, 4, 8, 16, 32];   // nombre d'équipes au premier tour de la phase finale
const KO_NAMES = { 32: '16e de finale', 16: '8e de finale', 8: 'Quart de finale', 4: 'Demi-finale', 2: 'Finale' };
const MAX_GROUPS = 16;

// Vérifie la configuration ; renvoie le nombre de qualifiés par poule, ou lève un message d'erreur
function checkConfig(teamCount, groups, koSize) {
  if (!Number.isInteger(groups) || groups < 1 || groups > MAX_GROUPS) throw new Error(`Nombre de poules invalide (1 à ${MAX_GROUPS})`);
  if (!KO_SIZES.includes(koSize)) throw new Error('Phase finale invalide');
  if (koSize % groups) throw new Error(`${koSize} équipes en phase finale ne se répartissent pas entre ${groups} poules`);
  const perGroup = koSize / groups;
  const smallest = Math.floor(teamCount / groups);
  if (smallest < 2) throw new Error(`Pas assez d'équipes : il en faut au moins 2 par poule (${2 * groups})`);
  if (smallest < perGroup)
    throw new Error(`Pas assez d'équipes : ${perGroup} qualifiées par poule demandent au moins ${perGroup * groups} équipes`);
  return perGroup;
}

function shuffle(list, rng) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Tirage au sort : poules de tailles égales à une équipe près
function drawGroups(teamIds, groups, rng = Math.random) {
  const out = Array.from({ length: groups }, () => []);
  shuffle(teamIds, rng).forEach((id, i) => out[i % groups].push(id));
  return out;
}

// Chacun contre chacun (méthode du cercle) : liste de tours, chaque tour = paires + équipe exemptée éventuelle
function roundRobin(teamIds) {
  const list = teamIds.length % 2 ? [...teamIds, null] : [...teamIds];
  const n = list.length, rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    let bye = null;
    for (let i = 0; i < n / 2; i++) {
      const [x, y] = [list[i], list[n - 1 - i]];
      if (x === null || y === null) bye = x ?? y;
      else pairs.push(r % 2 ? [y, x] : [x, y]);
    }
    rounds.push({ pairs, bye });
    list.splice(1, 0, list.pop());   // rotation, la première équipe reste fixe
  }
  return rounds;
}

// Classement d'une poule : victoires, puis points marqués, puis écart de points
function standings(teamIds, games) {
  const s = new Map(teamIds.map(id => [id, { id, played: 0, wins: 0, pts: 0, diff: 0 }]));
  for (const { ta, tb, sa, sb } of games) {
    if (sa === null || !s.has(ta) || !s.has(tb)) continue;
    for (const [t, mine, theirs] of [[ta, sa, sb], [tb, sb, sa]]) {
      const row = s.get(t);
      row.played++; row.pts += mine; row.diff += mine - theirs;
      if (mine > theirs) row.wins++;
    }
  }
  return [...s.values()].sort((x, y) => y.wins - x.wins || y.pts - x.pts || y.diff - x.diff);
}

// Ordre des têtes de série dans le tableau : 1 et 2 ne peuvent se rencontrer qu'en finale
function seedOrder(size) {
  let order = [1, 2];
  while (order.length < size) order = order.flatMap(s => [s, 2 * order.length + 1 - s]);
  return order;
}

/**
 * Premier tour de la phase finale. qualified[g] = équipes qualifiées de la poule g, dans l'ordre du classement.
 * Têtes de série : tous les 1ers, puis tous les 2es… ; la meilleure affronte la moins bonne, en évitant
 * autant que possible deux équipes de la même poule. Renvoie les matchs [[équipe, équipe], …] dans l'ordre du tableau.
 */
function firstKnockoutRound(qualified) {
  const seeds = [];
  const perGroup = qualified[0].length;
  for (let r = 0; r < perGroup; r++) qualified.forEach((teams, g) => seeds.push({ id: teams[r], g }));
  const size = seeds.length;
  const pairs = Array.from({ length: size / 2 }, (_, i) => [seeds[i], seeds[size - 1 - i]]);
  // Échange des adversaires pour séparer les équipes d'une même poule
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i][0].g !== pairs[i][1].g) continue;
    for (let j = 0; j < pairs.length; j++) {
      if (j === i) continue;
      if (pairs[i][0].g !== pairs[j][1].g && pairs[j][0].g !== pairs[i][1].g) {
        [pairs[i][1], pairs[j][1]] = [pairs[j][1], pairs[i][1]];
        break;
      }
    }
  }
  return seedOrder(size).filter(s => s <= size / 2).map(s => pairs[s - 1].map(x => x.id));
}

// Tour suivant : vainqueurs des matchs 2j et 2j+1 (matchs triés par position dans le tableau)
function nextKnockoutRound(winners) {
  const out = [];
  for (let i = 0; i < winners.length; i += 2) out.push([winners[i], winners[i + 1]]);
  return out;
}

module.exports = { KO_SIZES, KO_NAMES, checkConfig, drawGroups, roundRobin, standings, seedOrder,
  firstKnockoutRound, nextKnockoutRound };
