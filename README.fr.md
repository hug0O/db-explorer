# DB Explorer

**Un client SQL multi-bases pour VS Code, inspiré de Toad.** Parcourez les schémas, écrivez du SQL avec une aide à la saisie contextuelle, exécutez requêtes et scripts, modifiez et exportez les résultats — sur **Oracle, PostgreSQL, MySQL / MariaDB et SQLite**.

🇬🇧 [English version](README.md) · 📜 [Journal des modifications](CHANGELOG.fr.md)

L'interface est en **anglais** et passe automatiquement en **français** quand VS Code est en français.

| Base | Pilote | Remarques |
|---|---|---|
| **Oracle** | `oracledb` (mode Thin, **sans Instant Client**) | alias `tnsnames.ora`, SYSDBA / SYSOPER, PL/SQL, `DBMS_OUTPUT`, erreurs de compilation |
| **PostgreSQL** | `pg` + `pg-cursor` (pagination côté serveur) | savepoint par instruction dans les transactions |
| **MySQL / MariaDB** | `mysql2` | |
| **SQLite** | `node-sqlite3-wasm` (aucune compilation native) | fichier ou `:memory:` |

> ⚠️ Les fonctions propres à Oracle (compilation, membres de package, `ALL_ARGUMENTS`, synonymes…) sont écrites d'après le dictionnaire de données Oracle mais n'ont **pas été exécutées sur un vrai serveur Oracle** par l'auteur. PostgreSQL, MySQL et SQLite sont couverts par des tests d'intégration (voir [Développement](#développement)). Les retours de bugs sont les bienvenus.

## Démarrage

1. Cliquez sur **DB Explorer** dans la barre d'activités. Utilisez **+** (ou l'onglet *Connexion*) pour créer une connexion : choisissez le type de base, remplissez les champs (pour Oracle, choisissez un alias TNS — `tnsnames.ora` est détecté automatiquement), puis **Enregistrer et connecter**.
2. Ouvrez un fichier `.sql` (ou `Ctrl+Alt+N` pour un nouvel éditeur) et exécutez l'instruction sous le curseur avec `Ctrl+Alt+Entrée`.
3. Les résultats s'affichent dans le panneau **DB Explorer** du bas : grille, messages du script, erreurs, DBMS Output et plan d'exécution.

`Ctrl+Alt+J` dans un éditeur SQL ouvre la **palette d'actions** (l'usage courant d'abord, le reste sous *Plus*).

## Fonctionnalités

### Écrire du SQL
- **Aide à la saisie contextuelle** : tables après `FROM` / `JOIN`, colonnes après `SELECT` / `WHERE`, colonnes d'`alias.` (sous-requêtes et CTE compris), membres de `package.`, fonctions et modèles de requêtes. Conçue pour les très grosses bases : cache de métadonnées persistant, scan en arrière-plan sur une connexion dédiée, recherche à la frappe directement dans la base.
- **Suggestions de jointures** d'après les clés étrangères, correction rapide d'un `JOIN` sans `ON`.
- **Packages, procédures et fonctions** : les noms sont complétés et, dans un appel `pkg.proc( … )`, les paramètres sont proposés sous forme de binds `:param` (paramètre courant en premier, surcharges gérées, notation nommée disponible).
- **Types Oracle en PL/SQL** : dans les déclarations, paramètres, `RETURN`, `TABLE OF`, `CAST(… AS`, vous obtenez `NUMBER`, `VARCHAR2(n)`, `DATE`…, les types déclarés dans le bloc, `var%TYPE`, `curseur%ROWTYPE`, `TABLE%ROWTYPE`, `table.colonne%TYPE` et vos propres types.
- **Ctrl+clic** sur une table, vue, package, procédure ou fonction : ouvre **Describe Object**.
- **Actions de code** (`Ctrl+Alt+A`) : développer `*`, ajouter le `ON` manquant, formater, optimiser, comparer, corrections « Vouliez-vous dire … ? ».
- **Modèles de requêtes** (intégrés selon la base + les vôtres), **Aller à un objet** (`Ctrl+Alt+G`).

### Exécution et erreurs
- Exécution d'une instruction ou d'un script entier, boîte de paramètres pour les variables de liaison (IN / OUT / IN OUT, REF CURSOR), blocs PL/SQL, `EXEC`, `SHOW ERRORS`.
- **Les erreurs ne passent pas inaperçues** : ligne teintée et message grisé en fin de ligne, soulignement, onglet Problèmes, et bandeau d'état sous les onglets de résultats. Explications courtes (💡) pour les erreurs `ORA-` / `PLS-` / PostgreSQL / MySQL / SQLite courantes, et contrôles instantanés pendant la frappe (parenthèses non équilibrées, `UPDATE` / `DELETE` sans `WHERE`).
- Tableau récapitulatif du script (ligne, durée, lignes, statut), numéros de ligne par instruction dans les messages, clic pour aller à la ligne.
- **Annuler** arrête vraiment l'instruction (et réinitialise la connexion si la base n'obéit pas) ; **délai par défaut 10 min** (`dbexplorer.queryTimeoutSeconds`).
- **Transactions** : bascule auto-commit, boutons **Commit / Rollback** (sur la bonne connexion), bandeau et rappels de modifications en attente, aperçu des lignes touchées par `UPDATE` / `DELETE` avec confirmation, mode **lecture seule** par connexion, étiquette **DEV / TEST / PROD** avec protection renforcée en production.
- **Compilation** des packages / procédures / fonctions / triggers / vues avec positionnement des erreurs dans le source ; filtre des objets invalides et *Tout recompiler*.

