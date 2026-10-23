# Score Belote

Score individuel d'un tournoi de belote (équipes différentes à chaque partie, scores arrondis à 10).
Les parties sont rangées par **événement** (un tournoi = un événement, avec son propre classement) ;
les joueurs sont communs à tous les événements. Une base existante sans événements est migrée
automatiquement au démarrage : ses parties rejoignent un événement « Tournoi ».

Plusieurs matchs peuvent se jouer en même temps : on forme les équipes à l'avance (scores vides),
chaque match reçoit un numéro de table, et le score total est saisi à la fin depuis n'importe quel
terminal. Un joueur ne peut pas être à deux tables, et un score ne peut être saisi qu'une fois.

Les tours peuvent être **planifiés automatiquement** (onglet Partie → « Planifier des tours ») :
on coche les joueurs présents et le nombre de tours, et `planner.js` répartit les tables en évitant
d'abord qu'un joueur rejoue avec un même partenaire (parties déjà jouées dans l'événement comprises),
puis de retrouver les mêmes adversaires. Si le nombre de joueurs n'est pas un multiple de 4, les
joueurs en trop se reposent à tour de rôle. Le tour suivant devient actif quand tous les scores du
tour en cours sont saisis.

À la création, un événement est **individuel** (partenaires différents à chaque partie, classement par
joueur) ou **en équipes fixes** (paires inscrites au départ, classement par équipe). En équipes, on peut
organiser un **tournoi** (`tournament.js`) : poules tirées au sort où chaque équipe rencontre toutes les
autres, puis phase finale à élimination directe (16es, 8es, quarts, demies ou finale) avec les N premiers
de chaque poule, croisés entre poules. Les tours de la phase finale s'enchaînent automatiquement ; pas
d'égalité possible en phase finale.

Un événement peut être **clos** : il passe en consultation seule (plus de saisie, correction ni
planification) et peut être rouvert.
Les données sont stockées dans SQLite côté serveur ; les terminaux se synchronisent toutes les 5 s.

## PWA
L'application s'installe sur l'écran d'accueil (Android : « Installer l'application » ; iOS : Partager → « Sur l'écran d'accueil »).
Hors connexion, elle affiche le dernier classement chargé (lecture seule). L'installation exige HTTPS, fourni par Traefik.

## Lancer
    npm start                 # Node >= 22.13, http://localhost:3000
    npm test                  # tests de l'API (node:test, base en mémoire)
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
