// 소리: 파일 없이 Web Audio로 합성한다(관중 함성만 녹음 파일 crowd.mp3를 소리를 처음 켤 때 받는다).
// 판 상태를 모르고 main이 때맞춰 부른다(2026-11-04 코드 나누기 3단계에서 main.js에서 옮김)
export const Sound = (() => {
  let ac = null, master = null, noiseBuf = null;
  function init() {
    if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ac = new AC();
    master = ac.createGain(); master.gain.value = 0.7; master.connect(ac.destination);
    noiseBuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    loadCrowd();
  }
  function env(g, t0, attack, dur, peak) {
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  }
  function noise({ dur = 0.1, type = 'bandpass', freq = 2000, freqTo, q = 1, peak = 0.5, attack = 0.002, delay = 0 }) {
    if (!ac) return;
    const t0 = ac.currentTime + delay;
    const src = ac.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
    const f = ac.createBiquadFilter(); f.type = type; f.Q.value = q; f.frequency.setValueAtTime(freq, t0);
    if (freqTo) f.frequency.exponentialRampToValueAtTime(freqTo, t0 + dur);
    const g = ac.createGain(); env(g, t0, attack, dur, peak);
    src.connect(f).connect(g).connect(master);
    src.start(t0, Math.random()); src.stop(t0 + dur + 0.05);
  }
  function tone({ freq = 440, freqTo, dur = 0.1, type = 'sine', peak = 0.3, attack = 0.002, delay = 0 }) {
    if (!ac) return;
    const t0 = ac.currentTime + delay;
    const o = ac.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t0);
    if (freqTo) o.frequency.exponentialRampToValueAtTime(freqTo, t0 + dur);
    const g = ac.createGain(); env(g, t0, attack, dur, peak);
    o.connect(g).connect(master); o.start(t0); o.stop(t0 + dur + 0.05);
  }
  // 8비트 음: 옛 게임기처럼 사각파를 한 크기로 내다가 끝에서만 빨리 줄인다(env는 처음부터 줄어든다)
  const CHIP_GAIN = 0.1;
  function chip(freq, delay, dur, peak) {
    if (!ac) return;
    const t0 = ac.currentTime + delay, o = ac.createOscillator(), g = ac.createGain();
    o.type = 'square'; o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0); g.gain.linearRampToValueAtTime(peak, t0 + 0.003); g.gain.setValueAtTime(peak, t0 + dur * 0.45);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(master); o.start(t0); o.stop(t0 + dur + 0.02);
  }
  // 천둥 '콰광'(2026-11-03 고가 타격음): 번쩍 찢어지는 밝은 잡음과 지지직 갈라지는 소리(콰) → 거센 폭음(광) → 1.3초쯤 우르릉 굴러가며 줄어든다.
  // 낮은 우르릉은 폰 스피커에서 거의 안 들려서 가운데 대역(250~650Hz) 울림도 함께 굴린다. 크기는 폭탄 '쾅'보다 크지 않게 맞췄다
  const RUMBLE = 0.3;
  function thunder(power) {
    if (!ac) return;
    noise({ dur: 0.04, type: 'highpass', freq: 2400, peak: 0.4 + 0.12 * power });
    for (const [d, f, p] of [[0.012, 3800, 0.2], [0.03, 2300, 0.24], [0.052, 3200, 0.18], [0.08, 1800, 0.15], [0.115, 2700, 0.1], [0.16, 2100, 0.07]]) noise({ dur: 0.03, freq: f, q: 1.2, peak: p, delay: d });
    noise({ dur: 0.45, type: 'lowpass', freq: 2800, freqTo: 240, peak: 0.5 + 0.15 * power, attack: 0.005, delay: 0.02 });
    noise({ dur: 0.4, freq: 650, freqTo: 380, q: 1, peak: 0.25, attack: 0.01, delay: 0.03 });
    // 우르릉: 잡음 하나를 낮은 대역과 가운데 대역으로 걸러 커졌다 작아지기를 되풀이하며 줄인다(noise의 env는 처음부터 빨리 줄어 0.1초 만에 사라졌다)
    const t0 = ac.currentTime, src = ac.createBufferSource(), lp = ac.createBiquadFilter(), bp = ac.createBiquadFilter(), mid = ac.createGain(), g = ac.createGain();
    src.buffer = noiseBuf; src.loop = true;
    lp.type = 'lowpass'; lp.frequency.setValueAtTime(700, t0 + 0.1); lp.frequency.exponentialRampToValueAtTime(140, t0 + 1.4);
    bp.type = 'bandpass'; bp.Q.value = 1.1; bp.frequency.setValueAtTime(480, t0 + 0.1); bp.frequency.exponentialRampToValueAtTime(260, t0 + 1.4); mid.gain.value = 1.6;
    g.gain.setValueAtTime(0.0001, t0 + 0.08); g.gain.exponentialRampToValueAtTime(RUMBLE, t0 + 0.2);
    for (const [t, k] of [[0.3, 0.6], [0.42, 0.85], [0.55, 0.45], [0.7, 0.6], [0.86, 0.3], [1.0, 0.38], [1.15, 0.14]]) g.gain.linearRampToValueAtTime(RUMBLE * k, t0 + t);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.4);
    src.connect(lp).connect(g); src.connect(bp).connect(mid).connect(g); g.connect(master);
    src.start(t0 + 0.08, Math.random()); src.stop(t0 + 1.45);
    for (let i = 0; i < 5; i++) noise({ dur: 0.04, freq: 700 + Math.random() * 900, q: 1.5, peak: 0.04 + Math.random() * 0.04, delay: 0.25 + Math.random() * 0.7 });   // 멀리서 지지직
    tone({ freq: 64, freqTo: 34, dur: 1.3, peak: 0.16 + 0.06 * power, attack: 0.03 });   // 좋은 스피커에서만 들리는 낮은 울림
  }
  // 관중 함성(2026-10-30 '홈런 함성' 요청). 합성으로 세 번 만들어 들려 드렸지만 사람 소리처럼 들리지 않아서, 사용자 결정으로
  // 실제 경기장 함성 녹음(crowd.mp3, CC0)을 튼다. 소리를 처음 켤 때 한 번 받아 두고, 못 받으면(오프라인, file://) 아래 합성 함성으로 대신한다.
  // 녹음은 사용자가 후보 넷(메이저리그 홈런, 한국 야구장, 축구장 반응, 박수 섞인 환호) 가운데 고른 축구장 관중 반응이다:
  // freesound.org/s/829453 (itmightgetloud, FC St. Pauli 밀러른토어 경기장, CC0 1.0)의 7~13초를 잘라 앞뒤를 흐리게 하고 크기를 맞춰 mono 96kbps로 줄였다.
  // 크기는 사용자가 "너무 커서 놀랄 것 같다"고 해서 가장 큰 50ms 크기 0.06쯤(나무 '딱'의 절반)으로 맞췄다. level 1 안타(앞 1.8초), 2 홈런, 3 끝내기
  const CROWD_URL = 'crowd.mp3', CROWD_GAIN = 0.37;
  let crowdBuf = null;
  // 오리 '꽥'(2026-11-10): 톱니파(380 → 440 → 250Hz)를 코맹맹이 소리 대역 두 곳(1.1kHz·2.5kHz)으로 거르고, 46Hz로 떨어 목이 갈라진 듯하게 한다.
  // 폰 스피커에서도 들리게 낮은 울림은 넣지 않는다. 세게 칠수록 조금 높고 길다
  function quack(power) {
    if (!ac) return;
    const t0 = ac.currentTime, dur = 0.2 + 0.06 * power, o = ac.createOscillator(), lfo = ac.createOscillator(), depth = ac.createGain(), rasp = ac.createGain(), g = ac.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(380 + 40 * power, t0); o.frequency.linearRampToValueAtTime(440 + 40 * power, t0 + 0.04); o.frequency.exponentialRampToValueAtTime(250, t0 + dur);
    lfo.type = 'triangle'; lfo.frequency.value = 46; depth.gain.value = 0.35; rasp.gain.value = 0.65;
    lfo.connect(depth).connect(rasp.gain);
    env(g, t0, 0.012, dur, 0.9);
    o.connect(rasp);
    for (const [f, q] of [[1100, 4], [2500, 6]]) { const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q; rasp.connect(bp).connect(g); }
    g.connect(master);
    o.start(t0); lfo.start(t0); o.stop(t0 + dur + 0.05); lfo.stop(t0 + dur + 0.05);
  }
  function loadCrowd() {
    fetch(CROWD_URL).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((b) => new Promise((ok, no) => ac.decodeAudioData(b, ok, no)))   // 옛 사파리는 콜백 방식만 된다
      .then((buf) => { crowdBuf = buf; })
      .catch(() => { /* 합성 함성으로 대신한다 */ });
  }
  function roarRecording(level) {
    const t0 = ac.currentTime, src = ac.createBufferSource(), g = ac.createGain();
    src.buffer = crowdBuf; src.playbackRate.value = 0.96 + Math.random() * 0.08;   // 칠 때마다 조금씩 다르게
    const len = crowdBuf.duration / src.playbackRate.value, dur = level === 1 ? Math.min(1.8, len) : len, peak = CROWD_GAIN * [0, 0.5, 1, 1.2][level];
    g.gain.setValueAtTime(peak, t0); g.gain.setValueAtTime(peak, t0 + dur - 0.6); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(g).connect(master); src.start(t0); src.stop(t0 + dur + 0.05);
  }
  // 합성 함성(녹음을 못 받았을 때). 높이가 다른 목소리 수십 개(톱니파)와 숨소리·웅성임(잡음)을 모음 울림(포먼트) 셋으로 거르는데,
  // 울림이 '우'에서 '아'로 열려 '와'가 되고 끝에 조금 닫힌다. 경기장 울림(잔향)을 입히고 휘파람과 박수를 흩뿌린다
  const ROAR = { voice: 0.035, breath: 0.5, gain: 1.7 };
  function swell(param, t0, peak, attack, dur) {
    param.setValueAtTime(0.0001, t0);
    param.exponentialRampToValueAtTime(peak, t0 + attack);
    param.linearRampToValueAtTime(peak * 0.7, t0 + dur * 0.6);
    param.exponentialRampToValueAtTime(0.0001, t0 + dur);
  }
  let hall = null;
  function stadium() {   // 경기장 울림: 1.8초 동안 사그라드는 잡음을 잔향으로 쓴다(처음 부를 때 한 번 만든다)
    if (hall) return hall;
    const len = Math.floor(ac.sampleRate * 1.8), ir = ac.createBuffer(2, len, ac.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3); }
    hall = ac.createConvolver(); hall.buffer = ir;
    const wet = ac.createGain(); wet.gain.value = 0.3;
    hall.connect(wet).connect(master);
    return hall;
  }
  function roar(level = 2) {
    if (!ac) return;
    if (crowdBuf) { roarRecording(level); return; }
    const t0 = ac.currentTime, dur = [0, 2, 4, 4.8][level], k = [0, 0.45, 1, 1.15][level], end = t0 + dur;
    const bus = ac.createGain(), out = ac.createGain();
    swell(out.gain, t0, k * ROAR.gain, 0.35, dur);
    out.connect(master); out.connect(stadium());
    for (const [f, q, g, from] of [[800, 4, 1, 350], [1200, 5, 0.6, 750], [2600, 6, 0.25, 2200]]) {   // 모음 울림: '우'→'아'로 열린다
      const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = q;
      bp.frequency.setValueAtTime(from, t0); bp.frequency.exponentialRampToValueAtTime(f, t0 + 0.3);
      bp.frequency.setValueAtTime(f, t0 + dur * 0.7); bp.frequency.exponentialRampToValueAtTime(f * 0.8, end);
      const gn = ac.createGain(); gn.gain.value = g;
      bus.connect(bp).connect(gn).connect(out);
    }
    const shakes = [4.6, 5.4, 6.3].map((hz) => {   // 목소리 떨림(30센트). 목소리마다 만들지 않고 셋을 나눠 쓴다
      const lfo = ac.createOscillator(), depth = ac.createGain();
      lfo.frequency.value = hz; depth.gain.value = 30; lfo.connect(depth); lfo.start(t0); lfo.stop(end + 0.1);
      return depth;
    });
    for (let i = 0, n = [0, 14, 30, 36][level]; i < n; i++) {
      const o = ac.createOscillator(), g = ac.createGain(), base = 110 + Math.random() * 240, s = t0 + Math.random() * 0.25, e = end - Math.random() * dur * 0.2;
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(base * 0.85, s);
      o.frequency.exponentialRampToValueAtTime(base * (1.15 + Math.random() * 0.2), s + 0.3);   // '와' 하고 올라간다
      o.frequency.exponentialRampToValueAtTime(base * (1.02 + Math.random() * 0.1), e - 0.4);
      o.frequency.exponentialRampToValueAtTime(base * 0.8, e);   // 끝에 '아~' 하고 내려온다
      shakes[i % 3].connect(o.detune);
      g.gain.setValueAtTime(0.0001, s); g.gain.exponentialRampToValueAtTime(ROAR.voice, s + 0.15);
      for (let t = s + 0.5; t < e - 0.5; t += 0.4 + Math.random() * 0.3) g.gain.linearRampToValueAtTime(ROAR.voice * (0.5 + Math.random() * 0.5), t);   // 저마다 커졌다 작아진다
      g.gain.exponentialRampToValueAtTime(0.0001, e);
      o.connect(g).connect(bus); o.start(s); o.stop(e + 0.05);
    }
    const src = ac.createBufferSource(), ng = ac.createGain();   // 숨소리·웅성임
    src.buffer = noiseBuf; src.loop = true; ng.gain.value = ROAR.breath;
    src.connect(ng).connect(bus); src.start(t0, Math.random()); src.stop(end + 0.05);
    for (let i = 0; i < [0, 0, 3, 5][level]; i++) {   // 휘파람: 올라가는 '휘익', 반쯤은 내려오는 소리가 이어진다
      const d = 0.4 + Math.random() * 1.4, f0 = 1700 + Math.random() * 700;
      tone({ freq: f0, freqTo: f0 * 1.35, dur: 0.22, peak: 0.07, attack: 0.03, delay: d });
      if (Math.random() < 0.5) tone({ freq: f0 * 1.3, freqTo: f0 * 0.85, dur: 0.35, peak: 0.06, attack: 0.03, delay: d + 0.26 });
    }
    for (let i = 0; i < [0, 20, 50, 80][level]; i++) {   // 박수(한 번에 소리 마디를 수백 개 만들면 느린 폰에서 끊길 수 있어 이 정도로 둔다)
      noise({ dur: 0.025, freq: 1100 + Math.random() * 1600, q: 1.2, peak: (0.06 + Math.random() * 0.1) * k, delay: 0.25 + Math.random() * dur * 0.75 });
    }
  }
  return {
    init,
    crack(power, style = 'sound-wood') {   // 딱. power 0~1. style은 상점의 타격음
      if (style === 'sound-metal') {   // 알루미늄 '깡': 높은 음이 길게 울린다
        noise({ dur: 0.04, freq: 4200, q: 1.4, peak: 0.45 + 0.3 * power });
        tone({ freq: 2350, freqTo: 2050, dur: 0.45 + 0.25 * power, type: 'triangle', peak: 0.22 + 0.15 * power });
        tone({ freq: 3480, freqTo: 3300, dur: 0.3, peak: 0.1 });
        return;
      }
      if (style === 'sound-toy') {   // 장난감 '뿅'
        tone({ freq: 420, freqTo: 1500, dur: 0.16, type: 'square', peak: 0.16 });
        tone({ freq: 840, freqTo: 3000, dur: 0.12, peak: 0.08, delay: 0.02 });
        return;
      }
      if (style === 'sound-bomb') {   // 폭탄 '쾅': 터지는 소리 + 낮게 울리는 폭음 + 흩어지는 파편. 폰 스피커는 낮은 소리를 거의 못 내서 가운데 대역 울림을 더한다
        noise({ dur: 0.05, freq: 3200, q: 0.7, peak: 0.35 + 0.15 * power });
        noise({ dur: 1.1, type: 'lowpass', freq: 1600, freqTo: 110, peak: 0.6 + 0.2 * power, attack: 0.004 });
        noise({ dur: 0.6, freq: 550, q: 0.8, peak: 0.35, attack: 0.004 });
        tone({ freq: 95, freqTo: 30, dur: 0.75, peak: 0.45 + 0.15 * power });
        for (let i = 0; i < 7; i++) noise({ dur: 0.03, freq: 1500 + Math.random() * 2500, q: 2, peak: 0.05 + Math.random() * 0.07, delay: 0.1 + Math.random() * 0.45 });
        return;
      }
      if (style === 'sound-laser') {   // 레이저 '퓽': 높은 음이 빠르게 떨어진다
        tone({ freq: 1900, freqTo: 170, dur: 0.28, type: 'sawtooth', peak: 0.32 });
        tone({ freq: 2500, freqTo: 230, dur: 0.22, type: 'square', peak: 0.12, delay: 0.015 });
        return;
      }
      if (style === 'sound-bell') {   // 종 '댕': 서로 어긋난 배음이 길게 울린다
        noise({ dur: 0.03, freq: 5200, q: 1, peak: 0.15 });
        tone({ freq: 523, dur: 1.5, peak: 0.26 });
        tone({ freq: 1306, dur: 1.0, peak: 0.13 });
        tone({ freq: 2210, dur: 0.6, peak: 0.08 });
        tone({ freq: 3140, dur: 0.3, peak: 0.05 });
        return;
      }
      if (style === 'sound-drum') {   // 북 '둥'. 낮은 울림은 폰에서 잘 안 들려서 가죽 울림(330Hz)과 채 소리를 함께 낸다
        tone({ freq: 165, freqTo: 55, dur: 0.45, peak: 0.55 + 0.2 * power });
        tone({ freq: 330, freqTo: 150, dur: 0.25, type: 'triangle', peak: 0.3 });
        noise({ dur: 0.08, type: 'lowpass', freq: 900, peak: 0.3 });
        noise({ dur: 0.02, freq: 1800, q: 1.2, peak: 0.2 });
        return;
      }
      if (style === 'sound-thunder') { thunder(power); return; }
      if (style === 'sound-duck') { quack(power); return; }
      if (style === 'sound-8bit') {   // 8비트 '띠링': 옛 게임기 동전 소리(사각파 B5 → E6). 세게 칠수록 한 음씩 높게(온음 하나까지)
        const k = Math.pow(2, Math.round(power * 2) / 12);
        chip(988 * k, 0, 0.065, CHIP_GAIN);
        chip(1319 * k, 0.065, 0.24, CHIP_GAIN);
        return;
      }
      noise({ dur: 0.07 + 0.05 * power, freq: 2600, q: 0.9, peak: 0.5 + 0.5 * power });
      tone({ freq: 1500, freqTo: 700, dur: 0.05, type: 'triangle', peak: 0.25 + 0.2 * power });
      tone({ freq: 180, freqTo: 70, dur: 0.14, peak: 0.25 + 0.45 * power });
    },
    foul() { noise({ dur: 0.05, freq: 1400, q: 1.5, peak: 0.35 }); tone({ freq: 600, freqTo: 400, dur: 0.04, type: 'triangle', peak: 0.12 }); },
    whoosh() { noise({ dur: 0.22, freq: 300, freqTo: 1600, q: 1.2, peak: 0.22, attack: 0.05 }); },
    mitt() { noise({ dur: 0.08, type: 'lowpass', freq: 700, peak: 0.6 }); tone({ freq: 120, freqTo: 80, dur: 0.09, peak: 0.35 }); },
    release() { noise({ dur: 0.15, type: 'highpass', freq: 2500, peak: 0.05, attack: 0.03 }); },
    roar,
    crowdReady: () => crowdBuf != null,

    ding() { tone({ freq: 880, dur: 0.12, peak: 0.15 }); tone({ freq: 1320, dur: 0.18, peak: 0.12, delay: 0.08 }); },
    tick() { tone({ freq: 1400, dur: 0.035, type: 'square', peak: 0.06 }); },
    groan() { noise({ dur: 0.6, type: 'lowpass', freq: 500, peak: 0.12, attack: 0.15 }); },
  };
})();