### Résultats
- Grille : tri et filtres **exécutés par la base**, colonnes masquables / épinglables / colorées par type, pagination avec **Tout afficher**, **édition** en grille (appliquée en `UPDATE` par clé primaire), surlignage des doublons et **détecteur de doublons** de requête, volet détail avec JSON / XML mis en forme.
- **Lignes liées** : Ctrl+clic sur une clé pour suivre la clé étrangère (lignes parentes / enfants) avec un fil d'Ariane pour revenir.
- Conserve les derniers résultats et **compare deux résultats** ligne à ligne.
- **Export** : Excel (.xlsx), CSV, TSV, JSON, HTML, Markdown, SQL INSERT, XML (en flux, toute taille), INSERT / MERGE Oracle avec ou sans binds.

### Explorer le schéma
- **Schema Browser** avec filtre rapide (texte et types d'objets), objets invalides, regroupement par schéma, indicateurs PK / FK.
- **Describe Objects** (Columns, Indexes, Constraints, Triggers, Data, Script, Grants, Synonyms, Stats / Size, **Referential**, **Used By**) avec **Charger toutes les lignes**.
- **Graphes** : graphe de requête, graphe d'appels des packages / fonctions, **diagramme ER**, lignage (« qui utilise cet objet ? »).
- **Comparaison de schémas** avec script de synchronisation, comparaison de requêtes (texte et résultat).
- **Conseiller d'optimisation** (règles par base, index manquants, analyse du plan), **Explain Plan** coloré avec détection des lectures complètes.
- Convertisseur **Oracle → JOIN ANSI** (`(+)` et jointures par virgules).
- **Historique** (avec recherche, se reconnecte à la base d'origine) et **Favoris**.

## Raccourcis clavier

Choisissez une disposition avec le réglage `dbexplorer.keymap`.

| Action | `standard` (défaut) | `alt` | `toad` |
|---|---|---|---|
| Nouvel éditeur SQL | `Ctrl+Alt+N` | `Alt+Shift+N` | `Ctrl+Alt+N` |
| Exécuter l'instruction | `Ctrl+Alt+Entrée` | `Alt+Entrée` | `F9`, `Ctrl+Entrée` |
| Exécuter le script | `Ctrl+Alt+S` | `Alt+Shift+Entrée` | `F5` |
| Annuler | `Ctrl+Alt+Q` | `Alt+Shift+Q` | `Ctrl+Alt+Q` |
| Plan d'exécution | `Ctrl+Alt+X` | `Alt+Shift+E` | `Ctrl+E` |
| Describe object | `Ctrl+Alt+D` | `Alt+D` | `F4` |
| Types des colonnes de la requête | `Ctrl+Alt+T` | `Alt+Shift+D` | `Ctrl+F9` |
| Aide à la saisie | `Ctrl+Alt+Espace` | `Alt+Shift+Espace` | `Ctrl+Espace` |
| Optimiser | `Ctrl+Alt+O` | `Alt+Shift+O` | `Ctrl+Alt+O` |
| Commenter les lignes | `Ctrl+Alt+C` | `Alt+Shift+C` | `Ctrl+B` |
| Actions de code | `Ctrl+Alt+A` | `Alt+Shift+A` | `Ctrl+Alt+A` |

Toujours disponibles dans un éditeur SQL : `Ctrl+Alt+J` (palette d'actions) et `Ctrl+Alt+G` (aller à un objet).

## Réglages (extrait)

| Réglage | Défaut | Description |
|---|---|---|
| `dbexplorer.queryTimeoutSeconds` | `600` | Délai maximal d'une instruction (0 = illimité) |
| `dbexplorer.pageSize` / `showAllMaxRows` | `500` / `100000` | Lignes par page / limite de **Tout afficher** |
| `dbexplorer.autoCommit` | `false` | Auto-commit des nouvelles connexions |
| `dbexplorer.onScriptError` | `ask` | `ask`, `continue` ou `stop` quand une instruction d'un script échoue |
| `dbexplorer.confirmOnProduction` | `true` | Confirmer avant de modifier une connexion de production |
| `dbexplorer.inlineErrors` / `liveChecks` | `true` | Texte d'erreur dans l'éditeur / contrôles pendant la frappe |
| `dbexplorer.keymap` | `standard` | Disposition des raccourcis |

Tous les réglages sont regroupés par thème dans **Paramètres → Extensions → DB Explorer**.

## Sécurité

- Les mots de passe sont stockés dans le **SecretStorage** de VS Code, jamais dans les réglages ni dans des fichiers.
- Une connexion peut être étiquetée **PROD** (ou colorée en rouge) et mise en **lecture seule**. Les scripts qui modifient une base de production demandent confirmation.
- Rien n'est envoyé ailleurs : l'extension ne parle qu'aux bases que vous configurez.

## Installation

**Depuis un `.vsix`** (téléchargé depuis la page *Releases*) : dans VS Code, **Extensions → … → Installer à partir de VSIX…**, ou

```bash
code --install-extension dbexplorer-<version>.vsix
```

**Depuis les sources :** voir ci-dessous.

## Développement

Prérequis : Node.js 18+ et VS Code 1.85+.

```bash
npm install
npm run compile          # puis F5 dans VS Code pour lancer l'extension
npm test                 # tests rapides (découpage de script, conseils d'erreur, JOIN ANSI, aide à la saisie)
npm run package          # construit dbexplorer-<version>.vsix (npx vsce package)
```

**Tests d'intégration sur de vraies bases** (SQLite toujours ; PostgreSQL et MySQL quand elles tournent) :

```bash
docker compose -f test/docker-compose.yml up -d
npm run test:integration
docker compose -f test/docker-compose.yml down
```

Ils couvrent requêtes, pagination, commit / rollback, erreurs, plan d'exécution, annulation de requête, routines et leurs paramètres.

Organisation : `src/extension.ts` (commandes), `src/runner.ts` (exécution), `src/completion.ts` (aide à la saisie), `src/resultsPanel.ts` (webview des résultats), `src/drivers/` (un fichier par base), `src/views/` (vues de la barre latérale). Textes de l'interface : `src/i18n.ts` + `src/i18nFr.ts` (exécution) et `package.nls*.json` (manifeste).

## Contribuer

Issues et pull requests bienvenues. Lancez `npm test` (et `npm run test:integration` si vous touchez un pilote) avant d'ouvrir une PR, et ajoutez le texte anglais et sa traduction française pour tout nouveau message.

## Limites connues

- SQL Server n'est pas géré. Pas de débogueur PL/SQL, pas de navigateur de sessions.
- Les instructions SQLite ne peuvent pas être interrompues (le moteur est synchrone).
- Les chemins propres à Oracle demandent plus de tests sur de vrais serveurs (voir la note en haut).

## Licence

[MIT](LICENSE)
