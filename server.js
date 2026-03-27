const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const cron = require('node-cron');

const PORT = process.env.PORT || 3000;
const GH_TOKEN = process.env.GITHUB_TOKEN || '';
const TG_BOT_TOKEN = process.env.FORUM_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.FORUM_CHAT_ID || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const BRAVE_KEY = process.env.BRAVE_SEARCH_API_KEY || '';
const COMMAND_TOPIC_ID = 104; // 🎮 명령실 thread_id
const NEWS_TOPIC_ID = 104; // 뉴스도 명령실에 발송 (나중에 별도 토픽 가능)
const CHAT_OWNER_IDS = ['1668479932']; // 대화형 챗 허용 유저 (LastMoney)
const REPO_OWNER = 'LastMoney64';
const REPO_NAME = 'makdon-briefing';

// ── Think Tank 에이전트 정의 ──
const AGENTS = {
  analyst: {
    name: '📊 분석가',
    emoji: '📊',
    system: `너는 "분석가"야. 데이터와 수치 기반으로만 판단해.
- 감정을 배제하고 객관적 근거만 제시
- 가능하면 수치, 통계, 온체인 데이터 언급
- 확신도를 표시: 🟢높음 🟡중간 🔴낮음
- 짧고 핵심만. 최대 200자.`
  },
  critic: {
    name: '😈 비평가',
    emoji: '😈',
    system: `너는 "악마의 대변인(비평가)"이야. 무조건 반박부터 해.
- 다른 에이전트 의견의 약점, 리스크, 반대 시나리오를 지적
- "이게 틀리려면?" 관점에서 분석
- 낙관론에는 비관, 비관론에는 낙관으로 균형
- 짧고 날카롭게. 최대 200자.`
  },
  strategist: {
    name: '👑 전략가',
    emoji: '👑',
    system: `너는 "전략가"야. 장기적 관점에서 전략을 제시해.
- 단기 노이즈보다 큰 그림에 집중
- 구체적 행동 계획 제시 (진입/청산/관망 등)
- 리스크 대비 수익 비율 고려
- 짧고 실행 가능하게. 최대 200자.`
  },
  researcher: {
    name: '🔍 리서처',
    emoji: '🔍',
    system: `너는 "리서처"야. 관련 맥락과 배경 정보를 제공해.
- 과거 유사 사례, 역사적 패턴 참조
- 관련 인물/기관/프로젝트 동향
- 출처 구분: [사실] vs [해석] vs [추정]
- 짧고 정보 밀도 높게. 최대 200자.`
  },
  moderator: {
    name: '🎯 중재자',
    emoji: '🎯',
    system: `너는 "중재자"야. 모든 에이전트의 의견을 종합해서 최종 결론을 내려.
- 각 에이전트 의견의 핵심을 1줄로 요약
- 합의점과 분쟁점을 명확히 구분
- 최종 판단과 추천 행동을 제시
- 확신도와 리스크 레벨 표시
- 최대 300자.`
  }
};

const DISCUSSION_ORDER = ['analyst', 'researcher', 'critic', 'strategist', 'moderator'];

// ── Claude API 호출 ──
function callClaude(systemPrompt, messages) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages
    });
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.content && parsed.content[0]) {
            resolve(parsed.content[0].text);
          } else {
            // 상세 에러 출력
            const errMsg = parsed.error?.message || JSON.stringify(parsed).slice(0, 300);
            console.error('[Claude API Error]', JSON.stringify(parsed).slice(0, 500));
            reject(new Error(errMsg));
          }
        } catch (e) { reject(new Error('JSON 파싱 실패: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', (e) => reject(new Error('네트워크 오류: ' + e.message)));
    req.write(payload);
    req.end();
  });
}

// ── Think Tank 토론 실행 ──
async function runDiscussion(question) {
  const results = [];
  let conversationContext = '';

  for (const agentId of DISCUSSION_ORDER) {
    const agent = AGENTS[agentId];
    let userMsg = `질문: ${question}`;

    if (conversationContext) {
      userMsg += `\n\n--- 이전 에이전트 의견 ---\n${conversationContext}`;
    }

    if (agentId === 'moderator') {
      userMsg += '\n\n위 모든 의견을 종합해서 최종 결론을 내려줘.';
    }

    try {
      const response = await callClaude(agent.system, [{ role: 'user', content: userMsg }]);
      results.push({ agentId, name: agent.name, emoji: agent.emoji, response });
      conversationContext += `\n${agent.name}: ${response}\n`;
    } catch (err) {
      results.push({ agentId, name: agent.name, emoji: agent.emoji, response: `(응답 실패: ${err.message})` });
    }
  }

  return results;
}

