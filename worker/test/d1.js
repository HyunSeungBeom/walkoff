// 테스트용 D1. Cloudflare D1과 같은 모양(prepare → bind → first/all/run, batch)으로 Node 내장 SQLite를 감싸고
// schema.sql을 그대로 적용한다. Node 내장 SQLite는 ?1 같은 번호 자리를 못 받아서 서버 SQL은 ?만 쓴다
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export function memoryD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const plain = (row) => (row ? { ...row } : null);
  const statement = (sql, args = []) => ({
    bind: (...a) => statement(sql, a),
    first: async () => plain(db.prepare(sql).get(...args)),
    all: async () => ({ results: db.prepare(sql).all(...args).map(plain) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return {
    prepare: (sql) => statement(sql),
    async batch(list) {   // D1 batch처럼 한 묶음으로 처리하고, 하나라도 실패하면 모두 되돌린다
      db.exec('BEGIN');
      try {
        const out = [];
        for (const s of list) out.push(await s.run());
        db.exec('COMMIT');
        return out;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    rows: (sql, ...args) => db.prepare(sql).all(...args).map(plain),
  };
}
