const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const GH_TOKEN = process.env.GITHUB_TOKEN || '';
const TG_BOT_TOKEN = process.env.FORUM_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.FORUM_CHAT_ID || '';
const COMMAND_TOPIC_ID = 104; // 🎮 명령실 thread_id
const REPO_OWNER = 'LastMoney64';
const REPO_NAME = 'makdon-briefing';

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

// ── GitHub API helper ──
function ghFetch(apiPath) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.github.com',
      path: apiPath,
      headers: { 'User-Agent': 'ThinkTank-Dashboard', 'Accept': 'application/vnd.github.v3+json' }
    };
    if (GH_TOKEN) opts.headers['Authorization'] = `token ${GH_TOKEN}`;
    https.get(opts, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        try { resolve({ status: resp.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: resp.statusCode, data: null }); }
      });
    }).on('error', reject);
  });
}

function ghPost(apiPath, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const opts = {
      hostname: 'api.github.com',
      path: apiPath,
      method: 'POST',
      headers: {
        'User-Agent': 'ThinkTank-Dashboard',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    if (GH_TOKEN) opts.headers['Authorization'] = `token ${GH_TOKEN}`;
    const req = https.request(opts, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        try { resolve({ status: resp.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: resp.statusCode, data: null }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Workflow name → file mapping ──
const WORKFLOWS = {
  morning:      { file: 'morning.yml',       name: '☀️ 아침 브리핑',   time: '09:30', agent: 'telegram' },
  coin:         { file: 'content_coin.yml',   name: '🪙 코인 분석',     time: '10:30', agent: 'analyst' },
  kol:          { file: 'content_kol.yml',    name: '💭 KOL 인사이트',  time: '14:00', agent: 'researcher' },
  ai:           { file: 'content_ai.yml',     name: '🤖 AI 리포트',     time: '18:00', agent: 'researcher' },
  evening:      { file: 'evening.yml',        name: '🌙 저녁 브리핑',   time: '20:00', agent: 'telegram' },
  macro:        { file: 'content_macro.yml',  name: '🌏 매크로 리포트', time: '22:00', agent: 'analyst' },
  summary:      { file: 'summary.yml',        name: '📊 일별 요약',     time: '22:10', agent: 'moderator' },
  failsafe:     { file: 'failsafe.yml',       name: '🛡️ 페일세이프',   time: '12:00', agent: 'moderator' }
};

// ── API Routes ──
async function handleAPI(pathname, query, req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    // GET /api/status — 전체 워크플로우 실행 상태
    if (pathname === '/api/status') {
      const result = await ghFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/actions/runs?per_page=30`);
      if (result.status !== 200) {
        res.writeHead(result.status);
        res.end(JSON.stringify({ error: 'GitHub API error', detail: result.data }));
        return;
      }
      const runs = (result.data.workflow_runs || []).map(r => ({
        id: r.id,
        name: r.name,
        status: r.status,
        conclusion: r.conclusion,
        started: r.run_started_at,
        updated: r.updated_at,
        workflow: r.path?.replace('.github/workflows/', ''),
        url: r.html_url
      }));
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, runs, workflows: WORKFLOWS }));
      return;
    }

    // GET /api/logs — makdon-briefing 실행 로그
    if (pathname === '/api/logs') {
      const now = new Date();
      const month = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
      const logResult = await ghFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/contents/logs/${month}.json`);
      if (logResult.status === 200 && logResult.data.content) {
        const content = Buffer.from(logResult.data.content, 'base64').toString('utf-8');
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, month, logs: JSON.parse(content) }));
      } else {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, month, logs: [] }));
      }
      return;
    }

    // POST /api/trigger/:workflow — 워크플로우 수동 트리거
    if (pathname.startsWith('/api/trigger/')) {
      const wfKey = pathname.replace('/api/trigger/', '');
      const wf = WORKFLOWS[wfKey];
      if (!wf) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: `Unknown workflow: ${wfKey}` }));
        return;
      }
      if (!GH_TOKEN) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'GITHUB_TOKEN not configured' }));
        return;
      }
      const triggerResult = await ghPost(
        `/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${wf.file}/dispatches`,
        { ref: 'main' }
      );
      res.writeHead(triggerResult.status === 204 ? 200 : triggerResult.status);
      res.end(JSON.stringify({
        ok: triggerResult.status === 204,
        workflow: wfKey,
        name: wf.name,
        message: triggerResult.status === 204 ? '트리거 성공' : '트리거 실패'
      }));
      return;
    }

    // GET /api/agents — 에이전트 상태 (워크플로우 기반)
    if (pathname === '/api/agents') {
      const result = await ghFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/actions/runs?per_page=15`);
      const agentStatus = {};
      if (result.status === 200) {
        for (const run of (result.data.workflow_runs || [])) {
          const wfFile = run.path?.replace('.github/workflows/', '');
          const wfEntry = Object.entries(WORKFLOWS).find(([, v]) => v.file === wfFile);
          if (!wfEntry) continue;
          const agentId = wfEntry[1].agent;
          if (agentStatus[agentId]) continue; // first (latest) only
          agentStatus[agentId] = {
            state: run.status === 'in_progress' ? 'working' : run.status === 'queued' ? 'thinking' : 'idle',
            task: wfEntry[1].name,
            conclusion: run.conclusion,
            updated: run.updated_at
          };
        }
      }
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, agents: agentStatus }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (err) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
}

// ── Telegram Bot helpers ──
const CMD_MAP = {
  '/briefing': 'morning',
  '/morning':  'morning',
  '/coin':     'coin',
  '/kol':      'kol',
  '/ai':       'ai',
  '/macro':    'macro',
  '/evening':  'evening',
  '/summary':  'summary',
  '/all':      'all',
  '/status':   'status'
};

function tgSend(text, threadId) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return Promise.resolve();
  const payload = JSON.stringify({
    chat_id: TG_CHAT_ID,
    message_thread_id: threadId || COMMAND_TOPIC_ID,
    text,
    parse_mode: 'HTML'
  });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TG_BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (resp) => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => resolve(d));
    });
    req.on('error', () => resolve(null));
    req.write(payload);
    req.end();
  });
}

async function handleTgCommand(command) {
  const key = CMD_MAP[command];
  if (!key) return;

  if (key === 'status') {
    // 오늘 발행 현황 조회
    const result = await ghFetch(`/repos/${REPO_OWNER}/${REPO_NAME}/actions/runs?per_page=20`);
    const today = new Date().toISOString().slice(0, 10);
    const todayRuns = (result.data?.workflow_runs || []).filter(r => r.created_at?.startsWith(today));
    let msg = `📊 <b>오늘 발행 현황</b> (${today})\n\n`;
    if (todayRuns.length === 0) {
      msg += '아직 실행된 워크플로우가 없습니다.';
    } else {
      for (const r of todayRuns) {
        const icon = r.conclusion === 'success' ? '✅' : r.conclusion === 'failure' ? '❌' : '⏳';
        msg += `${icon} ${r.name} — ${r.conclusion || r.status}\n`;
      }
    }
    await tgSend(msg);
    return;
  }

  if (key === 'all') {
    // 전체 발행 트리거
    const targets = ['morning', 'coin', 'kol', 'ai', 'macro', 'evening'];
    await tgSend('🚀 <b>전체 발행 시작</b>\n\n순차적으로 트리거합니다...');
    for (const t of targets) {
      const wf = WORKFLOWS[t];
      const r = await ghPost(`/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${wf.file}/dispatches`, { ref: 'main' });
      const ok = r.status === 204;
      await tgSend(`${ok ? '✅' : '❌'} ${wf.name} — ${ok ? '트리거 완료' : '실패'}`);
    }
    return;
  }

  // 단일 워크플로우 트리거
  const wf = WORKFLOWS[key];
  if (!wf) return;
  await tgSend(`⏳ <b>${wf.name}</b> 트리거 중...`);
  const r = await ghPost(`/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${wf.file}/dispatches`, { ref: 'main' });
  const ok = r.status === 204;
  await tgSend(`${ok ? '✅' : '❌'} <b>${wf.name}</b> — ${ok ? '트리거 완료! 약 1-2분 후 발행됩니다.' : '트리거 실패. GITHUB_TOKEN을 확인하세요.'}`);
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => resolve(body));
  });
}

// ── Main Server ──
const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // Telegram webhook
  if (pathname === `/webhook/telegram/${TG_BOT_TOKEN}` && req.method === 'POST') {
    readBody(req).then(body => {
      try {
        const update = JSON.parse(body);
        const msg = update.message;
        if (msg && msg.text && msg.text.startsWith('/')) {
          // 명령실 토픽에서 온 메시지만 처리 (또는 DM)
          const cmd = msg.text.split('@')[0].split(' ')[0].toLowerCase();
          handleTgCommand(cmd).catch(() => {});
        }
      } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    return;
  }

  // API routes
  if (pathname.startsWith('/api/')) {
    handleAPI(pathname, parsed.query, req, res);
    return;
  }

  // Static files
  let filePath = pathname === '/' ? '/dashboard.html' : pathname;
  filePath = path.join(__dirname, filePath);
  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'text/plain';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(302, { Location: '/' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType + '; charset=utf-8' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Think Tank Dashboard running on port ${PORT}`);
  console.log(`GitHub integration: ${GH_TOKEN ? 'ENABLED' : 'DISABLED (set GITHUB_TOKEN)'}`);
  console.log(`Telegram bot: ${TG_BOT_TOKEN ? 'ENABLED' : 'DISABLED (set FORUM_BOT_TOKEN)'}`);

  // Auto-register Telegram webhook on startup
  if (TG_BOT_TOKEN && process.env.RAILWAY_PUBLIC_DOMAIN) {
    const webhookUrl = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/webhook/telegram/${TG_BOT_TOKEN}`;
    const payload = JSON.stringify({ url: webhookUrl });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TG_BOT_TOKEN}/setWebhook`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (resp) => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => console.log('Telegram webhook:', d));
    });
    req.write(payload);
    req.end();
  }
});
