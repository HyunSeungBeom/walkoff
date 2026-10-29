// 최근 7일 이용 통계를 원격 D1에서 표로 뽑는다: worker 폴더에서 npm run stats
import { spawnSync } from 'node:child_process';
import { STATS_SQL } from '../src/stats.js';

const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'walkoff', '--remote', '--command', STATS_SQL], {
  stdio: 'inherit',
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },   // 사용 통계는 보내지 않는다
});
process.exit(r.status ?? 1);
