# Score Belote

Score individuel d'un tournoi de belote (équipes différentes à chaque partie, scores arrondis à 10).
Les données sont stockées dans SQLite côté serveur ; les terminaux se synchronisent toutes les 5 s.

## Lancer
    node server.js            # Node >= 22.13, http://localhost:3000
    docker compose up -d      # voir docker-compose.yml (labels Traefik)

Variables : `PORT` (3000), `DB_PATH` (`./data/belote.db`, `/data/belote.db` dans l'image).

## Configuration (.env)
    cp .env.example .env      # puis adapter les valeurs
    docker compose up -d --build

`.env` contient le domaine, le nom du routeur, le réseau, l'entrypoint et le resolver Traefik,
ainsi que les identifiants d'authentification basique (optionnelle). Il n'est pas versionné.

## Traefik
L'application utilise des URLs relatives et fonctionne aussi sous un préfixe (`PathPrefix` + `StripPrefix`).
Pas d'authentification intégrée : renseigner `BASIC_AUTH_USERS` dans `.env` et décommenter les deux lignes du middleware dans `docker-compose.yml`.
