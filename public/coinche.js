// Règles de décompte de la belote coinchée, partagées par le navigateur (window.Coinche) et le serveur (require).
(function (root) {
  const CAPOT = 250;
  const CONTRACTS = [80, 90, 100, 110, 120, 130, 140, 150, 160, CAPOT];
  const COINCHES = [1, 2, 4];   // normal, coinché, surcoinché
  const BELOTE = 20;

  // Points faits par le preneur → [preneur, défense] ; arrondi : à la dizaine, sur un total de 160
  function split(points, rounding) {
    if (!rounding) return [points, 162 - points];
    const taker = Math.round(points / 10) * 10;
    return [taker, 160 - taker];
  }

  /**
   * Une donne. deal = { taker: 'a' | 'b', contract, coinche, belote: 'a' | 'b' | null,
   *   points (points de cartes faits par le preneur, 0 à 162 ; décompte « points faits »),
   *   made (contrat réussi ; décompte « enchère seule » et capot) }
   * settings = { count: 'contract' | 'points', rounding }
   * Renvoie { pa, pb, made } : points marqués par chaque équipe.
   */
  function scoreDeal(deal, settings) {
    const { taker, contract, coinche = 1, belote = null } = deal;
    const defense = taker === 'a' ? 'b' : 'a';
    const withPoints = settings.count === 'points' && contract !== CAPOT;
    const bonus = side => (belote === side ? BELOTE : 0);
    // Contrat réussi : le preneur atteint son contrat, belote comprise (le capot se déclare fait ou chuté)
    const made = withPoints ? deal.points + bonus(taker) >= contract : !!deal.made;
    const score = { a: 0, b: 0 };
    if (made) {
      score[taker] = contract * coinche;
      if (withPoints) {
        const [t, d] = split(deal.points, settings.rounding);
        score[taker] += t;
        score[defense] += d;
      }
    } else {
      score[defense] = (settings.rounding ? 160 : 162) + contract * coinche;
    }
    return { pa: score.a + bonus('a'), pb: score.b + bonus('b'), made };
  }

  // Vérifie une donne saisie ; renvoie un message d'erreur ou null
  function checkDeal(deal, settings) {
    if (deal.taker !== 'a' && deal.taker !== 'b') return 'Choisissez l\'équipe qui a pris.';
    if (!CONTRACTS.includes(deal.contract)) return 'Contrat invalide.';
    if (!COINCHES.includes(deal.coinche ?? 1)) return 'Coinche invalide.';
    if (![null, 'a', 'b'].includes(deal.belote ?? null)) return 'Belote invalide.';
    if (settings.count === 'points' && deal.contract !== CAPOT) {
      if (!Number.isInteger(deal.points) || deal.points < 0 || deal.points > 162)
        return 'Points faits par le preneur : entre 0 et 162.';
    } else if (typeof deal.made !== 'boolean') return 'Indiquez si le contrat est fait ou chuté.';
    return null;
  }

  /**
   * La partie est-elle finie ? end = { type: 'rounds' | 'points', value } ;
   * en phase finale (noDraw), une égalité prolonge la partie d'une donne.
   */
  function isOver(sa, sb, deals, end, noDraw) {
    if (end.type === 'rounds') return deals >= end.value && !(noDraw && sa === sb);
    return Math.max(sa, sb) >= end.value && sa !== sb;
  }

  const api = { CAPOT, CONTRACTS, COINCHES, BELOTE, scoreDeal, checkDeal, isOver, split };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Coinche = api;
})(typeof window === 'undefined' ? globalThis : window);