// ── 토론 결과를 텔레그램 메시지로 포맷 ──
function formatDiscussion(question, results) {
  const msgs = [];

  // 헤더
  msgs.push(`🏛️ <b>Think Tank 토론</b>\n\n❓ <b>${question}</b>\n\n━━━━━━━━━━━━━━━`);

  // 각 에이전트 의견 (중재자 제외)
  const agentOpinions = results.filter(r => r.agentId !== 'moderator');
  let opinionText = '';
  for (const r of agentOpinions) {
    opinionText += `\n${r.emoji} <b>${r.name}</b>\n${r.response}\n`;
  }
  msgs.push(opinionText.trim());

  // 중재자 최종 결론
  const mod = results.find(r => r.agentId === 'moderator');
  if (mod) {
    msgs.push(`━━━━━━━━━━━━━━━\n\n🎯 <b>최종 결론 (중재자)</b>\n\n${mod.response}`);
  }

  return msgs;
}

// ── Brave Search API (웹 검색) ──
function braveSearch(query, count = 5) {
  return new Promise((resolve, reject) => {
    const searchUrl = `/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}&search_lang=ko&freshness=pd`;
    https.get({
      hostname: 'api.search.brave.com',
      path: searchUrl,
      headers: { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_KEY }
    }, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    }).on('error', reject);
  });
}

// ── Brave News Search API (뉴스 전용) ──
function braveNewsSearch(query, count = 5, freshness = 'pd') {
  return new Promise((resolve, reject) => {
    const searchUrl = `/res/v1/news/search?q=${encodeURIComponent(query)}&count=${count}&search_lang=ko&freshness=${freshness}`;
    https.get({
      hostname: 'api.search.brave.com',
      path: searchUrl,
      headers: { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_KEY }
    }, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    }).on('error', reject);
  });
}

// ── 웹 페이지 텍스트 + og:image 추출 (타임아웃 보장) ──
function fetchPage(pageUrl) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ text: '(타임아웃)', ogImage: '' }), 10000);
    try {
      const parsed = new URL(pageUrl);
      const getter = parsed.protocol === 'https:' ? https : http;
      const req = getter.get(pageUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' }, timeout: 8000 }, (resp) => {
        // 리다이렉트 처리
        if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
          clearTimeout(timer);
          fetchPage(resp.headers.location).then(resolve);
          return;
        }
        let data = '';
        resp.on('data', c => { data += c; if (data.length > 50000) { resp.destroy(); } });
        resp.on('end', () => {
          clearTimeout(timer);
          // og:image 추출
          let ogImage = '';
          const ogMatch = data.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
            || data.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
          if (ogMatch) ogImage = ogMatch[1];

          const text = data
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
            .replace(/\s+/g, ' ').trim().slice(0, 3000);
          resolve({ text, ogImage });
        });
        resp.on('error', () => { clearTimeout(timer); resolve({ text: '', ogImage: '' }); });
      });
      req.on('error', () => { clearTimeout(timer); resolve({ text: '', ogImage: '' }); });
      req.on('timeout', () => { req.destroy(); clearTimeout(timer); resolve({ text: '', ogImage: '' }); });
    } catch { clearTimeout(timer); resolve({ text: '', ogImage: '' }); }
  });
}

