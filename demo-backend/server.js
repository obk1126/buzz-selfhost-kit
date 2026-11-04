#!/usr/bin/env node
// axdemo-bridge v2 — 멀티에이전트 워크스페이스 데모 백엔드. 의존성 0.
// 채널: dm(안내), lounge(에이전트끼리 대화), review(작성→검증→수정 파이프라인, 자유 주제)
const http = require('http');
const { execFile } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');

const DIR = __dirname;
const CFG = JSON.parse(fs.readFileSync(DIR + '/config.json', 'utf8'));
const OPENCLAW = '/root/.nvm/versions/node/v24.16.0/bin/openclaw';
const STATE_P = DIR + '/state.json';
const ORIGINS = new Set(CFG.origins);

let state = { day: '', chat: 0, thread: 0, sessions: {}, badAuth: {} };
try { state = Object.assign(state, JSON.parse(fs.readFileSync(STATE_P, 'utf8'))) } catch (e) {}
const today = () => new Date().toISOString().slice(0, 10);
function roll() { if (state.day !== today()) { state = { day: today(), chat: 0, thread: 0, sessions: {}, badAuth: {} }; save(); } }
function save() { fs.writeFileSync(STATE_P, JSON.stringify(state)); }

let q = Promise.resolve(); // 직렬 큐 — 게이트웨이 동시 1턴
function agentTurn(agent, sessionKey, msg) {
  const run = () => new Promise((res) => {
    execFile(OPENCLAW, ['agent', '--agent', agent, '--session-key', sessionKey, '-m', msg, '--json'],
      { timeout: 240000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        try {
          const d = JSON.parse(stdout);
          const t = ((d.result || {}).payloads || []).map(p => p.text).filter(Boolean).join('\n\n');
          res(t || (d.error && d.error.message) || '(응답이 비어 있습니다)');
        } catch (e) { res('(에이전트 호출이 실패했습니다 — 잠시 후 다시 시도해 주세요)'); }
      });
  });
  const p = q.then(run, run); q = p; return p;
}

const threads = {}; // id -> {status, steps:[{agent,text}], kind}
const clean = s => String(s || '').replace(/\s+/g, ' ').slice(0, 300).trim();

async function runThread(id, kind, userMsg, sid) {
  const c = threads[id];
  try {
    if (kind === 'review') {
      const draft = await agentTurn('axdemo', `agent:axdemo:rv-${sid}`,
        `[역할: 작성 담당 "나루". 검증 파이프라인 채널] 방문자가 과제를 투입했다: "${userMsg}"\n이 과제의 초안을 작성하라. 12줄 이내, 실무 톤. 인사말 없이 산출물만.`);
      c.steps.push({ agent: 'naru', text: draft });
      const crit = await agentTurn('axcritic', `agent:axcritic:rv-${sid}`,
        `다음 초안을 검증하라:\n\n${draft}`);
      c.steps.push({ agent: 'gyeol', text: crit });
      const fin = await agentTurn('axdemo', `agent:axdemo:rv-${sid}`,
        `검증 담당 "결"의 지적:\n${crit}\n\n지적을 반영해 최종본을 다시 작성하라. 인사말 없이 산출물만.`);
      c.steps.push({ agent: 'naru', text: fin });
    } else { // lounge — 에이전트끼리 대화
      const a1 = await agentTurn('axdemo', `agent:axdemo:lg-${sid}`,
        `[역할: 크루 라운지의 "나루"(안내·문서 담당). 동료 "결"(검증 담당)과 같은 채널에 있다]\n방문자 메시지: "${userMsg}"\n방문자에게 간결히(2~4문장) 답하고, 마지막 한 문장으로 결에게 이 주제에 대한 의견이나 검증 관점을 물어라.`);
      c.steps.push({ agent: 'naru', text: a1 });
      const a2 = await agentTurn('axcritic', `agent:axcritic:lg-${sid}`,
        `[역할: 크루 라운지의 "결"(검증 담당). 동료 "나루"가 방금 너를 불렀다]\n방문자 메시지: "${userMsg}"\n나루의 말: "${a1}"\n검증 담당답게 날카롭지만 짧게(2~3문장) 답하라. 이번만은 지적 3개 형식 말고 자연스러운 대화체로. 빈틈이나 주의점 하나를 꼭 짚어라.`);
      c.steps.push({ agent: 'gyeol', text: a2 });
      const a3 = await agentTurn('axdemo', `agent:axdemo:lg-${sid}`,
        `결의 답: "${a2}"\n방문자에게 한두 문장으로 정리해 마무리하라. 과장 없이.`);
      c.steps.push({ agent: 'naru', text: a3 });
    }
    c.status = 'done';
  } catch (e) { c.status = 'error'; c.steps.push({ agent: 'system', text: '오류: ' + e.message }); }
}

