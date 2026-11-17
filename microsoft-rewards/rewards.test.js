'use strict';
// Offline tests: fake Microsoft responses only; local sync HTTP integration.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-offline-'));
process.env.REWARDS_DATA_DIR = testDir;
process.env.REWARDS_HOT_WORDS = '0';
process.env.REWARDS_NOTIFY = '0';
const C = require('./rewards-common');
const R = require('./rewards');
const { createSyncServer } = require('./rewards-sync');
after(() => { console.log('离线测试数据（仅虚构凭据）: ' + testDir); });
const cookie = { name: 'session', value: 'fake-value', domain: '.bing.com', path: '/', secure: true, httpOnly: true, hostOnly: false };
const counter = (p, max) => [{ pointProgress: p, pointProgressMax: max }];
function dashboard(p = 0, max = 6) { return { userStatus: { counters: { pcSearch: counter(p, max), mobileSearch: counter(0, 0) } }, dailySetPromotions: { [R.chinaDate().promo]: [] }, morePromotions: [] }; }
test('热词接口容错、业务校验、去重及凭据隔离', async () => {
  const saved = Object.fromEntries(['REWARDS_HOT_WORDS', 'REWARDS_HOT_URL', 'REWARDS_KEYWORDS'].map(k => [k, process.env[k]]));
  process.env.REWARDS_HOT_WORDS = '1'; delete process.env.REWARDS_HOT_URL; delete process.env.REWARDS_KEYWORDS;
  try {
    const calls = [];
    const r = new R.Runner({ log() {}, request: async (url, options) => {
      calls.push(url);
      assert.equal(options.cookies, undefined);
      assert.equal(options.headers, undefined);
      assert.deepEqual(options.allowedHosts, [new URL(url).hostname]);
      assert.equal(options.timeout, 5000);
      if (calls.length === 1) throw C.fail('模拟DNS失败');
      if (calls.length === 2) return { code: 500, data: [{ title: '错误响应不能用' }] };
      if (calls.length === 3) return { code: 200, data: [{ title: '   ' }, {}] };
      return { code: '200', data: [{ title: ' 第一条 ' }, { title: '第一条' }, { title: '第二条' }, { title: null }] };
    } });
    r.state.wordIndex = 0;
    assert.equal(await r.keyword(), '第一条');
    assert.equal(await r.keyword(), '第二条');
    assert.equal(calls.length, 4);
    assert.equal(calls[0], 'https://hotapi.nntool.cc/baidu');
    assert.equal(r.words.length, 2);
    const failures = [];
    const fallback = new R.Runner({ log() {}, request: async url => { failures.push(url); throw C.fail('模拟失败'); } });
    assert.equal(typeof await fallback.keyword(), 'string');
    assert.equal(failures.length, 6);
    assert.equal(new Set(fallback.words).size, 36);
    process.env.REWARDS_HOT_URL = 'https://custom.example/feed';
    const custom = new R.Runner({ log() {}, request: async url => {
      assert.equal(url, 'https://custom.example/feed'); return { code: 200, data: [{ title: '自定义词' }] };
    } });
    assert.equal(await custom.keyword(), '自定义词');
    process.env.REWARDS_KEYWORDS = '手动词一|手动词二';
    const manual = new R.Runner({ log() {}, request: async () => { assert.fail('自定义词库不应请求外部接口'); } });
    assert.ok(['手动词一', '手动词二'].includes(await manual.keyword()));
    delete process.env.REWARDS_KEYWORDS; process.env.REWARDS_HOT_WORDS = '0';
    const offline = new R.Runner({ log() {}, request: async () => { assert.fail('关闭热词不应请求外部接口'); } });
    assert.equal(typeof await offline.keyword(), 'string');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
test('Cookie按域、路径、过期时间和HttpOnly/会话属性过滤', () => {
  assert.equal(C.cookieHeader([{ ...cookie, expirationDate: -1 }], 'https://rewards.bing.com/'), 'session=fake-value');
  assert.equal(C.cookieHeader([cookie], 'https://evil.example/'), '');
  assert.equal(C.cookieHeader([{ ...cookie, domain: 'www.bing.com', hostOnly: true }], 'https://cn.bing.com/'), '');
  assert.equal(C.cookieHeader([{ ...cookie, path: '/foo' }], 'https://www.bing.com/foobar'), '');
  assert.equal(C.cookieHeader([{ ...cookie, expirationDate: 1 }], 'https://www.bing.com/'), '');
  const jar = [structuredClone(cookie)];
  C.mergeSetCookies(jar, ['session=new; Domain=.bing.com; Path=/; Secure; HttpOnly', 'bad=x; Domain=evil.example'], 'https://www.bing.com/');
  assert.equal(jar.length, 1); assert.equal(jar[0].value, 'new');
  C.mergeSetCookies(jar, ['session=; Domain=.bing.com; Path=/; Max-Age=0'], 'https://www.bing.com/');
  assert.equal(jar.length, 0);
});
test('严格状态校验、全部计数、北京时间与HTML属性顺序', () => {
  assert.deepEqual(R.progress([...counter(30, 30), ...counter(0, 120)]), { p: 30, max: 150 });
  assert.throws(() => R.progress([{ pointProgress: null, pointProgressMax: null }]));
  assert.throws(() => R.readProgress({ response: { promotions: [] } }));
  assert.throws(() => R.promoList({ dailySetPromotions: {}, morePromotions: [] }, 'missing'));
  assert.throws(() => R.promoList({ dailySetPromotions: { day: [{}] }, morePromotions: [] }, 'day'));
  assert.equal(R.verificationToken("<input value='ab&amp;c' type='hidden' name='__RequestVerificationToken'>"), 'ab&c');
  assert.equal(R.chinaDate(new Date('2026-10-26T16:00:00Z')).key, '20261027');
  assert.equal(R.appBusinessOK({ response: { error: 'x' } }), false);
});
test('请求逐跳重算Cookie且保留UTF8；跨域不泄露Bearer', async () => {
  const saved = global.fetch; const seen = [];
  global.fetch = async (u, o) => {
    seen.push({ url: String(u), headers: o.headers });
    if (seen.length === 1) return new Response('', { status: 302, headers: { location: 'https://cn.bing.com/next', 'set-cookie': 'fresh=1; Domain=.bing.com; Path=/; Secure' } });
    const bytes = Buffer.from('中文正确');
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(0, 1)); controller.enqueue(bytes.subarray(1)); controller.close(); } }));
  };
  try {
    const result = await C.request('https://www.bing.com/', { cookies: [structuredClone(cookie)], headers: { Authorization: 'Bearer pretend' }, allowedHosts: ['www.bing.com', 'cn.bing.com'] });
    assert.equal(result, '中文正确');
    assert.equal(seen[1].headers.Authorization, undefined);
    assert.match(seen[1].headers.Cookie, /fresh=1/);
  } finally { global.fetch = saved; }
});
test('同步服务实际HTTP鉴权、Cookie合并、OAuth重放及令牌轮换', async () => {
  let tokenCalls = 0; const saved = global.fetch; const realFetch = saved;
  global.fetch = async (url, opts) => {
    if (String(url).startsWith('https://login.live.com/')) {
      tokenCalls++;
      const body = new URLSearchParams(opts.body);
      return new Response(JSON.stringify({ access_token: 'access-' + tokenCalls, refresh_token: 'refresh-' + tokenCalls, expires_in: 3600 }), { headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url, opts);
  };
  const key = '0123456789abcdef0123456789abcdef';
  const { server } = createSyncServer({ env: { ...process.env, REWARDS_SYNC_KEY: key } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  async function post(route, data, auth = key) {
    return realFetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + auth }, body: JSON.stringify(data) });
  }
  try {
    assert.equal((await post('/sync/cookies', {}, 'wrong')).status, 401);
    assert.equal((await post('/sync/cookies', { cookies: [{ ...cookie, domain: '.evil.com' }], userAgent: 'Fake-UA' })).status, 400);
    assert.equal((await post('/sync/cookies', { cookies: [cookie], userAgent: 'Fake-UA' })).status, 200);
    assert.equal((await post('/sync/oauth', { code: 'fake-auth-code' })).status, 200);
    assert.equal((await post('/sync/oauth', { code: 'fake-auth-code' })).status, 409);
    assert.equal(C.readCredentials().cookies.length, 1);
    const session = C.readCredentials().app.session;
    assert.ok(session);
    await C.updateCredentials(c => ({ ...c, app: { ...c.app, expires_at: 1 } }));
    assert.equal(await C.appToken(), 'access-2');
    assert.equal(C.readCredentials().app.refresh_token, 'refresh-2');
    assert.equal(C.readCredentials().app.session, session);
    assert.equal(fs.statSync(path.join(testDir, 'credentials.json')).mode & 0o777, 0o600);
  } finally {
    global.fetch = saved;
    await new Promise(resolve => server.close(resolve));
  }
});
test('锁互斥、异常释放及原子凭据合并', async () => {
  await Promise.all(Array.from({ length: 8 }, (_, i) => C.updateCredentials(c => ({ ...c, ['field' + i]: true }))));
  assert.equal(Object.keys(C.readCredentials()).filter(x => x.startsWith('field')).length, 8);
  await C.withLock('test-lock', async () => {
    await assert.rejects(C.withLock('test-lock', async () => {}, 0), /另一进程/);
  });
  await assert.rejects(C.withLock('test-lock', async () => { throw new Error('expected'); }));
  await C.withLock('test-lock', async () => {});
});
test('搜索以实际进度完成，未加分停轮；无效签到不缓存', async () => {
  let p = 0, sends = 0;
  const runner = new R.Runner({ sleep: async () => {}, log: () => {}, request: async url => {
    if (url.includes('getuserinfo')) return { dashboard: dashboard(p, 6) };
    if (url.includes('/search')) { p += 3; sends++; return 'ok'; }
    throw new Error('unexpected');
  } });
  assert.equal((await runner.search()).status, 'done'); assert.equal(sends, 2);
  const stagnant = new R.Runner({ sleep: async () => {}, log: () => {}, request: async url => url.includes('getuserinfo') ? { dashboard: dashboard() } : 'ok' });
  assert.equal((await stagnant.search()).status, 'pending');
  const sign = new R.Runner({ log: () => {} }); sign.state = {};
  sign.app = async () => ({ response: { activity: { p: null } } });
  await assert.rejects(sign.sign(), /有效 activity.p/); assert.equal(sign.state.sign, undefined);
  sign.app = async () => ({ response: { activity: { p: 5 } } });
  assert.equal((await sign.sign()).status, 'done');
});
test('阅读及网页活动都等待查询确认，不把提交请求当完成', async () => {
  const runner = new R.Runner({ sleep: async () => {}, log: () => {} });
  let read = 0, submits = 0;
  runner.app = async (url, options = {}) => {
    if (options.method === 'POST') { read += 3; submits++; return { response: { activity: { p: 3 } } }; }
    return { response: { promotions: [{ attributes: { offerid: 'ENUS_readarticle3_30points', progress: read, max: 6 } }] } };
  };
  const result = await runner.read();
  assert.equal(result.status, 'done'); assert.equal(submits, 2);
  let done = false, reports = 0;
  runner.dashboard = async () => ({ ...dashboard(), dailySetPromotions: {
    [R.chinaDate().promo]: [{ complete: done, offerId: 'test-offer', hash: 'test-hash' }]
  } });
  runner.web = async (url, options = {}) => {
    if (options.method === 'POST') { reports++; done = true; assert.match(options.body, /__RequestVerificationToken=token/); return '{}'; }
    return '<input name="__RequestVerificationToken" value="token" type="hidden">';
  };
  assert.equal((await runner.promo()).status, 'done'); assert.equal(reports, 1);
});
test('北京时间上午阅读和活动照常执行，已满时不重复提交', async () => {
  const RealDate = global.Date;
  global.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : ['2026-11-07T01:00:00Z'])); }
    static now() { return new RealDate('2026-11-07T01:00:00Z').getTime(); }
  };
  try {
    assert.equal(R.chinaDate().hour, 9);
    const runner = new R.Runner({ sleep: async () => {}, log() {} });
    let reading = 0, readPosts = 0, promoPosts = 0;
    runner.app = async (url, options = {}) => {
      if (options.method === 'POST') { readPosts++; reading = 3; return { response: { activity: { p: 3 } } }; }
      return { response: { promotions: [{ attributes: { offerid: 'ENUS_readarticle3_30points', progress: reading, max: 3 } }] } };
    };
    runner.dashboard = async () => ({ ...dashboard(), dailySetPromotions: {
      [R.chinaDate().promo]: [{ complete: promoPosts > 0, offerId: 'morning', hash: 'test' }]
    } });
    runner.promoTransport = async () => ({ kind: 'legacy', token: 'test' });
    runner.submitPromo = async () => { promoPosts++; };
    assert.equal((await runner.read()).status, 'done');
    assert.equal((await runner.promo()).status, 'done');
    assert.equal(readPosts, 1); assert.equal(promoPosts, 1);
    await runner.read(); await runner.promo();
    assert.equal(readPosts, 1); assert.equal(promoPosts, 1);
  } finally { global.Date = RealDate; }
});
test('新版页面分段JSON解析及未解锁活动保护，不执行网页代码', async () => {
  const hash = 'c'.repeat(64);
  const text = '1:I[123]\n2:' + JSON.stringify(['$', 'div', null, { model: { offerId: 'test', hash, isLocked: true, isPromotional: false, type: 12 } }]) + '\n';
  const html = [text.slice(0, 21), text.slice(21)].map(part =>
    '<script nonce="x">self.__next_f.push(' + JSON.stringify([1, part]) + ');</script>').join('') +
    '<script>self.__next_f.push((globalThis.__rewardsExecuted=true))</script>';
  const models = R.pageActivityModels(html);
  assert.equal(models.size, 1); assert.equal(models.get('test').hash, hash);
  assert.equal(models.get('test').locked, true); assert.equal(models.get('test').isPromotional, false);
  assert.equal(globalThis.__rewardsExecuted, undefined);
  const runner = new R.Runner({ request: async () => assert.fail('未解锁活动不得提交'), log() {} });
  await assert.rejects(runner.submitPromo({ offerId: 'test', hash: 'old' }, { kind: 'next', models }), e => e.code === 'PROMO_UNAVAILABLE');
  assert.equal(R.pageActivityModels('<html></html>').size, 0);
});
test('新版活动从当前JS识别动作且仍以dashboard确认', async () => {
  const runner = new R.Runner({ sleep: async () => {}, log: () => {} });
  const id = 'a'.repeat(40); const pageHash = 'b'.repeat(64); let posted;
  const stream = '0:' + JSON.stringify({ children: [{ offerId: 'offer', hash: pageHash, isPromotional: '$undefined' }] }) + '\n';
  const page = '<script src="/_next/static/chunks/current.js"></script>' +
    '<script>self.__next_f.push(' + JSON.stringify([1, stream]) + ')</script>';
  runner.web = async (url, options = {}) => {
    if (options.method === 'POST') { posted = options; return '1:false\n'; }
    if (url.includes('/_next/')) return `createServerReference)("${id}",t.callServer,void 0,t.findSourceMapURL,"reportActivity")`;
    return page;
  };
  const transport = await runner.promoTransport();
  assert.equal(transport.kind, 'next'); assert.equal(transport.action, id);
  assert.equal(transport.models.get('offer').hash, pageHash);
  await runner.submitPromo({ offerId: 'offer', hash: 'hash' }, transport);
  assert.equal(posted.headers['Next-Action'], id);
  assert.deepEqual(JSON.parse(posted.body), [pageHash, 11, { offerid: 'offer', timezoneOffset: '-480' }]);
  posted = undefined;
  await assert.rejects(runner.submitPromo({ offerId: 'missing', hash: 'legacy' }, transport), e => e.code === 'PROMO_UNAVAILABLE');
  assert.equal(posted, undefined);
  runner.dashboard = async () => ({ ...dashboard(), dailySetPromotions: {
    [R.chinaDate().promo]: [{ complete: false, offerId: 'offer', hash: 'hash' }]
  } });
  const result = await runner.promo();
  assert.equal(result.status, 'pending');
});
test('网页临时503重试、预检不连坐且活动提交仍以查询结果为准', async () => {
  let getCalls = 0;
  const getRetry = new R.Runner({ sleep: async () => {}, log: () => {}, request: async () => {
    if (++getCalls === 1) throw C.fail('rewards.bing.com 返回 HTTP 503', 'HTTP_503');
    return { dashboard: dashboard(6, 6) };
  } });
  assert.equal((await getRetry.dashboard()).userStatus.counters.pcSearch[0].pointProgress, 6);
  assert.equal(getCalls, 2);
  let authCalls = 0;
  const noAuthRetry = new R.Runner({ sleep: async () => {}, log: () => {}, request: async () => {
    authCalls++; throw C.fail('rewards.bing.com 返回 HTTP 401', 'HTTP_401');
  } });
  await assert.rejects(noAuthRetry.dashboard(), /网页登录已失效/);
  assert.equal(authCalls, 1);
  let precheckCalls = 0;
  const isolated = new R.Runner({ sleep: async () => {}, log: () => {} });
  isolated.dashboard = async () => { if (++precheckCalls === 1) throw C.fail('rewards.bing.com 返回 HTTP 503', 'HTTP_503'); return dashboard(6, 6); };
  isolated.sign = isolated.read = async () => ({ status: 'done', detail: 'ok' });
  isolated.promo = async () => ({ status: 'done', detail: '网页活动列表已确认完成' });
  await isolated.run();
  assert.deepEqual(isolated.results.map(r => r.status), ['done', 'done', 'done', 'done']);
  let promoPosts = 0;
  const promo = new R.Runner({ sleep: async () => {}, log: () => {} });
  promo.promoTransport = async () => ({ kind: 'next', action: 'a'.repeat(40) });
  promo.submitPromo = async () => { if (++promoPosts === 1) throw C.fail('rewards.bing.com 返回 HTTP 503', 'HTTP_503'); };
  promo.dashboard = async () => ({ ...dashboard(), dailySetPromotions: {
    [R.chinaDate().promo]: [{ complete: promoPosts >= 2, offerId: 'offer', hash: 'hash' }]
  } });
  assert.equal((await promo.promo()).status, 'done');
  assert.equal(promoPosts, 2);
});
test('完成通知成功后持久去重，发送失败允许下轮重试', async () => {
  const enabled = process.env.REWARDS_NOTIFY; process.env.REWARDS_NOTIFY = '1';
  let sends = 0;
  try {
    C.writeJSON('state.json', {});
    const first = new R.Runner({ log() {} });
    first.results = [{ name: '活动', status: 'done', detail: 'ok' }];
    first.weworkAppNotify = async () => { sends++; };
    await first.notify();
    assert.equal(C.readJSON('state.json').completeNotify, R.chinaDate().key);
    const next = new R.Runner({ log() {} }); next.results = first.results;
    next.weworkAppNotify = async () => { sends++; };
    await next.notify(); assert.equal(sends, 1);
    C.writeJSON('state.json', {});
    const failed = new R.Runner({ log() {} }); failed.results = first.results;
    failed.weworkAppNotify = async () => { throw C.fail('模拟发送失败'); };
    await failed.notify(); assert.equal(C.readJSON('state.json').completeNotify, undefined);
  } finally {
    if (enabled === undefined) delete process.env.REWARDS_NOTIFY; else process.env.REWARDS_NOTIFY = enabled;
  }
});
test('App401只刷新重试一次；各任务失败相互隔离', async () => {
  const savedToken = C.appToken; const refreshed = []; let calls = 0;
  C.appToken = async force => { refreshed.push(force); return 'fake'; };
  try {
    const runner = new R.Runner({ log: () => {}, request: async () => {
      if (++calls === 1) throw C.fail('expired', 'HTTP_401');
      return { response: { promotions: [] } };
    } });
    await runner.app('/dapi/me');
    assert.deepEqual(refreshed, [false, true]);
    await runner.task('故障任务', true, async () => { throw C.fail('测试错误'); });
    await runner.task('后续任务', true, async () => ({ status: 'done', detail: 'ok' }));
    assert.deepEqual(runner.results.map(r => r.status), ['failed', 'done']);
  } finally { C.appToken = savedToken; }
});