// ── 텔레그램 이미지+캡션 발송 ──
function tgSendPhoto(photoUrl, caption, threadId) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return Promise.resolve();
  const payload = JSON.stringify({
    chat_id: TG_CHAT_ID,
    message_thread_id: threadId || COMMAND_TOPIC_ID,
    photo: photoUrl,
    caption: caption.slice(0, 1024),
    parse_mode: 'HTML'
  });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TG_BOT_TOKEN}/sendPhoto`,
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

// ── /news 뉴스 분석 및 발행 ──
async function handleNewsCommand(keyword) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY 미설정');

  // URL 직접 전달 감지 — 해당 기사를 바로 크롤링
  const isUrl = keyword.startsWith('http://') || keyword.startsWith('https://');
  if (isUrl) {
    let page = await fetchPage(keyword);
    let articleText = page.text || '';
    let imageUrl = (page.ogImage && !page.ogImage.match(/logo|icon|favicon|brand/i)) ? page.ogImage : '';

    // 크롤링 실패 시 Brave 검색으로 기사 내용 확보
    if (!articleText || articleText === '(타임아웃)' || articleText.length < 100) {
      try {
        // URL에서 도메인+제목 추출하여 검색
        const domain = new URL(keyword).hostname.replace('www.', '');
        const searchResult = await braveSearch('site:' + domain + ' ' + keyword, 3);
        const found = searchResult?.web?.results?.[0];
        if (found) {
          articleText = found.description || '';
          // 해당 검색 결과 페이지도 크롤링 시도
          const page2 = await fetchPage(found.url || keyword);
          if (page2.text && page2.text.length > articleText.length) articleText = page2.text;
          if (!imageUrl && page2.ogImage && !page2.ogImage.match(/logo|icon|favicon|brand/i)) imageUrl = page2.ogImage;
        }
      } catch {}
    }

    if (!articleText || articleText.length < 50) throw new Error('기사 내용을 가져올 수 없습니다. 다른 기사 링크를 시도해주세요.');

    const articleContext = `[기사] ${keyword}\n본문: ${articleText}`;
    const sourceUrl = keyword;

    const newsText = await callClaude(
      `너는 텔레그램 크립토/경제 뉴스 채널 에디터야.
기사를 분석해서 아래 형식으로 정리해. 반드시 900자 이내로.

형식:

📌 [핵심 헤드라인 한 줄]

📋 주요 내용 요약
• 핵심 3~4개 (각 1줄)

💬 Comment
1~2문장. 투자자 관점. 확정 아닌 건 명시.

#해시태그 #3개

규칙:
- HTML 태그 금지, 일반 텍스트만
- 불릿은 • 사용
- 반드시 900자 이내
- 한국어
- 오늘은 ${new Date().toISOString().slice(0, 10)}
- 메타 코멘트 금지. 뉴스 내용만.`,
      [{ role: 'user', content: `이 기사를 분석해줘:\n\n${articleContext}` }]
    );

    let caption = newsText + '\n\n<a href="' + sourceUrl + '">🔗 기사보러가기</a>';
    if (caption.length > 1024) {
      caption = newsText.slice(0, 900) + '...\n\n<a href="' + sourceUrl + '">🔗 기사보러가기</a>';
    }
    return { caption, imageUrl };
  }

  if (!BRAVE_KEY) throw new Error('BRAVE_SEARCH_API_KEY 미설정');

  // 1. Brave News Search로 최신 뉴스 기사 검색
  const newsResult = await braveNewsSearch(keyword, 5);
  let newsResults = newsResult?.results || [];

  // 저품질/커뮤니티 도메인 제외
  const EXCLUDE = ['dcinside', 'fmkorea', 'ppomppu', 'clien', 'ruliweb', 'reddit', 'namu.wiki',
    'tistory', 'blog.naver', 'youtube.com', 'twitter.com', 'x.com', 'facebook.com'];
  newsResults = newsResults.filter(r => !EXCLUDE.some(ex => (r.url || '').toLowerCase().includes(ex)));
  // 중복 헤드라인 제거
  const seenTitles = new Set();
  newsResults = newsResults.filter(r => {
    const key = (r.title || '').slice(0, 20);
    if (seenTitles.has(key)) return false;
    seenTitles.add(key);
    return true;
  });

  // 뉴스 검색 결과 부족 시 freshness 확장 → 웹 검색 fallback
  if (newsResults.length < 2) {
    const weekResult = await braveNewsSearch(keyword, 8, 'pw');
    const weekResults = (weekResult?.results || [])
      .filter(r => !EXCLUDE.some(ex => (r.url || '').toLowerCase().includes(ex)));
    for (const r of weekResults) {
      const key = (r.title || '').slice(0, 20);
      if (!seenTitles.has(key)) {
        seenTitles.add(key);
        newsResults.push(r);
      }
    }
  }
  if (newsResults.length === 0) {
    const webResult = await braveSearch(keyword + ' 뉴스', 5);
    const webResults = (webResult?.web?.results || [])
      .filter(r => !EXCLUDE.some(ex => (r.url || '').toLowerCase().includes(ex)));
    if (webResults.length === 0) throw new Error('검색 결과 없음');
    newsResults = webResults;
  }

  // 상위 3개 기사 — 본문 + og:image 크롤링
  const articles = [];
  let imageUrl = '';
  for (const r of newsResults.slice(0, 3)) {
    let page = { text: '', ogImage: '' };
    try { page = await fetchPage(r.url); } catch {}
    articles.push({
      title: r.title,
      url: r.url,
      description: r.description || '',
      text: page.text || r.description || '',
      ogImage: page.ogImage || ''
    });
    // og:image 중 로고가 아닌 첫 번째 이미지 사용
    if (!imageUrl && page.ogImage && !page.ogImage.match(/logo|icon|favicon|brand/i)) {
      imageUrl = page.ogImage;
    }
  }

  // og:image가 없거나 로고뿐이면 Brave 이미지 검색 fallback
  if (!imageUrl) {
    try {
      const imgResult = await braveSearch(keyword + ' 뉴스 사진', 5);
      const imgResults = imgResult?.web?.results || [];
      for (const r of imgResults) {
        if (r.thumbnail?.src && !r.thumbnail.src.match(/logo|icon|favicon/i)) {
          imageUrl = r.thumbnail.src;
          break;
        }
      }
    } catch {}
  }

  // 2. Claude로 뉴스 포맷팅
  const articleContext = articles.map((a, i) =>
    `[기사 ${i+1}] ${a.title}\nURL: ${a.url}\n${a.description}\n본문 요약: ${a.text}`
  ).join('\n\n');

  const sourceUrl = articles[0]?.url || '';
  const newsText = await callClaude(
    `너는 텔레그램 크립토/경제 뉴스 채널 에디터야.
