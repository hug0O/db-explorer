// Tests d'intégration sur de vraies bases : SQLite (toujours), PostgreSQL et MySQL (si les conteneurs de test/docker-compose.yml tournent).
// Usage : docker compose -f test/docker-compose.yml up -d  puis  npm run test:integration
const Module = require('module');
const orig = Module._load;
Module._load = function (r, ...a) {
  if (r === 'vscode') return new Proxy({}, { get: (_, k) => (k === 'EventEmitter' ? class { constructor() { this.event = () => {}; } fire() {} } : () => ({})) });
  return orig.call(this, r, ...a);
};
const assert = require('assert');
const path = require('path');
const net = require('net');
const { connectDb } = require(path.join(__dirname, '..', 'out', 'drivers', 'index.js'));
const { analyzeError } = require(path.join(__dirname, '..', 'out', 'errorHints.js'));

const OPTS = { dateFormat: 'YYYY-MM-DD HH24:MI:SS', timestampFormat: 'YYYY-MM-DD HH24:MI:SS.FF3' };
const targets = [
  { name: 'SQLite', profile: { id: 's', name: 's', type: 'sqlite' }, pw: '', sleep: null },
  { name: 'PostgreSQL', profile: { id: 'p', name: 'p', type: 'postgres', host: '127.0.0.1', port: 55432, database: 'test', user: 'postgres' }, pw: 'test', sleep: 'SELECT pg_sleep(8)' },
  { name: 'MySQL', profile: { id: 'm', name: 'm', type: 'mysql', host: '127.0.0.1', port: 53306, database: 'test', user: 'root' }, pw: 'test', sleep: 'SELECT SLEEP(8)' },
];
const up = (port) => new Promise((res) => { const s = net.connect(port, '127.0.0.1'); s.on('connect', () => { s.destroy(); res(true); }); s.on('error', () => res(false)); });
const retry = async (fn, n = 40) => { for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= n) throw e; await new Promise((r) => setTimeout(r, 1500)); } } };
let passed = 0, failed = 0, skipped = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('    ✓', name); } catch (e) { failed++; console.log('    ✗', name, '\n       ', String(e.message).split('\n')[0]); } };
const rowsOf = async (conn, sql, n = 100) => { const rs = await conn.open(sql, {}); const r = await rs.getRows(n); await rs.close(); return r; };

