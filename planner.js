// Planification des tables : répartit les joueurs en tables de 4 (2 contre 2) sur plusieurs tours,
// en évitant d'abord de refaire jouer deux joueurs ensemble, puis de retrouver les mêmes adversaires.
// Recherche locale aléatoire : pas d'optimum garanti, mais très bon en pratique pour un tournoi.

const PARTNER_WEIGHT = 1000;   // un partenaire répété coûte bien plus qu'un adversaire répété
const ATTEMPTS = 30;           // plannings complets générés, on garde le meilleur
const RESTARTS = 12;           // départs aléatoires par tour
const ITERATIONS = 400;        // échanges essayés par départ

const pairKey = (x, y) => (x < y ? `${x}|${y}` : `${y}|${x}`);

class Counter extends Map {
  get(k) { return super.get(k) ?? 0; }
  add(k, n = 1) { this.set(k, this.get(k) + n); }
  clone() { return new Counter(this); }
}

// history : parties déjà jouées ou prévues ([a1, a2, b1, b2]) et repos passés (ids)
function countHistory(games, rests) {
  const partner = new Counter(), opponent = new Counter(), rest = new Counter();
  for (const g of games) addTable(g, partner, opponent);
  for (const id of rests) rest.add(id);
  return { partner, opponent, rest };
}

function addTable([a1, a2, b1, b2], partner, opponent) {
  partner.add(pairKey(a1, a2));
  partner.add(pairKey(b1, b2));
  for (const x of [a1, a2]) for (const y of [b1, b2]) opponent.add(pairKey(x, y));
}

function tableCost([a1, a2, b1, b2], { partner, opponent }) {
  let cost = PARTNER_WEIGHT * (partner.get(pairKey(a1, a2)) + partner.get(pairKey(b1, b2)));
  for (const x of [a1, a2]) for (const y of [b1, b2]) cost += opponent.get(pairKey(x, y));
  return cost;
}

function shuffle(list, rng) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Meilleure répartition d'un tour : positions 4t..4t+3 = table t (équipe A : 0-1, équipe B : 2-3)
function bestRound(players, hist, rng) {
  const tables = players.length / 4;
  const costOf = arr => {
    let c = 0;
    for (let t = 0; t < tables; t++) c += tableCost(arr.slice(4 * t, 4 * t + 4), hist);
    return c;
  };
  let best = null, bestCost = Infinity;
  for (let r = 0; r < RESTARTS && bestCost > 0; r++) {
    const cur = shuffle(players, rng);
    const tableCosts = Array.from({ length: tables }, (_, t) => tableCost(cur.slice(4 * t, 4 * t + 4), hist));
    let cost = tableCosts.reduce((s, c) => s + c, 0);
    for (let it = 0; it < ITERATIONS && cost > 0; it++) {
      const i = Math.floor(rng() * cur.length), j = Math.floor(rng() * cur.length);
      const ti = i >> 2, tj = j >> 2;
      if (i === j) continue;
      [cur[i], cur[j]] = [cur[j], cur[i]];
      const ci = tableCost(cur.slice(4 * ti, 4 * ti + 4), hist);
      const cj = ti === tj ? 0 : tableCost(cur.slice(4 * tj, 4 * tj + 4), hist);
      const next = cost - tableCosts[ti] - (ti === tj ? 0 : tableCosts[tj]) + ci + cj;
      if (next <= cost) {   // on accepte aussi les échanges neutres pour sortir des plateaux
        cost = next; tableCosts[ti] = ci; if (ti !== tj) tableCosts[tj] = cj;
      } else {
        [cur[i], cur[j]] = [cur[j], cur[i]];
      }
    }
    if (cost < bestCost) { best = [...cur]; bestCost = cost; }
  }
  return { order: best, cost: costOf(best) };
}

// Ceux qui se sont le moins reposés se reposent (au hasard entre ex aequo)
function pickRest(players, count, rest, rng) {
  return shuffle(players, rng).sort((x, y) => rest.get(x) - rest.get(y)).slice(0, count);
}

/**
 * players : ids des joueurs présents (≥ 4) ; rounds : nombre de tours ;
 * past : { games: [[a1, a2, b1, b2], …], rests: [id, …] } déjà joués ou prévus dans l'événement.
 * Retourne { rounds: [{ tables: [[a1, a2, b1, b2], …], rest: [ids] }], partnerRepeats, opponentRepeats }.
 */
function plan(players, rounds, past = { games: [], rests: [] }, rng = Math.random) {
  const restCount = players.length % 4;
  let best = null;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const hist = countHistory(past.games, past.rests);
    const out = [];
    let partnerRepeats = 0, opponentRepeats = 0;
    for (let r = 0; r < rounds; r++) {
      const rest = pickRest(players, restCount, hist.rest, rng);
      const { order } = bestRound(players.filter(p => !rest.includes(p)), hist, rng);
      const tables = [];
      for (let t = 0; t < order.length; t += 4) {
        const table = order.slice(t, t + 4);
        const [a1, a2, b1, b2] = table;
        partnerRepeats += (hist.partner.get(pairKey(a1, a2)) > 0) + (hist.partner.get(pairKey(b1, b2)) > 0);
        for (const x of [a1, a2]) for (const y of [b1, b2]) opponentRepeats += hist.opponent.get(pairKey(x, y)) > 0;
        addTable(table, hist.partner, hist.opponent);
        tables.push(table);
      }
      for (const id of rest) hist.rest.add(id);
      out.push({ tables, rest });
    }
    const score = PARTNER_WEIGHT * partnerRepeats + opponentRepeats;
    if (!best || score < best.score) best = { score, rounds: out, partnerRepeats, opponentRepeats };
    if (score === 0) break;
  }
  const { score, ...result } = best;
  return result;
}

module.exports = { plan, pairKey };