기사를 분석해서 아래 형식으로 정리해. 반드시 900자 이내로.

형식:

📌 [핵심 헤드라인 한 줄]

📋 주요 내용 요약
• 핵심 3~4개 (각 1줄)

💬 Comment
1~2문장. 투자자 관점. 확정 아닌 건 명시.

#해시태그 #3개

규칙:
- HTML 태그 금지, 일반 텍스트만
- 불릿은 • 사용
- 반드시 900자 이내 (엄수)
- 한국어
- 오늘은 ${new Date().toISOString().slice(0, 10)}
- 메타 코멘트 금지. 뉴스 내용만.
- 가장 관련 높은 기사 1개만 집중.`,
    [{ role: 'user', content: `뉴스 포스트 만들어줘:\n\n${articleContext}` }]
  );

  // 캡션 = 본문 + 기사 링크 (HTML 링크, 1024자 이내)
  let caption = newsText + '\n\n<a href="' + sourceUrl + '">🔗 기사보러가기</a>';
  if (caption.length > 1024) {
    caption = newsText.slice(0, 900) + '...\n\n<a href="' + sourceUrl + '">🔗 기사보러가기</a>';
  }

  return { caption, imageUrl };
}

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
  '/status':   'status',
  '/ask':      'ask',
  '/debate':   'ask',
  '/news':     'news',
  '/help':     'help'
};

// 뉴스용 — 기사 이미지를 텍스트 위에 크게 표시
function tgSendNews(text, articleUrl, threadId) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return Promise.resolve();
  const payload = JSON.stringify({
    chat_id: TG_CHAT_ID,
    message_thread_id: threadId || COMMAND_TOPIC_ID,
    text,
    parse_mode: 'HTML',
    link_preview_options: {
      url: articleUrl,
      prefer_large_media: true,
      show_above_text: true
    }
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

async function handleTgCommand(command, fullText) {
  // /help
  if (command === '/help') {
    await tgSend(
      `🏛️ <b>막돈방 Think Tank 명령실</b>\n\n` +
      `<b>📡 콘텐츠 발행</b>\n` +
      `/briefing - 아침 브리핑 즉시 발행\n` +
      `/coin - 코인 분석 즉시 발행\n` +
      `/kol - KOL 인사이트 즉시 발행\n` +
      `/ai - AI 리포트 즉시 발행\n` +
      `/macro - 매크로 리포트 즉시 발행\n` +
      `/evening - 저녁 브리핑 즉시 발행\n` +
      `/all - 전체 발행\n` +
      `/status - 오늘 발행 현황\n\n` +
      `<b>🏛️ Think Tank</b>\n` +
      `/ask [질문] - 5명 에이전트 토론\n` +
      `/news [키워드] - 뉴스 검색 + 정리 발행\n\n` +
      `<b>💬 대화형 챗</b>\n` +
      `슬래시 명령 없이 자유롭게 질문하세요!\n` +
      `시장 질문은 실시간 뉴스 검색 후 답변합니다.\n\n` +
      `예시:\n` +
      `<code>/ask 비트코인 지금 사야 할까?</code>\n` +
      `<code>/news 가상자산 과세</code>\n` +
      `<code>지금 비트코인 왜 떨어져?</code>\n\n` +
      `/help - 이 도움말`
    );
    return;
  }

  // /news 처리 — 뉴스 검색 및 발행
  if (command === '/news') {
    const keyword = (fullText || '').replace(/^\/news(@\w+)?\s*/i, '').trim();
    if (!keyword) {
      await tgSend('📰 키워드를 입력해주세요.\n예: <code>/news 비트코인 ETF</code>');
      return;
    }

    await tgSend(`🔍 <b>"${keyword}"</b> 관련 뉴스 검색 중...`);

    try {
      // 전체 60초 타임아웃
      const newsPromise = handleNewsCommand(keyword);
      const timeoutPromise = new Promise((_, rej) => setTimeout(() => rej(new Error('60초 타임아웃')), 60000));
      const { caption, imageUrl } = await Promise.race([newsPromise, timeoutPromise]);

      // 이미지 + 캡션 1개 메시지로 전송
      if (imageUrl) {
        await tgSendPhoto(imageUrl, caption, NEWS_TOPIC_ID);
      } else {
        await tgSend(caption, NEWS_TOPIC_ID);
      }
    } catch (err) {
      await tgSend(`❌ 뉴스 생성 실패: ${err.message}`);
    }
    return;
  }

  // /ask 처리 — 질문 텍스트 필요
  if (command === '/ask' || command === '/debate') {
    const question = (fullText || '').replace(/^\/(ask|debate)(@\w+)?\s*/i, '').trim();
    if (!question) {
      await tgSend('❓ 질문을 입력해주세요.\n예: <code>/ask 비트코인 지금 사야 할까?</code>');
      return;
    }
    if (!ANTHROPIC_KEY) {
      await tgSend('❌ ANTHROPIC_API_KEY가 설정되지 않았습니다.');
      return;
    }

    await tgSend(`🏛️ <b>Think Tank 소집 중...</b>\n\n❓ ${question}\n\n5명의 에이전트가 분석을 시작합니다. 잠시 기다려주세요...`);

    try {
      const results = await runDiscussion(question);
      const msgs = formatDiscussion(question, results);
      for (const msg of msgs) {
        await tgSend(msg);
      }
    } catch (err) {
      await tgSend(`❌ Think Tank 토론 중 오류: ${err.message}`);
    }
    return;
  }

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

// ── 대화형 챗 핸들러 ──
async function handleChat(userText, userName) {
  if (!ANTHROPIC_KEY) return;

  // 뉴스/시장 관련 질문 감지 → 실시간 검색 보강
  const marketKeywords = ['비트코인', '이더리움', 'btc', 'eth', '코인', '주식', '환율', '금리', '유가', '나스닥', 'S&P', '떨어', '올라', '하락', '상승', '폭락', '급등', '왜 이렇', '무슨 일', '뉴스'];
  const needsSearch = marketKeywords.some(kw => userText.toLowerCase().includes(kw.toLowerCase()));

  let searchContext = '';
  if (needsSearch && BRAVE_KEY) {
    try {
      // 핵심 키워드 추출하여 검색
      const searchQuery = userText.replace(/[?？！!~]/g, '').slice(0, 60);
      const newsResult = await braveNewsSearch(searchQuery, 3);
      const results = newsResult?.results || [];
      if (results.length > 0) {
        searchContext = '\n\n[실시간 뉴스 검색 결과]\n' +
          results.slice(0, 3).map(r => `• ${r.title}: ${r.description || ''}`).join('\n');
      }
      // 뉴스 없으면 웹 검색
      if (!searchContext) {
        const webResult = await braveSearch(searchQuery, 3);
        const webResults = webResult?.web?.results || [];
        if (webResults.length > 0) {
          searchContext = '\n\n[실시간 웹 검색 결과]\n' +
            webResults.slice(0, 3).map(r => `• ${r.title}: ${r.description || ''}`).join('\n');
        }
      }
    } catch {}
  }

  const response = await callClaude(
    `너는 "막돈방" 텔레그램 채널의 AI 어시스턴트야.