function send(res, origin, code, obj) {
  const h = { 'Content-Type': 'application/json; charset=utf-8' };
  if (ORIGINS.has(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Headers'] = 'Content-Type';
    h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
  }
  res.writeHead(code, h); res.end(JSON.stringify(obj));
}
function authOk(body, ip) {
  roll();
  state.badAuth[ip] = state.badAuth[ip] || 0;
  if (state.badAuth[ip] >= 20) return false;
  const ok = typeof body.code === 'string' &&
    crypto.timingSafeEqual(Buffer.from(body.code.padEnd(64).slice(0, 64)), Buffer.from(CFG.code.padEnd(64).slice(0, 64)));
  if (!ok) { state.badAuth[ip]++; save(); }
  return ok;
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin || '';
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (req.method === 'OPTIONS') return send(res, origin, 204, {});
  const url = req.url.split('?')[0];
  if (req.method === 'GET' && url === '/health') return send(res, origin, 200, { ok: true, agents: ['naru', 'gyeol'] });
  if (req.method === 'GET' && url.startsWith('/thread/')) {
    const c = threads[url.slice(8)];
    return c ? send(res, origin, 200, { status: c.status, steps: c.steps })
             : send(res, origin, 404, { error: 'not found' });
  }
  if (req.method !== 'POST') return send(res, origin, 405, { error: 'method' });
  let raw = '';
  req.on('data', d => { raw += d; if (raw.length > 4096) req.destroy(); });
  req.on('end', async () => {
    let body = {}; try { body = JSON.parse(raw) } catch (e) { return send(res, origin, 400, { error: 'json' }); }
    if (url === '/verify') return authOk(body, ip) ? send(res, origin, 200, { ok: true }) : send(res, origin, 401, { error: '접근코드가 올바르지 않습니다' });
    if (!authOk(body, ip)) return send(res, origin, 401, { error: '접근코드가 올바르지 않습니다' });

    if (url === '/chat') {
      if (state.chat >= CFG.limits.chatPerDay) return send(res, origin, 429, { error: '오늘의 데모 한도가 소진되었습니다. 내일 다시 시도해 주세요.' });
      const sid = String(body.session || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 32) || 'anon';
      state.sessions[sid] = (state.sessions[sid] || 0) + 1;
      if (state.sessions[sid] > CFG.limits.chatPerSession) return send(res, origin, 429, { error: '이 세션의 대화 한도(15턴)에 도달했습니다.' });
      const msg = String(body.message || '').slice(0, 400).trim();
      if (!msg) return send(res, origin, 400, { error: 'empty' });
      state.chat++; save();
      const reply = await agentTurn('axdemo', `agent:axdemo:web-${sid}`, msg);
      return send(res, origin, 200, { reply });
    }
    if (url === '/thread') {
      if (state.thread >= CFG.limits.threadPerDay) return send(res, origin, 429, { error: '오늘의 협업 데모 한도가 소진되었습니다.' });
      const kind = body.kind === 'lounge' ? 'lounge' : 'review';
      const msg = clean(body.message);
      if (!msg) return send(res, origin, 400, { error: 'empty' });
      const id = crypto.randomBytes(6).toString('hex');
      state.thread++; save();
      threads[id] = { status: 'running', steps: [], kind };
      const tsid = String(body.session || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 32) || 'anon';
      runThread(id, kind, msg, tsid);
      return send(res, origin, 200, { id });
    }
    return send(res, origin, 404, { error: 'route' });
  });
});
server.listen(18790, '127.0.0.1', () => console.log('axdemo-bridge v2 on 127.0.0.1:18790'));
const server2 = http.createServer(server.listeners('request')[0]);
server2.listen(18790, CFG.dockerGatewayIp, () => console.log('axdemo-bridge v2 on ' + CFG.dockerGatewayIp + ':18790'));
