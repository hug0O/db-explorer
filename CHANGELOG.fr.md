# Changelog

## 0.36.0

- **Nouvelle requête (Ctrl+Alt+N)** demande la connexion cible : **la dernière utilisée est en premier** (Entrée la valide), puis les autres par ancienneté d'usage, puis « Nouvelle connexion… ». La connexion est ouverte si besoin. Avec une seule connexion enregistrée, aucune question.
- **Changer de connexion à tout moment** depuis un éditeur SQL : **bouton prise** dans la barre de titre de l'éditeur, `Ctrl+Alt+K`, ou la barre d'état. La liste est aussi classée par usage récent et ouvre la connexion si elle est fermée.
- **Schema Browser plus rapide** : l'arbre ne relit plus tout à chaque événement (chaque instruction, commit ou changement de connexion actualisait tout l'arbre et relistait chaque catégorie dépliée). Les listes (schémas, objets, colonnes) sont lues une fois et réutilisées jusqu'à **Actualiser**, la fermeture de la connexion, ou l'exécution d'une modification de structure (CREATE / ALTER / DROP…) sur celle-ci.
- **Plus de scan complet à la connexion** : le cache de métadonnées de l'aide à la saisie est lu sur disque ; le scan ne démarre que quand l'aide à la saisie est réellement utilisée ou après une modification de structure (ancien comportement via `dbexplorer.scanOnConnect`). Le re-scan périodique passe de 30 minutes à 6 heures.
- **Describe Object › Script** montre maintenant **chaque élément séparément**, dans son propre bloc avec *Copier* et *Ouvrir dans un éditeur* : création de la table, chaque index, chaque clé étrangère, contraintes, commentaires, triggers, synonymes, droits (vues aussi). Oracle utilise le DDL dépendant de `DBMS_METADATA` (les index de contraintes ne sont pas répétés) ; PostgreSQL et MySQL : clés étrangères et index générés comme instructions séparées (SQLite garde ses clés étrangères dans le CREATE TABLE).
- Testé sur de vraies bases PostgreSQL 17, MySQL 8 et SQLite (blocs du script) ; le chemin Oracle (`GET_DEPENDENT_DDL`) est écrit d'après la documentation et non testé sur un serveur.

## 0.35.1

- **Boutons Commit / Rollback corrigés** : ils agissaient toujours sur la connexion *active*, pas sur celle de l'éditeur SQL dans lequel vous travailliez ; avec plusieurs connexions, les modifications restaient donc non validées. Ils visent maintenant la connexion de l'éditeur, ou la seule connexion ayant des modifications en attente (les boutons du panneau de résultats n'ont pas d'éditeur), ou demandent laquelle quand plusieurs sont en attente. Déconnecter une connexion avec des modifications valide / annule cette connexion précisément.
- Retour clair : bandeau vert et message dans la barre d'état (« Commit effectué sur X »), et une erreur visible (bandeau, journal et message) si le commit / rollback échoue (connexion perdue…) au lieu d'échouer en silence ; refusé tant qu'une instruction s'exécute encore sur cette connexion.

## 0.35.0

- **Historique** : rouvrir une requête (Ouvrir, Exécuter, ou le sélecteur Ctrl+H) se reconnecte maintenant à la base sur laquelle elle a été exécutée si cette connexion est fermée, et y rattache le nouvel éditeur. **Exécuter** ne lance plus la requête sur une autre base si la connexion d'origine ne peut pas s'ouvrir. Quand vous insérez une requête dans un éditeur qui utilise une autre connexion, on vous propose de le basculer sur la connexion d'origine. Si la connexion d'origine a été supprimée, la connexion active est utilisée (avec un avertissement).

## 0.34.0

- **Describe Object › Data** : un bouton **Charger toutes les lignes** charge toute la table (dans la limite de `dbexplorer.showAllMaxRows`, 100 000 par défaut) ; l'en-tête affiche « (N premières) » tant qu'il reste des lignes. Fonctionne aussi sur les liens suivis.
- **Erreurs et avertissements bien visibles dans l'éditeur SQL** : la ligne est teintée et le message apparaît grisé (rouge pour les erreurs, orange pour les avertissements) en fin de ligne, avec le texte complet au survol ; soulignement et onglet Problèmes comme avant (`dbexplorer.inlineErrors`). Le texte est placé en fin de ligne et non sur une ligne à part (VS Code ne permet pas aux extensions d'insérer des lignes).
- **Contrôles instantanés pendant la frappe** (sans base de données, `dbexplorer.liveChecks`) : parenthèses non équilibrées (erreur), UPDATE / DELETE sans WHERE (avertissement). Une erreur d'exécution disparaît dès qu'on modifie sa ligne.
- **Délai d'exécution par défaut : 10 minutes** (`dbexplorer.queryTimeoutSeconds` = 600 ; 0 = illimité). Les valeurs déjà définies sont conservées.
- **L'annulation arrête vraiment l'instruction** : en plus de demander l'annulation à la base, si elle ne s'est pas arrêtée après 4 secondes l'interface est libérée et la connexion est réinitialisée puis rouverte (les modifications non validées de cette session sont annulées). Vaut pour Annuler et pour le délai. SQLite reste non interruptible.

## 0.33.0

- **Types Oracle dans l'aide à la saisie PL/SQL** : là où un type est attendu — déclaration de variable (`v_x |`, `CONSTANT`), paramètres de procédure / fonction (`a IN OUT |`), `RETURN |`, `TABLE OF |`, champs de `RECORD`, `SUBTYPE … IS`, `CAST(… AS |`, spécification de package — la liste propose les types Oracle (NUMBER, VARCHAR2(n), DATE, TIMESTAMP, CLOB, BOOLEAN, PLS_INTEGER, SYS_REFCURSOR…, avec les tailles à saisir), puis les types déclarés dans le bloc, `var%TYPE`, `curseur%ROWTYPE`, les types du schéma (CREATE TYPE), `TABLE%ROWTYPE` et, après `table.`, `colonne%TYPE`. Après `TYPE x IS` : TABLE OF, VARRAY, RECORD, REF CURSOR. Rien n'est proposé dans la partie exécutable (BEGIN … END) pour ne pas gêner.
- Testé avec des documents simulés ; non essayé sur un vrai serveur Oracle (`ALL_TYPES`).

## 0.32.0

- Le **Ctrl+clic** fonctionne aussi sur les **packages, procédures et fonctions** (`pkg.proc`, `proc(`, `EXEC proc`) : il ouvre leur description (Oracle, PostgreSQL, MySQL).
- **Aide à la saisie** : elle trouve les packages, procédures et fonctions du schéma (dès la première lettre) et, dans un appel `pkg.proc( … )`, propose les **paramètres sous forme de binds `:nom_du_param`** — le paramètre courant en premier (surcharges gérées), plus « (tous les paramètres) » et « (tous les paramètres, notation nommée) » (`p_id => :p_id, …`). Taper d'abord `:` fonctionne aussi.
- Testé sur de vraies bases PostgreSQL 17 et MySQL 8 (liste des routines et paramètres) ; Oracle (`ALL_ARGUMENTS`) non testé sur un serveur.