크립토, 주식, AI, 거시경제에 대해 깊은 지식을 갖고 있어.
사용자의 질문에 간결하고 핵심적으로 답변해.

규칙:
- 텔레그램 메시지이므로 300자 이내로 간결하게
- 시장 질문이면 실시간 검색 결과를 참고해서 답변
- 확실하지 않은 정보는 "~로 보입니다" 등 불확실성 표시
- HTML 태그 사용 가능 (<b>, <i>, <code>)
- 오늘 날짜: ${new Date().toISOString().slice(0, 10)}
- 인사/잡담에는 자연스럽게 대화
- 투자 조언이 아닌 정보 제공 관점`,
    [{ role: 'user', content: userText + searchContext }]
  );

  await tgSend(response, COMMAND_TOPIC_ID);
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
        if (msg && msg.text) {
          const isCommandRoom = msg.message_thread_id === COMMAND_TOPIC_ID || !msg.message_thread_id;
          if (msg.text.startsWith('/')) {
            // 슬래시 명령어 처리
            const cmd = msg.text.split('@')[0].split(' ')[0].toLowerCase();
            handleTgCommand(cmd, msg.text).catch(() => {});
          } else if (isCommandRoom && msg.from && CHAT_OWNER_IDS.includes(String(msg.from.id))) {
            // 명령실에서 오너의 일반 텍스트 → 대화형 챗
            handleChat(msg.text, msg.from.first_name || '').catch(e => {
              console.error('[Chat Error]', e.message);
            });
          }
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

  // ── 정시 발행 스케줄러 (KST 기준, Railway는 UTC) ──
  if (GH_TOKEN) {
    const SCHEDULE = [
      { cron: '30 0 * * *',    key: 'morning',  label: '아침 브리핑' },    // 09:30 KST
      { cron: '0 2 * * 1-5',   key: 'coin',     label: '코인 분석' },      // 11:00 KST
      { cron: '0 5 * * 1-5',   key: 'kol',      label: 'KOL 인사이트' },   // 14:00 KST
      { cron: '0 9 * * 1-5',   key: 'ai',       label: 'AI 리포트' },      // 18:00 KST
      { cron: '0 13 * * 1-5',  key: 'macro',    label: '매크로 리포트' },   // 22:00 KST
      { cron: '40 14 * * *',   key: 'evening',  label: '저녁 브리핑' },     // 23:40 KST
      { cron: '55 14 * * *',   key: 'summary',  label: '일별 요약' },       // 23:55 KST
      { cron: '0 3 * * *',     key: 'failsafe', label: '페일세이프' },      // 12:00 KST
    ];

    for (const s of SCHEDULE) {
      cron.schedule(s.cron, async () => {
        const wf = WORKFLOWS[s.key];
        console.log(`[CRON] ${new Date().toISOString()} — ${s.label} 트리거`);
        try {
          const r = await ghPost(
            `/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${wf.file}/dispatches`,
            { ref: 'main' }
          );
          const ok = r.status === 204;
          console.log(`[CRON] ${s.label}: ${ok ? '성공' : '실패 (' + r.status + ')'}`);
          await tgSend(`⏰ <b>[정시 발행]</b> ${wf.name} — ${ok ? '트리거 완료' : '❌ 실패'}`, COMMAND_TOPIC_ID);
        } catch (err) {
          console.error(`[CRON] ${s.label} 에러:`, err.message);
          await tgSend(`❌ <b>[정시 발행 오류]</b> ${wf.name} — ${err.message}`, COMMAND_TOPIC_ID);
        }
      }, { timezone: 'UTC' });
      console.log(`  📅 ${s.label}: ${s.cron} (UTC)`);
    }
    console.log('Cron scheduler: ENABLED (8 workflows)');
  } else {
    console.log('Cron scheduler: DISABLED (no GITHUB_TOKEN)');
  }

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
