// Tests rapides (sans VS Code ni base de données) : `npm test`
const Module = require('module');
const orig = Module._load;
Module._load = function (r, ...a) {
  if (r === 'vscode') return new Proxy({}, { get: (_, k) => (k === 'EventEmitter' ? class { constructor() { this.event = () => {}; } fire() {} } : () => ({})) });
  return orig.call(this, r, ...a);
};
const assert = require('assert');
const path = require('path');
const out = (f) => require(path.join(__dirname, '..', 'out', f));
let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log('  ✓', name); } catch (e) { failed++; console.log('  ✗', name, '\n   ', e.message); }
};

(async () => {
  const { split } = out('splitter.js');
  const { analyzeError, closest } = out('errorHints.js');
  const { toAnsiJoins } = out('ansiJoin.js');

  console.log('splitter');
  await test('séparateur ; entre deux instructions', () => assert.strictEqual(split('select 1 from dual;\nselect 2 from dual;', 'oracle').length, 2));
  await test('spécification + corps de package sans / → deux instructions', () => {
    const sql = 'CREATE OR REPLACE PACKAGE p IS\n  PROCEDURE a;\nEND p;\nCREATE OR REPLACE PACKAGE BODY p IS\n  PROCEDURE a IS BEGIN NULL; END;\nEND p;\n';
    assert.strictEqual(split(sql, 'oracle').length, 2);
  });
  await test('bloc PL/SQL terminé par /', () => assert.strictEqual(split('BEGIN\n  NULL;\nEND;\n/\nselect 1 from dual;', 'oracle').length, 2));
  await test('point-virgule dans une chaîne', () => assert.strictEqual(split("select 'a;b' from dual;", 'oracle').length, 1));

  console.log('errorHints');
  await test('ORA-00904 : identifiant et explication', () => {
    const i = analyzeError('ORA-00904: "A"."NOM_CLIENT": invalid identifier');
    assert.deepStrictEqual(i.unknown, { name: 'NOM_CLIENT', what: 'column' });
    assert.ok(i.hint);
  });
  await test('connexion perdue détectée', () => assert.ok(analyzeError('ORA-03113: end-of-file on communication channel').lost));
  await test('erreur ordinaire : connexion non perdue', () => assert.ok(!analyzeError('ORA-00942: table or view does not exist').lost));
  await test('PostgreSQL : colonne inconnue', () => assert.deepStrictEqual(analyzeError('column "nme" does not exist').unknown, { name: 'nme', what: 'column' }));
  await test('closest : faute de frappe', () => assert.strictEqual(closest('NME', ['ID', 'NAME']), 'NAME'));
  await test('closest : rien de plausible', () => assert.strictEqual(closest('zzz', ['ID']), undefined));

  console.log('ansiJoin');
  await test('jointure (+) → LEFT JOIN', async () => {
    const r = await toAnsiJoins('SELECT a.x FROM a, b WHERE a.id = b.id(+)');
    assert.ok(/LEFT\s+(OUTER\s+)?JOIN/i.test(r.sql), r.sql);
  });
  await test('virgules → INNER JOIN', async () => {
    const r = await toAnsiJoins('SELECT a.x FROM a, b WHERE a.id = b.id AND a.y = 1');
    assert.ok(/JOIN/i.test(r.sql) && /a\.y\s*=\s*1/i.test(r.sql), r.sql);
  });

  console.log('dupDetector');
  const { buildDupQueries } = out('dupDetector.js');
  const cols = async (o, t) => (t.toLowerCase() === 'a' ? [{ name: 'ID', pk: true }, { name: 'X', pk: false }] : [{ name: 'ID', pk: true }, { name: 'A_ID', pk: false }]);
  await test('ajoute la clé de chaque table au SELECT', async () => {
    const r = await buildDupQueries('SELECT a.x FROM a JOIN b ON b.a_id = a.id', 'oracle', 'S', cols);
    assert.ok(!r.error && /a\.ID AS A_ID/i.test(r.ids) && /b\.ID AS B_ID/i.test(r.ids), r.error || r.ids);
  });
  await test('UNION refusé avec une raison', async () => {
    const r = await buildDupQueries('SELECT 1 FROM a UNION SELECT 2 FROM b', 'oracle', 'S', cols);
    assert.ok(r.error);
  });

  console.log('routines');
  const { callContext, suggestArgs } = out('routines.js');
  await test('appel pkg.proc( : chaîne et index du paramètre', () => {
    assert.deepStrictEqual(callContext('BEGIN\n  pkg_x.do_it(:a, '), { chain: ['pkg_x', 'do_it'], argIndex: 1 });
  });
  await test('appel imbriqué : le bon niveau de parenthèse', () => {
    assert.deepStrictEqual(callContext("select f(g(1, 2), "), { chain: ['f'], argIndex: 1 });
    assert.deepStrictEqual(callContext('x := pkg.f(g(1,'), { chain: ['g'], argIndex: 1 });
  });
  await test('hors appel : rien', () => assert.strictEqual(callContext('select 1 from dual;'), undefined));
  await test('suggestArgs : paramètre courant en tête, surcharges fusionnées', () => {
    const a = (name, pos, overload) => ({ name, type: 'NUMBER', dir: 'in', pos, overload });
    const r = suggestArgs([a('P_ID', 1, '1'), a('P_NAME', 2, '1'), a('P_ID', 1, '2'), a('P_FLAG', 2, '2'), { name: '', type: 'NUMBER', dir: 'out', pos: 0, isReturn: true }], 1);
    assert.deepStrictEqual(r.first.map((x) => x.name), ['P_NAME', 'P_FLAG']);
    assert.deepStrictEqual(r.full.map((x) => x.name), ['P_ID', 'P_NAME']);
  });

  console.log('plsqlTypes');
  const { expectsType, localDeclarations } = out('plsqlTypes.js');
  const typeCases = [
    ['DECLARE\n  v_name ', 'type'],
    ['DECLARE\n  v_x NUMBER;\n  v_y ', 'type'],
    ['DECLARE\n  v_x NUMBER;\nBEGIN\n  v_x ', undefined],
    ['DECLARE\n  v_x CONSTANT ', 'type'],
    ['CREATE OR REPLACE PROCEDURE p (a IN OUT NOCOPY ', 'type'],
    ['CREATE OR REPLACE PROCEDURE p (a NUMBER, b ', 'type'],
    ['CREATE OR REPLACE FUNCTION f (a NUMBER) RETURN ', 'type'],
    ['CREATE OR REPLACE FUNCTION f (a NUMBER) RETURN NUMBER IS\n  v ', 'type'],
    ['CREATE OR REPLACE PACKAGE p IS\n  g_x ', 'type'],
    ['DECLARE\n  TYPE t IS ', 'typeForm'],
    ['DECLARE\n  TYPE t IS TABLE OF ', 'type'],
    ['DECLARE\n  TYPE r IS RECORD (\n    a NUMBER,\n    b ', 'type'],
    ['DECLARE\n  CURSOR c IS SELECT a ', undefined],
    ['SELECT CAST(x AS ', 'type'],
    ['BEGIN\n  x := CASE WHEN a THEN 1 END;\n  y ', undefined],
    ['BEGIN\n  IF a THEN\n    NULL;\n  END IF;\n  v ', undefined],
    ['DECLARE\n  PROCEDURE q IS\n    w NUMBER;\n  BEGIN\n    NULL;\n  END;\n  z ', 'type'],
    ['select a from ', undefined],
  ];
  for (const [text, kind] of typeCases) await test('type attendu : ' + JSON.stringify(text.slice(-24)) + ' → ' + kind, () => assert.strictEqual(expectsType(text)?.kind, kind));
  await test('déclarations locales : types, curseurs, variables', () => {
    const d = localDeclarations('DECLARE\n TYPE t_tab IS TABLE OF NUMBER;\n CURSOR c_emp IS SELECT 1 FROM dual;\n v_n NUMBER;\n v_name emp.name%TYPE;\n v_t t_tab;\nBEGIN NULL; END;');
    assert.deepStrictEqual([d.types, d.cursors, d.vars], [['t_tab'], ['c_emp'], ['v_n', 'v_name', 'v_t']]);
  });

  console.log('scriptSections');
  const { sectionsOf, classify } = out('scriptSections.js');
  const oraDdl = `CREATE TABLE "S"."T" ("ID" NUMBER NOT NULL ENABLE, CONSTRAINT "PK_T" PRIMARY KEY ("ID") USING INDEX ENABLE);

CREATE INDEX "S"."IDX_T_NAME" ON "S"."T" ("NAME");

ALTER TABLE "S"."T" ADD CONSTRAINT "FK_T_P" FOREIGN KEY ("PID") REFERENCES "S"."P" ("ID") ENABLE;

COMMENT ON TABLE "S"."T" IS 'x';
COMMENT ON COLUMN "S"."T"."ID" IS 'y';

CREATE OR REPLACE TRIGGER "S"."TRG_T" BEFORE INSERT ON "S"."T" FOR EACH ROW
BEGIN
  :NEW.ID := 1;
END;
/

GRANT SELECT ON "S"."T" TO "BOB";
GRANT INSERT ON "S"."T" TO "BOB";

CREATE OR REPLACE PUBLIC SYNONYM "T" FOR "S"."T";`;
  await test('script Oracle découpé : table, index, clé étrangère, commentaires, trigger, droits, synonyme', () => {
    const secs = sectionsOf(oraDdl, 'oracle');
    assert.deepStrictEqual(secs.map((x) => x.kind), ['table', 'index', 'fk', 'comments', 'trigger', 'grants', 'synonym']);
    assert.ok(secs[3].sql.includes('COMMENT ON COLUMN'), 'commentaires regroupés');
    assert.ok(secs[5].sql.includes('GRANT INSERT'), 'droits regroupés');
    assert.ok(/Foreign key.*FK_T_P/.test(secs[2].title) && /IDX_T_NAME/.test(secs[1].title), secs.map((x) => x.title).join(' | '));
  });
  await test('classify : contrainte, vue, séquence', () => {
    assert.strictEqual(classify('ALTER TABLE t ADD CONSTRAINT uq UNIQUE (a)').kind, 'constraint');
    assert.strictEqual(classify('CREATE OR REPLACE VIEW v AS SELECT 1').kind, 'view');
    assert.strictEqual(classify('CREATE SEQUENCE s').kind, 'sequence');
  });

  console.log(`\n${passed} réussi(s), ${failed} échec(s)`);
  process.exit(failed ? 1 : 0);
})();
