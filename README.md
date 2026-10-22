# Score Belote

Score individuel d'un tournoi de belote (équipes différentes à chaque partie, scores arrondis à 10).
Les données sont stockées dans SQLite côté serveur ; les terminaux se synchronisent toutes les 5 s.

## Lancer
    node server.js            # Node >= 22.13, http://localhost:3000
    docker compose up -d      # voir docker-compose.yml (labels Traefik)

Variables : `PORT` (3000), `DB_PATH` (`./data/belote.db`, `/data/belote.db` dans l'image).

## Traefik
Adapter dans `docker-compose.yml` : le `Host(...)`, le `certresolver`, le nom du réseau externe.
L'application utilise des URLs relatives et fonctionne aussi sous un préfixe (`PathPrefix` + `StripPrefix`).
Pas d'authentification intégrée : ajouter un middleware Traefik (basicauth) si besoin.
