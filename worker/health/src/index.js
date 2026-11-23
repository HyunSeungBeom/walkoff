// 상태 알림 Worker walkoff-health(2026-11-20 사용자 'Cloudflare 예약 실행', 작업 글 walkoff-health-cron.md). 주소 없이 wrangler.toml의 cron(5분마다)으로만 돈다.
// 지난 상태는 KV STATE의 'state' 한 덩어리(바뀐 바퀴에만 쓴다), 메일은 Email Routing send_email(MAIL)로 Verified인 받는 주소(비밀값 ALERT_TO)에만 간다
import { EmailMessage } from 'cloudflare:email';
import { opener } from './checks.js';
import { FROM, round } from './watch.js';
import { hideMail, rawMail } from './mail.js';

const KEY = 'state';

export default {
  async scheduled(_controller, env) {
    // KV가 안 되면 지난 상태 없이 본다(장애 메일이 겹칠 수는 있어도 빠지지 않게)
    const prev = await env.STATE.get(KEY, 'json').catch((e) => { console.error(`지난 상태를 못 읽었다 ${hideMail(e?.message ?? e)}`); return null; });
    const to = env.ALERT_TO?.trim();
    const { next, changed, results, sent, failed } = await round({
      prev: prev && typeof prev === 'object' ? prev : {},
      test: env.ALERT_TEST === '1',
      now: Date.now,
      get: opener((url, init) => fetch(url, init)),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      send: async ({ subject, text }) => {
        if (!to) throw new Error('받는 주소(비밀값 ALERT_TO)가 없다');
        await env.MAIL.send(new EmailMessage(FROM, to, rawMail({ from: FROM, fromName: 'walkoff 상태 알림', to, subject, text })));
      },
    });
    if (changed) await env.STATE.put(KEY, JSON.stringify(next)).catch((e) => console.error(`상태를 못 썼다 ${hideMail(e?.message ?? e)}`));
    console.log(results.filter((r) => r.key !== 'test' || !r.ok).map((r) => `${r.ok ? '✓' : '✗'} ${r.name} ${r.note}`).join(' · ') + (sent.length ? ` · 메일: ${sent.join(', ')}` : ''));
    for (const f of failed) console.error(`메일을 못 보냈다 ${hideMail(f)}`);
  },
};
