// 최근 7일 이용 통계를 원격 D1에서 표로 뽑는다: worker 폴더에서 npm run stats
// 첫 표는 날짜별 기기·판 수, 둘째 표는 날짜·모드·입력별 스윙 결과(2026-11-05 조준 타격 실험)
import { spawnSync } from 'node:child_process';
import { STATS_SQL, SWING_SQL } from '../src/stats.js';

for (const sql of [STATS_SQL, SWING_SQL]) {
  const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'walkoff', '--remote', '--command', sql], {
    stdio: 'inherit',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },   // 사용 통계는 보내지 않는다
  });
  if (r.status) process.exit(r.status);
}
