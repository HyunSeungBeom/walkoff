// 경기장 치수: 공을 놓는 곳, 스트라이크 존, 담장 거리, 베이스·마운드, 수비 위치, 페어 각도(단위 m, 각도는 도)
// 좌표: x는 오른쪽(1루 쪽), y는 위, z는 투수 쪽. 홈플레이트 앞 끝이 z = 0
import { clamp, polar } from './math.js';

export const RELEASE = { x: -0.55, y: 1.75, z: 17.0 };                    // 우투수가 공을 놓는 곳
export const ZONE = { left: -0.25, right: 0.25, bottom: 0.5, top: 1.1 };   // 공 반지름까지 넣은 스트라이크 존
export const BALL_R = 0.037;

// 외야 담장: 파울라인 쪽 100m, 가운데 122m. spray는 타구 방향(도), 음수가 3루 쪽
export const fenceDist = (spray) => 100 + 22 * Math.cos(clamp(spray, -45, 45) * 2 * Math.PI / 180);
export const INFIELDERS = [
  { pos: '3루수', a: -33, d: 32 }, { pos: '유격수', a: -13, d: 40 },
  { pos: '2루수', a: 13, d: 40 }, { pos: '1루수', a: 33, d: 32 }, { pos: '투수', a: 0, d: 18 },
];
export const OUTFIELDERS = [
  { pos: '좌익수', a: -28, d: 86 }, { pos: '중견수', a: 0, d: 95 }, { pos: '우익수', a: 28, d: 86 },
];

export const MOUND = 18.44, BASE1 = polar(45, 27.43), BASE2 = [0, 38.8], BASE3 = polar(-45, 27.43);
// 페어 타구를 그리고 수비를 움직일 때는 방향을 파울선 안쪽(±43°)으로 자른다. spray가 ±60°까지 나와 페어 땅볼이 파울 지역에 그려졌다. 판정은 그대로
export const FAIR_SPRAY = 43;

export function nearest(list, spray) {
  return list.reduce((best, f) => (Math.abs(f.a - spray) < Math.abs(best.a - spray) ? f : best));
}

export const fieldHome = (f) => (f.pos === '투수' ? [0, MOUND - 1.5] : polar(f.a, f.d));   // 투수는 공을 던진 뒤 마운드 앞 수비 자세 자리
