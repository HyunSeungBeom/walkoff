// @ts-check
// 판정 결과 비율을 잰다. 화면 없이 판정 규칙(js/core/)만 가져와 돌린다.
// 판정 숫자를 바꾸기 전·후를 견줄 때 쓴다: mkdir -p /tmp/head && git archive HEAD js | tar -x -C /tmp/head && node scripts/outcomes.js /tmp/head/js  와  node scripts/outcomes.js
// 격자: 시드 1~300 × 앞 16구 × 스윙 시각 -90~+90ms(3ms 간격) × 우타·좌타. 상대 투수 손은 시드로 정한다(pitcherHand). --json이면 숫자만 낸다
const path = require('path');
const { pathToFileURL } = require('url');

const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const dir = arg ? path.resolve(arg) : path.join(__dirname, '..', 'js');   // 게임 모듈 폴더(js)

(async () => {
const load = (f) => import(pathToFileURL(path.join(dir, 'core', f)).href);
const [{ judgeSwing }, { makeSequence, pitcherHand }, { PERFECT_BONUS }] = await Promise.all([load('judge.js'), load('pitches.js'), load('score.js')]);
const t = { swings: 0, inPlay: 0, kinds: {}, points: 0, bonus: 0, ground: { all: 0, out: 0, ifh: 0, through: 0, line: 0 }, ifhBy: {}, bats: { R: { ground: 0, ifh: 0 }, L: { ground: 0, ifh: 0 } }, close: 0, margins: [], how: {}, raced: 0 };
for (let seed = 1; seed <= 300; seed++) {
  const seq = makeSequence(seed, pitcherHand(seed) === 'L');
  for (let i = 0; i < 16; i++) for (let dt = -90; dt <= 90; dt += 3) for (const bats of ['R', 'L']) {
    const r = judgeSwing(seq[i], dt, bats);
    t.swings++;
    if (r.kind === 'whiff' || r.kind === 'foul') continue;   // 앞으로 간 타구만 센다
    t.inPlay++;
    t.kinds[r.kind] = (t.kinds[r.kind] || 0) + 1;
    t.points += r.points;
    t.bonus += r.perfect ? PERFECT_BONUS : 0;
    if (r.type !== 'ground') continue;
    t.ground.all++; t.bats[bats].ground++;
    if (r.kind === 'out') t.ground.out++;
    else if (r.infield) { t.ground.ifh++; t.bats[bats].ifh++; const pos = r.fielder ? r.fielder.pos : '?'; t.ifhBy[pos] = (t.ifhBy[pos] || 0) + 1; }
    else if (r.kind === 'double') t.ground.line++;
    else t.ground.through++;
    if (r.race) { t.raced++; const h = r.race.how + (r.race.charge ? '(달려 나옴)' : ''); t.how[h] = (t.how[h] || 0) + 1; }
    if (r.race && Number.isFinite(r.race.margin)) { t.margins.push(r.race.margin); if (Math.abs(r.race.margin) < 0.15) t.close++; }
  }
}

const pct = (a, b) => (b ? (100 * a / b).toFixed(2) : '0.00');
const q = (arr, k) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(k * s.length))].toFixed(3); };
const out = {
  swings: t.swings, inPlay: t.inPlay,
  kinds: Object.fromEntries(Object.entries(t.kinds).map(([k, n]) => [k, +pct(n, t.inPlay)])),
  pointsPerInPlay: +(t.points / t.inPlay).toFixed(1), withPerfectBonus: +((t.points + t.bonus) / t.inPlay).toFixed(1),
  ground: { shareOfInPlay: +pct(t.ground.all, t.inPlay), out: +pct(t.ground.out, t.ground.all), infieldHit: +pct(t.ground.ifh, t.ground.all), through: +pct(t.ground.through, t.ground.all), downTheLine: +pct(t.ground.line, t.ground.all) },
  infieldHitBy: Object.fromEntries(Object.entries(t.ifhBy).map(([k, n]) => [k, +pct(n, t.ground.ifh)])),
  infieldHitByBats: { R: +pct(t.bats.R.ifh, t.bats.R.ground), L: +pct(t.bats.L.ifh, t.bats.L.ground) },
  closeShareOfGround: +pct(t.close, t.ground.all),
  fieldingHow: Object.fromEntries(Object.entries(t.how).sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, +pct(n, t.raced)])),
  margin: { p10: q(t.margins, 0.1), p50: q(t.margins, 0.5), p90: q(t.margins, 0.9) },
};
if (process.argv.includes('--json')) { console.log(JSON.stringify(out)); process.exit(0); }
console.log(`스윙 ${out.swings.toLocaleString()}번 중 앞으로 간 타구 ${out.inPlay.toLocaleString()}개`);
console.log(`결과(타구 중 %): ${Object.entries(out.kinds).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
console.log(`타구당 점수: ${out.pointsPerInPlay}(정타 보너스 포함 ${out.withPerfectBonus})`);
console.log(`땅볼 ${out.ground.shareOfInPlay}% → 아웃 ${out.ground.out}% · 내야 안타 ${out.ground.infieldHit}% · 빠진 안타 ${out.ground.through}% · 선상 2루타 ${out.ground.downTheLine}%`);
if (t.ground.ifh) {
  console.log(`내야 안타 수비수별: ${Object.entries(out.infieldHitBy).map(([k, v]) => `${k} ${v}%`).join(' · ')}`);
  console.log(`내야 안타(땅볼 중): 우타 ${out.infieldHitByBats.R}% · 좌타 ${out.infieldHitByBats.L}%`);
}
if (t.raced) console.log(`잡는 방법(내야 땅볼 중): ${Object.entries(out.fieldingHow).map(([k, v]) => `${k} ${v}%`).join(' · ')}`);
if (t.margins.length) console.log(`1루 접전(0.15초 안): 땅볼의 ${out.closeShareOfGround}% · 차이 p10/p50/p90 ${out.margin.p10}/${out.margin.p50}/${out.margin.p90}초`);
})().catch((e) => { console.error(e); process.exit(1); });