## 0.31.0

- **Ctrl+clic sur un nom de table / vue** dans un éditeur SQL (après FROM, JOIN, UPDATE, INTO…) ouvre **Describe Object** (colonnes, index, contraintes, référentiel, données). Les synonymes sont résolus.

## 0.30.2

- Barre latérale revenue à la disposition de la 0.29 (mes changements des 0.30.0 / 0.30.1 sur ce point sont annulés) : la ligne « Connexion » (onglets Schema Browser | Connexion) et la ligne de recherche réapparaissent, l'icône de filtre revient dans la barre de titre, et les vues Outils / Réglages et Aide sont de nouveau visibles. Le réglage `dbexplorer.alwaysShowToolsAndHelp` est supprimé.

## 0.30.1

- Barre latérale vraiment simplifiée : la ligne « Connexion » et la ligne de recherche ne restent plus en permanence au-dessus des connexions (la recherche n'apparaît qu'une fois une connexion ouverte), la barre de titre garde trois icônes (nouvelle connexion, nouvelle requête, actualiser) et le filtre passe dans le menu « … ». Sans connexion, seul le message de bienvenue s'affiche.

## 0.30.0

### Plus simple
- Les vues **Outils / Réglages** et **Aide** de la barre latérale sont masquées par défaut (ouvertes depuis la palette d'actions, ou via `dbexplorer.alwaysShowToolsAndHelp`) ; la barre garde Schema Browser / Connexion et Historique / Favoris.
- Réglages regroupés par thème (Exécution, Sécurité et production, Résultats et export, Éditeur et navigateur, Client Oracle).
- **Aller à un objet…** (Ctrl+Alt+G) : retrouver une table, vue, package… par son nom ; Entrée l'ouvre, ⓘ le décrit.
- Connexions : étiquette d'**environnement** (DEV / TEST / PROD, PROD active les protections de production et propose la lecture seule), **épinglage** d'une connexion en haut des listes.
- Chaque éditeur SQL garde son dernier résultat : changer d'éditeur affiche son résultat.
- Le mode lecture seule bloque aussi les modifications en grille, la recompilation et la suppression depuis l'arbre.
- Moins de popups : les messages de succès (recompilé, supprimé, modèle enregistré…) s'affichent brièvement dans la barre d'état.
- Un échec du test de connexion s'accompagne d'une explication (💡) pour les erreurs Oracle/PostgreSQL/MySQL courantes.
- Grille : Ctrl+F active la recherche, Échap ferme le volet détail / le menu / la recherche ; libellés d'accessibilité sur les boutons à icône.
- Commande **Copier les informations de diagnostic** (versions, connexions, dernière erreur) pour le support.

### Fiabilité
- Tests d'intégration sur de vraies bases (`npm run test:integration` : SQLite toujours, PostgreSQL et MySQL avec `test/docker-compose.yml`) : requêtes, pagination, commit / rollback, erreurs, plan et **annulation de requête**.
- Corrigé : détection de la clé primaire des colonnes sur **PostgreSQL 17** (erreur `smallint = smallint[]`) — elle cassait les indicateurs PK, l'édition en grille et le détecteur de doublons.

## 0.29.0

### Plus simple à utiliser
- Arbre : seules les actions courantes (Ouvrir le DDL, Select, Describe, Exécuter) restent en haut du menu d'un objet ; graphe d'appels, diagramme ER, utilisation, doublons, recompilation et suppression passent dans un sous-menu **Plus…**.
- Éditeur SQL : seuls exécuter / script / commit-rollback / annuler / plan restent en icônes dans la barre de titre (le reste est dans le menu **…**) ; le menu contextuel garde l'exécution et un sous-menu **DB Explorer : plus**.
- Premier usage : message de bienvenue avec les étapes ; une nouvelle requête sans connexion liste les connexions enregistrées (connectées d'abord) avec **Nouvelle connexion…** en dernier.
- Une bannière d'état sous les onglets résume la dernière exécution (✓ lignes et durée, ✗ première erreur — clic pour y aller) au lieu de popups supplémentaires.
- **Mode lecture seule** par connexion (case dans le formulaire, bascule dans la barre d'état, palette) : seules les requêtes s'exécutent ; le reste est bloqué avec un message clair.
- Déconnecter une connexion avec des modifications non validées propose d'abord **Commit / Rollback**.
- `npm test` : tests automatiques rapides (découpage de script, conseils d'erreur, conversion JOIN ANSI).

## 0.28.0

- Vue Connexion : les sections « Connexions enregistrées » et « Nouvelle connexion » sont repliables (état mémorisé ; modifier une connexion rouvre le formulaire).
- Grille de résultats : nouveau bouton **Tout afficher** à côté de « Lignes suivantes » (charge toutes les lignes restantes, annulable, plafonné par `dbexplorer.showAllMaxRows`).
- Barre d'outils des résultats refondue : boutons groupés (recherche / filtre-colonnes / pagination / export-copie), boutons de pagination mis en avant, actions rares (Modifier, Doublons) dans un menu « ⋯ », et seuls les boutons utiles affichés selon l'onglet.

## 0.27.0

### Erreurs
- Erreurs soulignées dans l'éditeur (et dans l'onglet Problèmes, F8 pour passer à la suivante), même sans position donnée par la base.
- Explication courte de l'erreur (💡) pour les erreurs ORA-/PLS-/PostgreSQL/MySQL/SQLite fréquentes, et « Vouliez-vous dire … ? » avec correction en un clic (colonne / table inconnue).
- Script : tableau récapitulatif (ligne, durée, lignes, statut), total « N réussies, M en erreur », bouton « Première erreur » ; réglage `dbexplorer.onScriptError` (demander / continuer / arrêter).
- Connexion perdue : « Se reconnecter et relancer ».

### Résultats
- Les 6 derniers résultats restent en puces ; comparaison de deux résultats (lignes en plus / en moins).
- Colonnes épinglables (clic droit sur l'en-tête), volet détail pour les longs textes avec JSON / XML mis en forme.
- Plan d'exécution : lectures complètes de table en évidence, barres de coût.

### Ergonomie
- Badge de connexion en fin de première ligne des éditeurs SQL (fond rouge en production) et confirmation avant un script qui modifie une base de production.
- Palette « DB Explorer : Actions… » (Ctrl+Alt+J), modèles de requêtes (intégrés + les vôtres), historique filtrable par connexion / erreurs.

## 0.26.0

- Nouvelle requête : si plusieurs connexions sont ouvertes, choix de la connexion.
- Suppression d'un package / fonction / procédure / trigger depuis l'arbre (menu « Supprimer… ») avec confirmation.

## 0.25.0
### Corrigé
- **Compilation de package** : une spécification de package suivie directement de son corps (`END nom;` puis `CREATE OR REPLACE PACKAGE BODY …`, sans `/` entre les deux) était envoyée à Oracle comme une seule instruction, d'où `PLS-00103: Encountered the symbol "CREATE"`. Un `CREATE …` d'unité PL/SQL en début de ligne après un `;` ouvre maintenant une nouvelle instruction. Les noms d'objets entre guillemets (`"MonPkg"`) gardent leur casse pour lire les erreurs de compilation.
### Ajouts
- **Onglet Erreurs** séparé de **Script / Messages** (avec un compteur ; il s'affiche automatiquement quand la dernière entrée est une erreur) et un bouton **Effacer** sur chacun des onglets Messages / Erreurs / Output (`dbexplorer.clearLogOnRun` pour effacer à chaque exécution).
- **Position dans le script** : chaque instruction journalise `▶ fichier.sql:LIGNE` (aussi dans sa ligne d'erreur), une ligne de séparation ouvre chaque exécution (heure, script, nombre d'instructions) pour que plusieurs scripts lancés d'affilée restent lisibles, et les lignes sont **cliquables** pour aller à cette ligne du script (erreurs de compilation comprises).

## 0.24.1
### Ajouts
- **Détecteur de doublons d'une requête** (action de code, menu de l'éditeur, Tools, ou *Trouver la cause…* dans le panneau Doublons de la grille) : la **clé de chaque table** du FROM / JOIN (clé primaire, sinon ROWID / ctid / rowid) est ajoutée au SELECT, avec `DUP_COUNT` quand la liste le permet — pour des lignes identiques, la clé qui change est celle de la table qui les répète. Un second mode donne un **récapitulatif par table** (`REPEATED_GROUPS` > 0 = cette table multiplie les lignes, souvent une condition de jointure absente ou trop large). `DISTINCT` est retiré pour que les doublons apparaissent.

## 0.24.0
### Ajouts
- **Doublons dans la grille de résultats** : le bouton *Doublons* met en évidence les lignes qui ont les mêmes valeurs dans les colonnes choisies (par défaut toutes sauf la clé primaire), une couleur par groupe avec le nombre `×N` à côté du numéro de ligne ; *Seulement les doublons* ne garde que ces lignes, regroupées ; un récapitulatif donne le nombre de lignes et de groupes (lignes chargées seulement).
- **Rechercher les doublons d'une table** (clic droit sur une table, tuile Outils, ou palette) : choisir les colonnes qui doivent être identiques, puis obtenir une **synthèse** (une ligne par valeur dupliquée avec son nombre), **toutes les lignes qui ont un doublon** (regroupées, avec `DUP_COUNT`), ou un **script de suppression** qui garde une ligne par groupe (ouvert, jamais exécuté). Les colonnes LOB / JSON / XML sont écartées.

## 0.23.1
### Amélioré
- **Erreurs de compilation** (package, corps de package, procédure, fonction, trigger, type…) : après *Exécuter*, le **curseur saute sur la première erreur** (ligne et colonne), un message donne l'erreur avec un bouton *Aller à la ligne N*, l'onglet Script / Messages liste toutes les erreurs avec la ligne de source, et les erreurs restent soulignées dans l'éditeur / le panneau Problèmes (F8 pour la suivante). La ligne est maintenant exacte même avec des commentaires, des lignes vides ou `CREATE OR REPLACE` seul sur sa ligne avant le mot-clé de l'objet.
- **Recompiler depuis le Schema Browser** (objet invalide) : le message affiche la première erreur et *Ouvrir le source à l'erreur* ouvre le source de l'objet avec chaque erreur soulignée et le curseur sur la première (les erreurs de spécification et de corps sont placées dans leur propre unité).

## 0.23.0
### Modifié
- **Ctrl+clic sur une clé ne pose plus de question** : le lien est choisi d'après la requête affichée (une clé étrangère ouvre la ligne parente ; une clé référencée ouvre les lignes enfants ; une table déjà présente dans la requête passe en dernier). **Alt+Ctrl+clic** permet toujours de choisir, **Maj+Ctrl+clic** ouvre un nouvel éditeur.
- **Fil d'Ariane : le retour ne relance pas la requête** — les lignes déjà chargées sont réaffichées telles quelles (y compris celles lues avec *Lignes suivantes*, qui continue de fonctionner ensuite).
### Ajouts
- **Describe Objects → Referential** pour toutes les bases (pas seulement Oracle) : *Références →* et *← Référencée par* avec les colonnes de cette table, celles de la table liée et la clé référencée (Oracle) ; cliquer une table liée ouvre son propre Describe.
- **Describe Objects → Data** : couleur par type de colonne avec légende, indicateurs 🔑 / 🔗, **Ctrl+clic sur une clé** pour suivre le lien avec le même **fil d'Ariane** (retour instantané) que la grille de résultats.

## 0.22.3
### Corrigé
- **Fil d'Ariane des lignes liées** : le retour en arrière ré-exécutait la requête d'origine sans ses variables de liaison (`NJS-098 : 1 bind placeholders were used … but 0 bind values were provided`) ; les valeurs sont maintenant conservées avec chaque étape.
- **Jointures Oracle → JOIN ANSI** : une condition avec une expression d'un côté devient `JOIN LANGU ON LANGU.LANGU_ID = NVL(FACTU.FACTU_LANGU_ID, FA_TIERS.TIERS_LANGU_ID)` (table jointe en premier) ; quand une instruction ne peut pas être convertie, le message donne maintenant le motif précis (OR dans le WHERE, (+) des deux côtés d'une condition, élément du FROM non géré, alias en double…).
### Modifié
- **Onglet Outils** : grille compacte de tuiles à icônes (la description est dans l'info-bulle).

## 0.22.2
### Corrigé
- **Jointures Oracle → JOIN ANSI** : les conditions de jointure écrites **sans alias** (`AND TIERS_ID = COMMA_TIERS_ID`) sont maintenant reconnues — chaque colonne est rattachée à sa table grâce aux métadonnées — et deviennent `JOIN … ON` (sans `(+)`), `LEFT JOIN` (`col = autre(+)`) ou `RIGHT JOIN` (`col(+) = autre`) ; seules les tables sans condition de jointure deviennent `CROSS JOIN`, et le message indique combien.
### Modifié
- **Barre d'outils du Schema Browser** : il ne reste que 4 icônes (filtrer, nouvelle connexion, nouvel éditeur SQL, rafraîchir) ; les autres actions sont dans le menu `…`, par section (affichage : regrouper par schéma / invalides seulement / filtrer par type — connexion : connexion active, schéma, tout déconnecter, importer tnsnames — outils : comparer des schémas). Les lignes de connexion gardent un seul bouton (déconnecter) ; les autres sont au clic droit.

## 0.22.1
### Modifié
- **Vue Aide** : *Guide visuel*, *Raccourcis clavier* et *Nouveautés* sont maintenant trois onglets internes (même style que les autres vues) ; l'onglet choisi est mémorisé.

## 0.22.0
### Modifié
- **Barre latérale réorganisée en moins de vues, avec des onglets internes** :
  - **Historique & favoris** — une seule vue, deux onglets (champ de filtre, listes groupées, boutons exécuter / insérer / ouvrir / copier / renommer / supprimer sur chaque ligne).
  - **Outils & réglages** — une seule vue, deux onglets.
  - **Schema Browser | Connexion** — le formulaire de connexion prend la place du Schema Browser via un onglet *Connexion* (première ligne de l'arbre, ou *Nouvelle connexion*) ; le formulaire a un onglet *Schema Browser* et ramène au navigateur une fois connecté. (Un arbre VS Code ne peut pas contenir d'onglets : les deux vues alternent au même emplacement.)
- Les commandes de filtre de l'historique sont remplacées par le champ de filtre de la nouvelle vue.

## 0.21.0
### Modifié
- **Lignes liées avec fil d'Ariane** : Ctrl+clic sur une clé ouvre maintenant la ligne parente / les lignes enfants **dans la grille elle-même** et ajoute une étape à un **fil d'Ariane** au-dessus (`SELECT … › ↑ DEPT [ID=10] › ↓ EMP [DEPT_ID=10]`). Cliquez une étape ou *Retour* pour revenir (la requête de l'étape est ré-exécutée : données à jour, tri, pagination et édition continuent de fonctionner) ; *SQL* ouvre la requête de l'étape courante dans un éditeur. Maj+Ctrl+clic garde l'ancien comportement (nouvel éditeur). Exécuter une requête normale remet le fil à zéro.

## 0.20.0
### Ajouts
- **Jointures Oracle → JOIN ANSI** (Tools, actions de code, menu de l'éditeur) : réécrit `FROM a, b WHERE a.x = b.y(+)` en `FROM a LEFT JOIN b ON …` (aussi `RIGHT JOIN`, `CROSS JOIN`, filtres du côté optionnel déplacés dans le `ON`), sous-requêtes et branches d'UNION comprises, sur l'instruction ou la sélection. Les cas non convertibles sans risque (`OR` au premier niveau du WHERE, `(+)` des deux côtés…) sont laissés tels quels et signalés. Ctrl+Z annule.
- **Objets invalides (Oracle)** : *Afficher seulement les objets invalides* (titre de la vue, ou dans la boîte de filtre) et **Recompiler** — un objet, ou tous les invalides d'une catégorie / d'un schéma (deux passes pour résoudre les dépendances ; erreurs restantes listées dans Script / Messages).
- **Regroupement par schéma (utilisateur)** dans le Schema Browser (`dbexplorer.groupBySchema`, bascule dans le titre de la vue) : connexion → schémas (le courant d'abord) → catégories → objets ; *Utiliser ce schéma* en fait le schéma courant. Le filtre de nom filtre alors les schémas ; les filtres de type et d'invalides s'appliquent dans chaque schéma.

## 0.19.0
### Ajouts
- **Impact / lineage** : clic droit sur un objet du Schema Browser → *Qui utilise cet objet ?* (vues, packages, procédures, triggers, tables par clé étrangère…) ou *Que contient / utilise cet objet ?*, affiché en graphe sur 3 niveaux (Oracle `ALL_DEPENDENCIES`, dépendances de vues PostgreSQL, usage des vues MySQL, vues / triggers SQLite).
- **Comparaison de schémas** (menu du titre du Schema Browser / Tools) : choisir une source et une cible (deux connexions, ou deux schémas d'une même), obtenir les objets manquants, en trop et les colonnes différentes sous forme de **script de synchro** ouvert dans un éditeur lié à la cible (CREATE des objets manquants, ADD / MODIFY des colonnes ; les suppressions sont en commentaire).
- **Vue Favoris** : enregistrer l'instruction courante par connexion ou pour toutes (menu contextuel de l'éditeur, Tools), ouvrir / exécuter / renommer / supprimer depuis la vue, en insérer une avec *Insérer un favori* ; les paramètres `:nom` fonctionnent comme d'habitude.
- **Édition directe dans la grille** : pour un résultat issu d'une seule table dont la clé primaire est dans le résultat, le bouton **Modifier** permet de double-cliquer les cellules, préparer les changements (surlignés) puis les **Appliquer** : un `UPDATE … WHERE pk = …` par ligne dans la transaction ouverte (confirmation en auto-commit ou sur une connexion de production). Saisir `NULL` met une valeur nulle ; les LOB et les colonnes de clé restent en lecture seule.

## 0.18.0
### Ajouts
- **Diagramme ER** : clic droit sur une table du Schema Browser (ou Tools → Diagramme ER pour choisir plusieurs tables) pour la voir avec les tables liées par clés étrangères ; les flèches vont de la table enfant vers la table parente, avec les colonnes de la clé ; les nœuds indiquent la clé primaire et le nombre de colonnes.
- **Suivre les clés étrangères dans la grille** : **Ctrl+clic** sur une cellule de clé ouvre la ligne parente (clé étrangère) ou les lignes enfants (clé référencée) dans un nouvel éditeur, exécuté aussitôt. Les cellules liées sont soulignées au survol ; un rappel figure dans le bandeau de légende.

## 0.17.0
### Ajouts
- **Aperçu avant UPDATE / DELETE** : les lignes que l'instruction va toucher sont d'abord comptées (`SELECT COUNT(*)` avec le même WHERE, 5 s maximum) et affichées dans le journal. Une confirmation est demandée quand le nombre atteint `dbexplorer.confirmRowsThreshold` (100 par défaut), quand il n'y a **pas de WHERE**, ou sur une **connexion rouge (production)** (`dbexplorer.confirmOnProduction`) ; elle signale aussi que l'auto-commit est activé. Annuler arrête un script avant toute modification. Le comptage se désactive avec `dbexplorer.previewAffectedRows`.

## 0.16.0
### Ajouts
- **Les modifications non validées sont bien visibles** : bandeau d'alerte au-dessus de la grille avec de gros boutons **Commit** / **Rollback**, éléments **Commit** et **Rollback** colorés en alerte dans la barre d'état, boutons dans la barre de titre de l'éditeur (uniquement tant qu'une transaction est ouverte), et message de rappel à la première instruction qui laisse des données non validées (`dbexplorer.notifyUncommitted`).
- **Survol d'un alias de table** (ou d'un nom de table) dans une requête : champs de la table liée (type, PK, commentaire) ; pour une sous-requête / CTE, ses colonnes.

## 0.15.3
### Modifié
- Filtre du Schema Browser : **une seule boîte avec le filtre sur le nom et une liste à choix multiple des types d'objets qui existent réellement** (avec le nombre quand c'est indexé) ; cochez les types, saisissez un nom, Entrée. Seuls les types cochés sont affichés.

## 0.15.2
### Ajouts
- **Filtrer le Schema Browser par type d'objet** (tables, vues, packages…) : liste à cocher depuis le titre de la vue ou la ligne de recherche, combinable avec le filtre sur le nom.
### Corrigé
- **Graphe de requête et jointures Oracle** : `WHERE a.x = b.y(+)` est représenté comme une jointure externe (flèche de la table préservée vers la table optionnelle, `OUTER (+)` sur la table) ; les jointures par virgule sont libellées *jointure implicite* ; les conditions avec fonctions (`UPPER(a.x) = UPPER(b.y)`, `(+)` après une parenthèse) et les conditions `ON` ANSI ne sont plus mélangées.

## 0.15.1
### Modifié
- La recherche d'objets est fusionnée dans le **Schema Browser** : première ligne de l'arbre (clic, saisie, Entrée ; × pour effacer).
### Corrigé
- **Aide à la saisie dans le source des packages, procédures, fonctions, triggers et vues** (ouverts depuis le Schema Browser ou F4) : l'instruction SQL autour du curseur est isolée du bloc PL/SQL (alias, colonnes, jointures, variables d'un `SELECT … INTO`, curseurs, `FOR r IN (SELECT …)`), et le source est lié à la connexion d'origine.

## 0.15.0
### Ajouts
- **Graphe de la requête** (Tools, actions de code, palette) : schéma des tables, sous-requêtes / CTE et conditions de jointure (avec le `(+)` d'Oracle) de l'instruction courante ; les tables sans condition de jointure sont signalées. Le bouton « Mermaid » copie le schéma au format Mermaid.
- **Graphe des appels** d'un package, d'une procédure ou d'une fonction (clic droit dans le Schema Browser, ou depuis le source ouvert dans l'éditeur) : appels internes entre sous-programmes (publics / privés), appels vers d'autres packages et packages système.
- **Indicateurs PK / FK** dans l'en-tête de la grille (icônes clé et lien, avec légende), d'après les métadonnées indexées.
- **Champ de recherche au-dessus du Schema Browser** : saisir puis Entrée. Toutes les catégories contenant des correspondances sont ouvertes automatiquement ; l'index de métadonnées est utilisé en priorité, sinon la base. Échap / × efface.
- Filtre par colonne : le panneau se referme une fois validé ; les listes de colonnes (filtre, recherche, afficher/masquer) sont triées par ordre alphabétique (case A→Z dans le panneau Colonnes).

## 0.14.1
### Corrigé
- Les dates de la grille s'affichent `2026-07-17 15:34:23` (date seule à minuit) au lieu du long format JavaScript.

## 0.14.0
### Ajouts
- **Annuler l'instruction en cours** : bouton « Annuler la requête » dans la barre d'état, la barre de titre de l'éditeur (et le bandeau des résultats), `Ctrl+Alt+Q`. Oracle (break), PostgreSQL (`pg_cancel_backend`) et MySQL/MariaDB (`KILL QUERY`) sont réellement interrompus ; SQLite ne peut pas l'être. Un script annulé s'arrête.
- **Délai maximal d'exécution configurable** (`dbexplorer.queryTimeoutSeconds`, aussi dans la vue Réglages) : l'instruction est annulée au-delà ; la limite apparaît dans le bandeau d'exécution et un message clair dans le journal.
- **Bases dupliquées non rescannées** : quand le schéma d'une connexion ressemble à un autre déjà en cache (même SGBD, ≥ 90 % de noms d'objets communs), ses colonnes sont reprises. Sous Oracle, une seule requête renvoie l'empreinte de structure de chaque table et seules les tables différentes sont relues (le rafraîchissement périodique devient aussi bien moins coûteux). La vue Réglages indique le nombre de tables reprises.
- **Afficher / masquer des colonnes** dans la grille de résultats (bouton Colonnes ; la copie suit les colonnes visibles).
- **Code couleur discret par type de colonne** dans l'en-tête et les cellules (nombre, texte, date/heure, booléen, binaire/LOB, autre) avec un **bandeau de légende** au-dessus de la grille.
- **Filtre rapide dans le Schema Browser** (icône de filtre dans le titre de la vue) : sous-chaîne ou motif avec `*`, appliqué aux objets de toutes les catégories.
### Modifié
- Les boutons Excel et CSV de la grille sont supprimés ; il ne reste que **Exporter…** (tous les formats).
### Corrigé
- Les alias de **sous-requêtes / tables dérivées** et les alias de tables dans les requêtes imbriquées (sous-requêtes corrélées, CTE, alias `TABLE()`/`XMLTABLE()`/`UNNEST()`) sont détectés par portée ; les tables d'une sous-requête ne « fuient » plus dans la requête externe.

## 0.13.0 — 2026-11-01
### Ajouté
- **Connexion dans la barre de titre de VS Code** (`nom · user@schéma`, ex. `Hhdev1@PSGLWRK · Hhdev1@HHDEV1`), activée par défaut (`dbexplorer.connectionInWindowTitle`). Elle modifie le réglage utilisateur `window.title` et le restaure sans connexion active. Si vous utilisez le Centre de commandes, mettez `"window.commandCenter": false` pour voir le texte du titre. La vue « Connexion active » ajoutée avant et le texte sur l'en-tête du Schema Browser sont supprimés.
- **Afficher les actions de code à la position du curseur** (`Ctrl+Alt+A`, `Ctrl+.`, ampoule) : décrire / SELECT * / compter les lignes de la table ou de l'alias sous le curseur, **développer `*` / `alias.*` en liste de colonnes**, **ajouter la condition `ON` manquante d'une JOIN** d'après les clés étrangères, exécuter, plan, optimiser, types des colonnes, comparer, mettre en forme l'instruction, commenter.
- **Jointures « à l'Oracle » dans l'aide à la saisie** : après `FROM a, ` les tables liées par clé étrangère sont proposées avec leur alias et la condition de jointure est ajoutée au WHERE existant ; dans le WHERE, les conditions de jointure manquantes sont proposées (`a.id = b.a_id`) avec les variantes de jointure externe Oracle (`(+)` de chaque côté) ; `DUAL` et fonctions de table (`TABLE(`, `XMLTABLE(`, `JSON_TABLE(`) après FROM.
- **Une ligne vide termine une instruction** sans « ; » (comme Toad ; pas dans les parenthèses ni les blocs PL/SQL ; `dbexplorer.blankLineSeparatesStatements`). L'instruction sous le curseur — exécution, plan, optimisation, et alias de table de l'aide à la saisie — ne se mélange plus avec les requêtes voisines.
### Modifié
- Barre latérale au démarrage : **seul Schema Browser est déplié** ; Connexion, Réglages, **Outils** (n'est plus masqué), Aide et Historique sont repliés (identifiants de vues renommés pour que les nouveaux défauts s'appliquent).
### Corrigé
- Les alias de table n'étaient pas reconnus quand plusieurs requêtes sans « ; » se suivaient (les alias des autres requêtes se mélangeaient).
- Describe / ouvrir un objet utilise maintenant la connexion de l'éditeur et non plus la connexion active globale.

## 0.12.0 — 2026-10-31
### Ajouté
- **Bandeau de connexion tout en haut de DB Explorer** : une première vue dont le titre est la connexion active (`nom · user@schéma`), avec barre de couleur, type de base, mode de commit, indicateur de modifications non validées et boutons rapides (changer, schéma, éditeur SQL, déconnecter). L'option `dbexplorer.connectionInWindowTitle` l'affiche aussi dans le titre de la fenêtre VS Code.
- **La vue Connexion liste vos connexions enregistrées** : badge testée OK / échec / non testée (date et erreur en info-bulle), indicateur connectée, boutons Connecter / Déconnecter / Tester / Modifier, et pastille de couleur pour changer la couleur d'une connexion en un clic. Les résultats sont mémorisés.
- **Icône de déconnexion rapide** sur chaque connexion ouverte du Schema Browser, plus « Tout déconnecter ».
- **Grille** : la recherche peut cibler une seule colonne ; les cellules NULL ont un fond gris clair.
- **Aide à la saisie** :
  - dans une requête existante, les tables du FROM passent en premier — leurs alias (`t.` ouvre les colonnes), puis leurs colonnes ; les colonnes des autres tables seulement si rien du FROM ne correspond (marquées « hors clause FROM ») ; les colonnes ambiguës sont proposées qualifiées (`t.ID`, `c.ID`) ;
  - après `a.x =`, les colonnes des autres tables du FROM sont proposées, celle liée par clé étrangère en premier ;
  - **alias de colonne depuis le commentaire de la colonne** : après `col AS ` ou `col `, le commentaire devient `DATE_DE_CREATION` ou `"Date de création"` (Oracle, PostgreSQL, MySQL) ;
  - les alias sont reconnus pour les sous-requêtes (`FROM (SELECT …) x`, `SELECT *` développé), les CTE (`WITH w (a, b) AS …`) et `MERGE … USING` ;
  - plus de tables manquantes : les correspondances sont classées (préfixe, contient, approximatif) *avant* le plafond, et la base est aussi interrogée par préfixe (autres schémas, synonymes publics, tables récentes) dès 3 caractères.
- **Proposer des optimisations de la requête** (`Ctrl+Alt+O`, barre de l'éditeur, vue **Outils** — masquée par défaut, à activer depuis le menu « … » de DB Explorer) : règles par base (SELECT *, fonctions sur colonnes, LIKE à joker initial, NOT IN, UNION / UNION ALL, produit cartésien, ORDER BY aléatoire, gros OFFSET, ROWNUM / (+) / hints / FOR UPDATE Oracle…), **index manquants** vérifiés sur les vrais index pour les colonnes filtrées et jointes (avec un CREATE INDEX prêt à l'emploi), parcours complets / filesort / tables temporaires repérés dans le **plan d'exécution**, et conseils propres à chaque base.
- **Commenter / décommenter** les lignes (`Ctrl+Alt+C`, `Ctrl+B` avec le jeu Toad) et commentaire de bloc, aussi depuis le menu contextuel.
- **Comparer des requêtes** : différences côte à côte avec un autre éditeur, le presse-papiers, une entrée de l'historique ou un fichier (avec mise en forme préalable en option : espaces et casse des mots-clés ignorés), ou **comparaison des lignes** renvoyées par deux requêtes (lignes seulement dans A / seulement dans B).
### Corrigé
- Explain Plan avec variables de liaison sur Oracle (les valeurs n'étaient pas converties).
- Le nombre de lignes était affiché deux fois dans la barre d'état des résultats.

## 0.11.0 — 2026-10-30
### Ajouté
- **Tri par clic sur l'en-tête de colonne, exécuté par la base** : un clic = `ORDER BY` croissant, deuxième clic = décroissant, troisième clic = ordre d'origine (▲ / ▼ sur l'en-tête). La requête est enveloppée en `SELECT * FROM (<votre requête>) ORDER BY …` : les exports suivent le tri.
- **Bouton Filtrer à plusieurs critères** : ajoutez autant de critères que nécessaire (colonne, opérateur, valeur) — `=`, `≠`, `>`, `≥`, `<`, `≤`, contient, commence par, finit par, dans la liste, entre, est nul, n'est pas nul — combinés en ET ou en OU. Les valeurs passent en variables de liaison ; le filtre s'exécute dans la base et l'export reprend les lignes filtrées. Si une requête ne peut pas être enveloppée (colonnes en double, LOB…), tri et filtres se rabattent sur les lignes déjà chargées.
- **Export en INSERT / MERGE avec variables de liaison** (Oracle) : « SQL INSERT — bind variables » et « SQL MERGE » / « SQL MERGE — bind variables ». Les versions à binds sont des blocs PL/SQL (100 lignes chacun) qui exécutent `EXECUTE IMMEDIATE '… :1, :2 …' USING valeur, …` : une seule instruction analysée par le serveur, valeurs passées en binds. Les colonnes clés du MERGE sont par défaut la clé primaire de la table (ou se choisissent dans une liste). Les dates deviennent `TO_DATE` / `TO_TIMESTAMP`.
### Corrigé
- **Aucune connexion ne reste ouverte après fermeture / rechargement / timeout d'inactivité / déconnexion** : les sessions de métadonnées (scan et recherche) sont fermées avec leur connexion, les requêtes en cours sont d'abord interrompues, la transaction annulée, et tout se ferme en parallèle dans un délai borné (avant, une connexion occupée pouvait retarder la fermeture au-delà du délai de VS Code). La vue Réglages indique combien de sessions de métadonnées une connexion détient.

## 0.10.0 — 2026-10-29
### Ajouté
- **Connexion active dans l'en-tête de DB Explorer** : l'en-tête du Schema Browser et du panneau Résultats affichent `connexion · user@schéma` ; la barre d'état affiche aussi `user@schéma`.
- **Export des résultats vers Excel (.xlsx) et plus** : CSV, TSV, JSON, HTML, Markdown, SQL INSERT et XML, avec les nouveaux boutons **Excel** / **CSV** / **Exporter…** du panneau Résultats (ou la commande « Exporter les résultats… »). Toutes les lignes sont relues en flux (aucune limite mémoire, testé avec 400 000 lignes) ; le fichier Excel a des en-têtes en gras, une ligne d'en-tête figée, un filtre automatique, des nombres et des dates typés, et une nouvelle feuille tous les 1 048 576 lignes. Le séparateur CSV est réglable (`dbexplorer.csvSeparator`).
- **Raccourci « nouvel éditeur SQL »** : `Ctrl+Alt+N` (`standard`), `Alt+Maj+N` (`alt`). L'éditeur porte le nom de sa connexion (`PROD-1.sql`) et lui est lié.
- **Détection de tnsnames.ora** : TNS_ADMIN, ORACLE_HOME, registre Windows, dossiers Oracle / Instant Client habituels, PATH et dossiers de l'espace de travail sont explorés. Sans connexion Oracle, une invite propose l'import ; « Importer des connexions depuis tnsnames.ora… » (aussi dans le Schema Browser vide) permet de choisir plusieurs alias et crée les connexions d'un coup. Le formulaire de connexion suggère les dossiers détectés.
- **Couleur par connexion** (palette de 9, rouge = production) : icône de base colorée dans le Schema Browser, titre d'onglet coloré avec une pastille, liseré coloré à gauche et marque dans la règle de l'éditeur SQL, barre d'état colorée (le rouge la transforme en alerte). Les couleurs sont personnalisables (`dbexplorer.color.*`) et désactivables (`dbexplorer.colorEditors`).
### Modifié
- **Chaque éditeur SQL s'exécute désormais sur sa propre connexion** (celle de sa création ou de sa première exécution) : un éditeur PROD reste sur PROD même si vous changez de connexion active. Choisir une connexion pendant qu'un éditeur SQL a le focus déplace cet éditeur vers elle.

## 0.9.0 — 2026-10-28
### Corrigé
- **L'aide à la saisie ne reste plus bloquée sur « Loading… » sur les très grosses bases Oracle.** La partie lente (chargement de tout le dictionnaire) tournait sur la connexion de vos requêtes et la liste l'attendait. Désormais :
  - la liste des objets vient de la mémoire / du cache disque instantanément et la liste **répond toujours en ~1,2 s** ; si la base est plus lente, vous obtenez ce qui est en cache plus une ligne « Recherche… » / « Chargement des colonnes… », et la liste **se rouvre toute seule** quand la donnée arrive ;
  - Oracle : les objets de votre schéma viennent de `USER_OBJECTS` (bien plus rapide que `ALL_OBJECTS`), les colonnes d'une requête légère par table, et les clés étrangères sont lues table par table à la demande (plus de scan du schéma entier).
### Ajouté
- **Scanner de métadonnées en arrière-plan** sur une **connexion dédiée** (jamais votre session de requêtes) : liste des objets, puis colonnes de toutes les tables par lots de 60 étalés dans le temps (en pause pendant que vous exécutez une instruction). La progression s'affiche dans la barre d'état et dans la vue Réglages ; le résultat est stocké sur disque (24 h pour les colonnes, 30 min pour la liste des objets) : le démarrage suivant est instantané.
- **Recherche à la frappe en secours** : si ce que vous tapez n'est pas dans le cache (nouvelle table, base partiellement scannée), l'extension le cherche directement dans la base par préfixe — votre schéma, synonymes publics, puis autres schémas (`PROPRIO.TABLE`) — et le mémorise. Les noms inconnus sont vérifiés dans la base avant d'être ignorés.
- Réglages : `dbexplorer.prefetchMetadata` et `dbexplorer.metadataConnection`, et une section « Cache de l'aide à la saisie » (compteurs, progression, « Reconstruire le cache ») dans la vue Réglages.
- La liste des schémas est mise en cache 10 minutes ; taper `nom.` ne scanne un schéma que s'il existe vraiment.

## 0.8.0 — 2026-10-27
### Ajouté
- **Raccourci dédié « Déclencher l'aide à la saisie »**, sans conflit avec le système / la méthode de saisie (`Ctrl+Espace` est souvent pris) : `Ctrl+Alt+Espace` (`standard`), `Alt+Maj+Espace` (`alt`), `Ctrl+Espace` (`toad`). Aussi dans le menu contextuel de l'éditeur.
- **Suggestions de jointures d'après les clés étrangères** : après `JOIN`, les tables liées à celles déjà présentes dans la requête sont proposées en premier, avec l'alias et la condition `ON` prêts (`COMMANDES c ON c.TIERS_ID = t.TIERS_ID`) ; après `ON`, les conditions d'égalité correspondantes. Oracle, SQLite, MySQL et PostgreSQL, avec ou sans alias.
- **Cache de métadonnées persistant** (objets, colonnes, clés étrangères), stocké sur disque par connexion et schéma : l'aide est disponible instantanément au démarrage de VS Code, puis rafraîchie en arrière-plan. « Rafraîchir » dans le Schema Browser le reconstruit.
- **Colonnes sans alias** : en tapant une colonne dans le `SELECT` avant tout `FROM`, les colonnes de toutes les tables du schéma sont proposées (avec leur table).
### Corrigé
- Aide après **Entrée** suivant `FROM` / `JOIN` / `WHERE` / une virgule : la liste s'ouvre automatiquement sur la nouvelle ligne, et `Entrée` n'accepte une suggestion que si elle modifie le texte (sinon simple retour à la ligne).
- Les listes sont filtrées côté extension et plafonnées : les schémas de milliers d'objets restent rapides.

## 0.7.0 — 2026-10-26
### Ajouté
- **Vue Réglages** dans la barre latérale : timeout d'inactivité (30 min par défaut), rollback automatique des modifications non validées au timeout, timeout de transaction, timeout de requête, et liste des connexions ouvertes (inactivité, état non validé) avec boutons Rendre active / Rollback / Déconnecter.
- **Rollback + déconnexion automatiques à la fermeture ou au rechargement de VS Code** : toutes les connexions ouvertes sont annulées puis fermées.
### Modifié
- La vue **Historique** est repliée par défaut et placée en dernier dans la barre latérale (nouvel identifiant de vue : le nouveau défaut s'applique aussi aux installations existantes).
### Corrigé
- L'aide à la saisie apparaît maintenant à la frappe (plus seulement avec Ctrl+Espace) : les snippets ne bloquent plus les suggestions rapides, et la liste des objets est préchargée à la connexion puis mise en cache, si bien qu'une base lente n'annule plus chaque demande. Aide après `JOIN` / `LEFT JOIN` / `INNER JOIN` vérifiée.

## 0.6.0 — 2026-10-25
### Ajouté
- **Aide à la saisie contextuelle** dans l'éditeur SQL : tapez `TI` et on vous propose `TIERS` (tables, vues, synonymes avec leur type).
  - après `FROM` / `JOIN` / `UPDATE` / `INTO` : tables, vues et schémas uniquement (proposé aussi dès l'espace) ;
  - après `SELECT` / `WHERE` / `AND` / `ON` / `SET` / `ORDER BY`… : colonnes (type et PK affichés) des tables de l'instruction, puis fonctions et mots-clés ;
  - `alias.` / `table.` → colonnes, `schéma.` → objets du schéma, `package.` → procédures et fonctions du package (Oracle) ;
  - après `FROM table` : les clauses suivantes (`WHERE`, `GROUP BY`, `JOIN`…) ;
  - fonctions Oracle avec emplacements d'arguments, gabarits de requêtes (`select`, `insert`, `update`, `delete`, `count`, `plsql`) ;
  - les mots-clés suivent la casse saisie ; rien n'est proposé dans une chaîne ou un commentaire.
- Les fichiers SQL activent les suggestions rapides à la frappe (réglages `[sql]` : suggestions rapides activées, suggestions de mots du document désactivées).

## 0.5.0 — 2026-10-24
### Ajouté
- **Interface en anglais par défaut**, en français si VS Code (donc l'OS) est en français : menus, commandes, réglages, vues, messages et fenêtres.
- **Historique des requêtes** dans la barre latérale : groupé par jour, info-bulle avec le SQL complet, clic = ouvrir dans un éditeur, ▶ = relancer (la bonne connexion est réactivée), filtre, copie, suppression, « vider l'historique ».
- **Changer de connexion active facilement** : clic sur une connexion ouverte dans le Schema Browser (la connexion active est en vert avec « active »), bouton `$(plug)` dans le titre de la vue et dans la barre de l'éditeur, clic sur la barre d'état ; sélecteur avec connexions ouvertes / enregistrées et « Nouvelle connexion… ».
### Modifié
- Les raccourcis ne sont plus affichés dans la vue Connexion : ils se trouvent dans la vue « Aide » (repliée), avec liens pour changer de jeu ou personnaliser les touches.

## 0.4.0 — 2026-10-23
### Ajouté
- **Fenêtre Paramètres** : à l'exécution, toutes les variables de liaison (`:nom`) sont listées dans un seul panneau (valeur, NULL, type ; direction IN / OUT / IN OUT pour Oracle). Les valeurs sont mémorisées.
- **Chrono d'exécution** : bandeau « Exécution en cours… mm:ss » dans le panneau de résultats, plus message dans la barre d'état, tant que la requête n'a pas répondu.
- **PL/SQL** :
  - paramètres OUT / IN OUT affichés après exécution (`:r := f(…)`, `INTO :x`), **REF CURSOR** OUT affiché dans la grille (`OPEN :c FOR …`) ;
  - commandes SQL*Plus `EXEC` / `EXECUTE` et `SHOW ERRORS` ;
  - « Exécuter avec paramètres… » (clic droit sur une procédure, fonction ou package du Schema Browser) : génère le bloc d'appel avec les arguments réels (`ALL_ARGUMENTS`) ;
  - découpage fiable des blocs `BEGIN … END;` (IF / LOOP / CASE imbriqués, lignes vides, blocs consécutifs sans `/`).
### Corrigé
- Les raccourcis ne s'activent plus que lorsque le curseur est dans l'éditeur SQL (`editorTextFocus`) : F4 n'entre plus en conflit avec la navigation dans les résultats de recherche, etc.

## 0.3.0 — 2026-10-22
### Ajouté
- **Describe Objects** (comme Toad) sur `F4` / `Ctrl+Alt+D` : onglets Columns, Indexes, Constraints, Triggers, Data, Script, Partitioning, Grants, Synonyms, Stats/Size, Referential, Used By, avec en-tête (créé le, dernier DDL, clé primaire). Tri et filtre dans chaque onglet. Fonctionne aussi depuis le Schema Browser (« Décrire »). Oracle complet ; autres bases : Columns, Indexes, Constraints, Data, Script.
- Réglage `dbexplorer.keymap` avec trois jeux de raccourcis : `standard`, `alt`, `toad`, sélectionnable dans la vue Connexion.
### Modifié
- Raccourcis par défaut (jeu `standard`) : `Ctrl+Alt+Enter` (exécuter), `Ctrl+Alt+S` (script), `Ctrl+Alt+X` (Explain Plan), `Ctrl+Alt+D` (Describe), `Ctrl+Alt+T` (types des colonnes). Remplace le réglage `toadKeys`.

## 0.2.0 — 2026-10-22
### Ajouté
- Vue **Connexion** dans la barre latérale : formulaire avec champs par type de base (alias TNS en liste, dossier `tnsnames.ora`, fichier SQLite, hôte/port…), boutons Tester / Enregistrer / Enregistrer et connecter.
- Les **raccourcis** sont affichés dans cette même vue (cliquables) ; bouton pour activer les raccourcis Toad classiques.
- Vue **Aide** repliée en bas de la barre latérale : version, changelog, guide visuel.
- Notification « Nouveautés » à chaque changement de version.
- Réglage `dbexplorer.toadKeys` (F9, F5, Ctrl+E, F4, Ctrl+F9) désactivé par défaut.
### Modifié
- Le panneau de résultats s'affiche maintenant **en bas** de VS Code (panneau), sans voler le focus de l'éditeur.
- Nouveaux raccourcis par défaut sans conflit avec VS Code : `Alt+Enter`, `Alt+Shift+Enter`, `Alt+Shift+E`, `Alt+D`, `Alt+Shift+D`.
### Corrigé
- Oracle : F4 sur une table ne provoque plus `ORA-00932: inconsistent datatypes: expected CHAR got LONG` (colonne `DATA_DEFAULT`).
- Icône de la barre latérale en formes pleines (carré noir).

## 0.1.0 — 2026-10-20
### Ajouté
- Prise en charge d'Oracle (Thin, `tnsnames.ora`), SQLite, MySQL/MariaDB et PostgreSQL.
- Schema Browser, éditeur SQL (exécution d'instruction / script), grille de résultats, DBMS_OUTPUT, Explain Plan, DDL, export CSV/JSON, historique, complétion.
- F4 : description d'une table ou ouverture du source d'une fonction, d'un package ou d'un trigger ; Ctrl+F9 : types des colonnes d'une requête.