(async () => {
  for (const t of targets) {
    console.log('\n' + t.name);
    if (t.profile.port && !(await up(t.profile.port))) { skipped++; console.log('    (non démarré — ignoré)'); continue; }
    let conn;
    try { conn = await retry(() => connectDb(t.profile, t.pw, OPTS), t.profile.port ? 40 : 0); } catch (e) { failed++; console.log('    ✗ connexion :', e.message); continue; }
    const T = 'dbx_it_t';
    await conn.exec(`DROP TABLE IF EXISTS ${T}`, {}, true).catch(() => {});
    await test('CREATE TABLE + INSERT', async () => {
      await conn.exec(`CREATE TABLE ${T} (id INTEGER PRIMARY KEY, name VARCHAR(50))`, {}, true);
      for (const [i, n] of [[1, 'a'], [2, 'b'], [3, 'c']]) await conn.exec(`INSERT INTO ${T} (id, name) VALUES (${i}, '${n}')`, {}, true);
    });
    await test('SELECT paginé (2 puis 1 ligne)', async () => {
      const rs = await conn.open(`SELECT id, name FROM ${T} ORDER BY id`, {});
      assert.strictEqual(rs.columns.length, 2);
      assert.strictEqual((await rs.getRows(2)).length, 2);
      assert.strictEqual((await rs.getRows(2)).length, 1);
      await rs.close();
    });
    await test('liste des colonnes avec clé primaire', async () => {
      const cols = await conn.columns(conn.currentSchema, T);
      assert.ok(cols.some((c) => /^id$/i.test(c.NAME) && c.PK), JSON.stringify(cols.map((c) => [c.NAME, c.PK])));
    });
    await test('rollback annule une insertion', async () => {
      await conn.exec(`INSERT INTO ${T} (id, name) VALUES (99, 'z')`, {}, false);
      await conn.rollback();
      assert.strictEqual((await rowsOf(conn, `SELECT id FROM ${T} WHERE id = 99`)).length, 0);
    });
    await test('commit conserve une insertion', async () => {
      await conn.exec(`INSERT INTO ${T} (id, name) VALUES (50, 'k')`, {}, false);
      await conn.commit();
      assert.strictEqual((await rowsOf(conn, `SELECT id FROM ${T} WHERE id = 50`)).length, 1);
    });
    await test('erreur : table inconnue → nom extrait par analyzeError', async () => {
      let msg = '';
      try { await rowsOf(conn, 'SELECT * FROM table_qui_nexiste_pas'); } catch (e) { msg = e.message; }
      assert.ok(msg, 'aucune erreur levée');
      const info = analyzeError(msg);
      assert.ok(info.unknown && /table_qui_nexiste_pas/i.test(info.unknown.name), msg);
    });
    await test('erreur : colonne inconnue', async () => {
      let msg = '';
      try { await rowsOf(conn, `SELECT nme FROM ${T}`); } catch (e) { msg = e.message; }
      const info = analyzeError(msg);
      assert.ok(info.unknown && /nme/i.test(info.unknown.name) && info.unknown.what === 'column', msg);
    });
    await test('explain renvoie un plan', async () => {
      const plan = await conn.explain(`SELECT * FROM ${T} WHERE id = 1`, {});
      assert.ok(typeof plan === 'string' && plan.length > 5);
    });
    if (t.sleep) {
      await test('annulation d\'une requête longue (< 4 s)', async () => {
        const started = Date.now();
        const run = rowsOf(conn, t.sleep).then(() => 'done', (e) => 'error:' + e.message);
        await new Promise((r) => setTimeout(r, 600));
        await conn.cancel();
        await run;
        assert.ok(Date.now() - started < 4000, 'durée ' + (Date.now() - started) + ' ms');
      });
      await test('la connexion reste utilisable après annulation', async () => {
        assert.strictEqual((await rowsOf(conn, `SELECT id FROM ${T} WHERE id = 1`)).length, 1);
      });
    }
    await test('Describe › Data : 200 premières lignes puis chargement complet', async () => {
      const { dataContent } = require(path.join(__dirname, '..', 'out', 'objectTabs.js'));
      for (let i = 1000; i < 1450; i++) await conn.exec(`INSERT INTO ${T} (id, name) VALUES (${i}, 'n${i}')`, {}, false);
      await conn.commit();
      const first = await dataContent(conn, `SELECT * FROM ${T}`, conn.currentSchema);
      assert.strictEqual(first.rows.length, 200);
      assert.strictEqual(first.more, true);
      const all = await dataContent(conn, `SELECT * FROM ${T}`, conn.currentSchema, undefined, 100000);
      assert.ok(all.rows.length >= 450 && all.more === false, all.rows.length + ' / ' + all.more);
      const capped = await dataContent(conn, `SELECT * FROM ${T}`, conn.currentSchema, undefined, 300);
      assert.ok(capped.rows.length === 300 && capped.more === true);
    });
    await test('Describe › Script : table, index et clé étrangère en blocs séparés', async () => {
      const { scriptContent } = require(path.join(__dirname, '..', 'out', 'objectTabs.js'));
      const P = 'dbx_it_parent', C = 'dbx_it_child';
      for (const x of [C, P]) await conn.exec(`DROP TABLE IF EXISTS ${x}`, {}, true).catch(() => {});
      await conn.exec(`CREATE TABLE ${P} (id INTEGER PRIMARY KEY, name VARCHAR(20))`, {}, true);
      await conn.exec(`CREATE TABLE ${C} (id INTEGER PRIMARY KEY, parent_id INTEGER, label VARCHAR(20), CONSTRAINT fk_dbx_child FOREIGN KEY (parent_id) REFERENCES ${P} (id))`, {}, true);
      await conn.exec(`CREATE INDEX idx_dbx_child_label ON ${C} (label)`, {}, true);
      const r = await scriptContent(conn, { type: 'TABLE', schema: conn.currentSchema, name: C });
      const kinds = (r.sections || []).map((s) => s.kind);
      assert.ok(kinds.includes('table'), kinds.join(','));
      assert.ok(kinds.includes('index'), 'index séparé : ' + kinds.join(','));
      if (conn.kind !== 'sqlite') {
        assert.ok(kinds.includes('fk'), 'clé étrangère séparée : ' + kinds.join(','));
        const table = r.sections.find((s) => s.kind === 'table').sql;
        assert.ok(!/FOREIGN KEY/i.test(table), 'la clé étrangère ne doit plus figurer dans CREATE TABLE : ' + table);
      }
      for (const x of [C, P]) await conn.exec(`DROP TABLE IF EXISTS ${x}`, {}, true).catch(() => {});
    });
    if (t.profile.type !== 'oracle') {
      await test('Ctrl+clic : liens de clé étrangère trouvés sans scan préalable du schéma', async () => {
        const { MetaCache } = require(path.join(__dirname, '..', 'out', 'metaCache.js'));
        const { keyFlags } = require(path.join(__dirname, '..', 'out', 'keyFlags.js'));
        const P = 'dbx_it_lp', C = 'dbx_it_lc';
        for (const x of [C, P]) await conn.exec(`DROP TABLE IF EXISTS ${x}`, {}, true).catch(() => {});
        await conn.exec(`CREATE TABLE ${P} (id INTEGER PRIMARY KEY, name VARCHAR(20))`, {}, true);
        await conn.exec(`CREATE TABLE ${C} (id INTEGER PRIMARY KEY, parent_id INTEGER, CONSTRAINT fk_dbx_lc FOREIGN KEY (parent_id) REFERENCES ${P} (id))`, {}, true);
        await conn.exec(`INSERT INTO ${P} (id, name) VALUES (1, 'p')`, {}, true);
        await conn.exec(`INSERT INTO ${C} (id, parent_id) VALUES (1, 1)`, {}, true);
        const mgr = { isConnected: () => true, session: () => ({ busy: false, conn }), auxConn: async () => conn, get: () => ({ name: 'x' }) };
        const cache = new MetaCache({ globalStorageUri: { fsPath: require('os').tmpdir() + '/dbx-it-meta' } }, mgr);
        const rs = await conn.open(`SELECT * FROM ${C}`, {});
        await rs.getRows(10);
        await rs.close(); // même connexion que l'aide aux métadonnées dans ce test : curseur fermé avant
        const info = await keyFlags(cache, 'p', conn.currentSchema, `SELECT * FROM ${C}`, rs.columns);
        const i = rs.columns.findIndex((c) => /^parent_id$/i.test(c.name));
        assert.ok(info.links[i].some((l) => l.k === 'p' && l.t.toLowerCase() === P), 'lien vers la table parente (colonne parent_id) : ' + JSON.stringify(info.links));
        assert.ok(/F/.test(info.flags[i]), 'indicateur FK : ' + info.flags.join(','));
        // et dans l'autre sens : la table parente propose ses lignes enfants
        const rs2 = await conn.open(`SELECT * FROM ${P}`, {});
        await rs2.getRows(10);
        await rs2.close();
        const info2 = await keyFlags(cache, 'p', conn.currentSchema, `SELECT * FROM ${P}`, rs2.columns);
        assert.ok(info2.links[0].some((l) => l.k === 'c' && l.t.toLowerCase() === C), 'lignes enfants : ' + JSON.stringify(info2.links));
        for (const x of [C, P]) await conn.exec(`DROP TABLE IF EXISTS ${x}`, {}, true).catch(() => {});
      });
    }
    if (t.profile.type !== 'sqlite') {
      await test('routines : procédure et fonction listées avec leurs paramètres', async () => {
        const pg = t.profile.type === 'postgres';
        await conn.exec(`DROP FUNCTION IF EXISTS dbx_it_fn`, {}, true).catch(() => {});
        await conn.exec(`DROP PROCEDURE IF EXISTS dbx_it_pr`, {}, true).catch(() => {});
        if (pg) {
          await conn.exec(`CREATE FUNCTION dbx_it_fn(p_id integer, p_name text) RETURNS integer LANGUAGE sql AS 'SELECT p_id'`, {}, true);
          await conn.exec(`CREATE PROCEDURE dbx_it_pr(p_a integer, INOUT p_b integer) LANGUAGE plpgsql AS $$ BEGIN NULL; END $$`, {}, true);
        } else {
          await conn.exec(`CREATE FUNCTION dbx_it_fn(p_id INT, p_name VARCHAR(20)) RETURNS INT DETERMINISTIC RETURN p_id`, {}, true);
          await conn.exec(`CREATE PROCEDURE dbx_it_pr(IN p_a INT, INOUT p_b INT) BEGIN END`, {}, true);
        }
        const list = await conn.routines(conn.currentSchema);
        assert.ok(list.some((r) => r.name === 'dbx_it_fn' && r.type === 'FUNCTION'), JSON.stringify(list.slice(0, 5)));
        assert.ok(list.some((r) => r.name === 'dbx_it_pr' && r.type === 'PROCEDURE'));
        const fa = (await conn.routineArgs(conn.currentSchema, undefined, 'dbx_it_fn')).filter((a) => !a.isReturn && a.name);
        assert.deepStrictEqual(fa.map((a) => a.name), ['p_id', 'p_name']);
        const pa = (await conn.routineArgs(conn.currentSchema, undefined, 'dbx_it_pr')).filter((a) => a.name);
        assert.deepStrictEqual(pa.map((a) => a.dir), ['in', 'inout']);
        await conn.exec(`DROP FUNCTION dbx_it_fn`, {}, true).catch(() => {});
        await conn.exec(`DROP PROCEDURE dbx_it_pr`, {}, true).catch(() => {});
      });
    }
    await conn.exec(`DROP TABLE IF EXISTS ${T}`, {}, true).catch(() => {});
    await conn.close();
  }
  console.log(`\n${passed} réussi(s), ${failed} échec(s), ${skipped} base(s) ignorée(s)`);
  process.exit(failed ? 1 : 0);
})();
