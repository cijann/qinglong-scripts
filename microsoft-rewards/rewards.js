/* SPDX-License-Identifier: GPL-3.0-only
 * Microsoft Rewards 全功能青龙适配 v1.0.0
 * Protocol source: ScriptCat #3947 v3.0.6 / geoi6sam1 & Soul233.
 * Companion: #3956 v0.3.0 / Soul233. Modified implementation, 2026-10-26.
 * cron: 7,27,47 * * * *
 * const $ = new Env('微软积分商城（全功能）');
 * Node.js >=22; no npm dependencies. See 使用说明.txt.
 */
'use strict';
const path = require('node:path');
const C = require('./rewards-common.js');
const PC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0';
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; 2211133C) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36 EdgA/138.0.0.0';
const APP_HOST = 'prod.rewardsplatform.microsoft.com';
const OFFER_READ = 'ENUS_readarticle3_30points';
const TRANSIENT_CODES = new Set(['HTTP_429', 'HTTP_500', 'HTTP_502', 'HTTP_503', 'HTTP_504']);
function transientError(e) {
  return Boolean(e && (TRANSIENT_CODES.has(e.code) || e.name === 'TimeoutError' || e.name === 'AbortError' ||
    e.safeMessage === '网络请求超时或已取消'));
}
// API URLs from ScriptCat #3947; these are not the hot-list website URLs.
const HOT_SOURCES = [
  'https://hotapi.nntool.cc/baidu',
  'https://hot.baiwumm.com/api/baidu',
  'https://cnxiaobai.com/DailyHotApi/baidu',
  'https://dailyapi.eray.cc/baidu',
  'https://hotapi.zhusun.top/baidu',
  'https://api-hot.imsyy.top/baidu'
];
function flag(name, fallback = true) { return process.env[name] === undefined ? fallback : process.env[name] === '1'; }
function number(name, fallback, min, max) {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(n) || n < min || n > max) throw C.fail(`${name} 必须为 ${min} 至 ${max} 的数字`);
  return n;
}
function chinaDate(date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).map(x => [x.type, x.value]));
  return { key: `${p.year}${p.month}${p.day}`, promo: `${p.month}/${p.day}/${p.year}`, hour: Number(p.hour) };
}
function validNumber(value) {
  return (typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))) &&
    Number.isFinite(Number(value)) && Number(value) >= 0;
}
function progress(counter) {
  if (counter === undefined || (Array.isArray(counter) && !counter.length)) return null;
  if (!Array.isArray(counter)) throw C.fail('搜索计数格式无效');
  let p = 0, max = 0;
  for (const item of counter) {
    if (!validNumber(item?.pointProgress) || !validNumber(item?.pointProgressMax)) throw C.fail('搜索计数包含无效数字');
    p += Number(item.pointProgress); max += Number(item.pointProgressMax);
  }
  return { p, max };
}
function searchProgress(d) {
  const counters = d?.userStatus?.counters;
  if (!counters) throw C.fail('网页积分进度结构已变化，停止搜索');
  const pc = progress(counters.pcSearch); const mobile = progress(counters.mobileSearch);
  if (!pc && !mobile) throw C.fail('接口未返回可用搜索计数，可能账号不支持或接口已变化');
  return { pc, mobile };
}
function readProgress(data) {
  const offers = data?.response?.promotions;
  const offer = Array.isArray(offers) && offers.find(x => x?.attributes?.offerid === OFFER_READ);
  if (!offer) throw C.fail('App 未返回阅读任务，本轮不提交阅读');
  const p = Number(offer.attributes.progress), max = Number(offer.attributes.max);
  if (!validNumber(offer.attributes.progress) || !validNumber(offer.attributes.max) || max <= 0) throw C.fail('App 阅读进度结构无效');
  return { p, max };
}
function verificationToken(html) {
  for (const tag of html.match(/<input\b[^>]*>/gi) || []) {
    const attrs = {};
    for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)) attrs[m[1].toLowerCase()] = m[3];
    if (attrs.name === '__RequestVerificationToken' && attrs.value) {
      return attrs.value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    }
  }
  throw C.fail('未取得活动验证令牌，请重新同步 Cookie 或检查接口变化');
}
// Read JSON data embedded by Next.js without executing any page scripts.
// The /api/getuserinfo hash is for the legacy API, not the current server action.
function pageActivityModels(html) {
  const segments = [];
  for (const m of html.matchAll(/<script\b[^>]*>\s*self\.__next_f\.push\(([\s\S]*?)\)\s*;?\s*<\/script>/gi)) {
    try {
      const chunk = JSON.parse(m[1]);
      if (Array.isArray(chunk) && chunk[0] === 1 && typeof chunk[1] === 'string') segments.push(chunk[1]);
    } catch (_) { /* Ignore non-JSON script content; never evaluate it. */ }
  }
  const models = new Map();
  for (const line of segments.join('').split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    let root;
    try { root = JSON.parse(line.slice(colon + 1)); } catch (_) { continue; }
    const stack = [root];
    while (stack.length) {
      const item = stack.pop();
      if (!item || typeof item !== 'object') continue;
      if (typeof item.offerId === 'string' && item.offerId.length <= 256 &&
          typeof item.hash === 'string' && /^[a-f0-9]{64}$/i.test(item.hash)) {
        const model = { hash: item.hash, locked: item.isLocked === true || item.isDisabled === true, type: 11 };
        if (Number.isSafeInteger(item.type) && item.type >= 0 && item.type <= 1000) model.type = item.type;
        if (typeof item.isPromotional === 'boolean') model.isPromotional = item.isPromotional;
        models.set(item.offerId, model);
      }
      for (const value of Object.values(item)) if (value && typeof value === 'object') stack.push(value);
    }
  }
  return models;
}
function appBusinessOK(data) {
  const r = data?.response;
  if (!r || typeof r !== 'object' || data.error || data.errors || r.error || r.errors) return false;
  for (const value of [data.status, r.status]) {
    if (typeof value === 'string' && /fail|error|denied/i.test(value)) return false;
  }
  return true;
}
function promoList(d, date) {
  // Missing schema is not interpreted as all-complete.
  if (!d.dailySetPromotions || typeof d.dailySetPromotions !== 'object' || !Array.isArray(d.morePromotions)) {
    throw C.fail('网页活动列表结构已变化，无法确认任务完成');
  }
  const daily = d.dailySetPromotions[date];
  if (!Array.isArray(daily)) throw C.fail('未返回当天活动列表，无法确认全部完成');
  const all = [...daily, ...d.morePromotions];
  if (all.some(p => typeof p?.complete !== 'boolean')) throw C.fail('活动完成状态字段无效');
  return all.filter(p => p.complete === false);
}
class Runner {
  constructor({ request = C.request, sleep = C.delay, log = console.log } = {}) {
    this.request = request; this.sleep = sleep; this.log = log;
    this.creds = C.readCredentials(); this.jar = structuredClone(this.creds.cookies || []);
    this.initialCookies = JSON.stringify(this.jar);
    this.ua = this.creds.userAgent || PC_UA;
    this.state = C.readJSON('state.json', {}); this.results = [];
    this.span = number('REWARDS_SEARCH_INTERVAL', 15, 10, 300);
    this.searchLimit = Math.trunc(number('REWARDS_SEARCH_LIMIT', 6, 1, 200));
    this.words = []; this.wordIndex = 0; this.runDate = chinaDate().key;
  }
  ensureSameDay() { if (chinaDate().key !== this.runDate) throw C.fail('运行已跨越北京时间零点，本轮结束，下轮重算进度'); }
  async web(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const retries = options.retries ?? (method === 'GET' || method === 'HEAD' ? 2 : 0);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.request(url, { ...options, cookies: this.jar,
          headers: { 'User-Agent': this.ua, 'Accept-Language': 'zh-CN,zh;q=0.9', ...options.headers },
          allowedHosts: ['rewards.bing.com', 'www.bing.com', 'cn.bing.com', 'bing.com'] });
      } catch (e) {
        if (attempt >= retries || !transientError(e)) throw e;
        await this.sleep(1500 * (attempt + 1));
      }
    }
  }
  async dashboard() {
    let data;
    try {
      data = await this.web('https://rewards.bing.com/api/getuserinfo?type=1', { json: true });
    } catch (e) {
      if (e.code === 'HTTP_401' || e.code === 'HTTP_403') throw C.fail('网页登录已失效，请在浏览器重新登录并同步 Cookie', 'AUTH_WEB');
      throw e;
    }
    if (!data?.dashboard?.userStatus) throw C.fail('网页登录已失效，请在浏览器重新登录并同步 Cookie', 'AUTH_WEB');
    return data.dashboard;
  }
  async app(url, options = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await C.appToken(attempt === 1);
      try {
        const data = await this.request(`https://${APP_HOST}${url}`, { ...options, json: true,
          allowedHosts: [APP_HOST], headers: { 'Content-Type': 'application/json', ...options.headers, Authorization: `Bearer ${token}` } });
        if (!appBusinessOK(data)) throw C.fail('App 返回业务异常，本次未确认成功');
        return data;
      } catch (e) { if (attempt === 0 && e.code === 'HTTP_401') continue; throw e; }
    }
  }
  async sign() {
    const day = chinaDate();
    const session = this.creds.app?.session || 'manual-env';
    if (this.state.sign === day.key && this.state.signSession === session) return { status: 'done', detail: '今日已获接口确认' };
    const data = await this.app('/dapi/me/activities', { method: 'POST', body: JSON.stringify({
      amount: 1, attributes: { offerid: 'Gamification_Sapphire_DailyCheckIn', date: Number(day.key), signIn: false, timezoneOffset: '08:00:00' },
      id: '', type: 101, country: 'cn', risk_context: {}, channel: 'SAAndroid'
    }) });
    const activity = data.response?.activity;
    if (!activity || !Object.hasOwn(activity, 'p') || !validNumber(activity.p)) {
      throw C.fail('签到响应没有有效 activity.p，未标记完成');
    }
    this.state.sign = day.key; this.state.signSession = session; C.writeJSON('state.json', this.state);
    return { status: 'done', detail: `接口确认签到，响应积分 ${Number(activity.p)}（以账户记录为准）` };
  }
  async read() {
    let current = readProgress(await this.app('/dapi/me?channel=SAAndroid&options=613'));
    let stagnant = 0;
    for (let count = 0; count < 40 && current.p < current.max; count++) {
      this.ensureSameDay();
      await this.app('/dapi/me/activities', { method: 'POST', body: JSON.stringify({
        amount: 1, country: 'cn', id: '', type: 101, attributes: { offerid: OFFER_READ }
      }) });
      await this.sleep(3000);
      const next = readProgress(await this.app('/dapi/me?channel=SAAndroid&options=613'));
      stagnant = next.p > current.p ? 0 : stagnant + 1; current = next;
      if (stagnant >= 3) return { status: 'pending', detail: `连续3次无进展，阅读 ${current.p}/${current.max}` };
    }
    if (current.p >= current.max) {
      this.state.read = chinaDate().key; C.writeJSON('state.json', this.state);
      return { status: 'done', detail: `阅读 ${current.p}/${current.max}` };
    }
    return { status: 'pending', detail: `本轮达到上限，阅读 ${current.p}/${current.max}` };
  }
  async promoTransport() {
    const html = await this.web('https://rewards.bing.com/earn');
    try { return { kind: 'legacy', token: verificationToken(html) }; }
    catch (_) { /* New Rewards pages use a Next.js server action, not a hidden token. */ }
    const models = pageActivityModels(html);
    if (!models.size) throw C.fail('新版页面未返回有效活动凭证，停止使用旧接口凭证');
    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)]
      .map(m => new URL(m[1], 'https://rewards.bing.com'))
      .filter(u => u.origin === 'https://rewards.bing.com' && u.pathname.startsWith('/_next/static/chunks/'));
    if (!scripts.length || scripts.length > 80) throw C.fail('未识别网页活动提交方式，请检查微软页面更新');
    for (let start = 0; start < scripts.length; start += 4) {
      const chunks = await Promise.all(scripts.slice(start, start + 4).map(async u => {
        try { return await this.web(u.href); } catch (_) { return ''; }
      }));
      for (const text of chunks) {
        const found = text.match(/createServerReference\)\(["']([a-f0-9]{40,64})["'][\s\S]{0,200}?["']reportActivity["']/);
        if (found) {
          this.log(`[活动] 已识别新版网页活动动作及 ${models.size} 项页面凭证`);
          return { kind: 'next', action: found[1], models };
        }
      }
    }
    throw C.fail('未找到当前网页的活动动作，不使用过期固定接口');
  }
  async submitPromo(p, transport) {
    if (transport.kind === 'next') {
      const model = transport.models?.get(p.offerId);
      if (!model || model.locked) throw C.fail('此活动在新版页面没有可用凭证或尚未解锁', 'PROMO_UNAVAILABLE');
      const attributes = { offerid: p.offerId, timezoneOffset: '-480' };
      if (typeof model.isPromotional === 'boolean') attributes.isPromotional = String(model.isPromotional);
      await this.web('https://rewards.bing.com/earn', { method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'Next-Action': transport.action,
          Accept: 'text/x-component', Origin: 'https://rewards.bing.com', Referer: 'https://rewards.bing.com/earn' },
        body: JSON.stringify([model.hash, model.type, attributes]) });
      // HTTP success and action boolean are not proof of credit: dashboard is re-queried.
    } else {
      await this.web('https://rewards.bing.com/api/reportactivity', { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://rewards.bing.com/' },
        body: new URLSearchParams({ id: p.offerId, hash: p.hash, __RequestVerificationToken: transport.token }).toString() });
    }
  }
  async promo() {
    const day = chinaDate();
    let list = promoList(await this.dashboard(), day.promo);
    const submitErrors = new Map();
    for (let pass = 0; pass < 3 && list.length; pass++) {
      this.ensureSameDay();
      const transport = await this.promoTransport();
      // Limit protects against changed or runaway activity feeds.
      if (list.length > 100) throw C.fail('活动数量异常，本轮停止提交');
      for (const p of list) {
        if (typeof p.offerId !== 'string' || typeof p.hash !== 'string') continue;
        try { await this.submitPromo(p, transport); submitErrors.delete(p.offerId); }
        catch (e) {
          if (e.code === 'PROMO_UNAVAILABLE') {
            this.log('[活动] 一项活动在当前页面不可提交，保留待完成状态');
            continue;
          }
          if (!transientError(e)) throw e;
          submitErrors.set(p.offerId, e);
          this.log(`[活动] 提交临时异常（${C.safeError(e)}），继续其余活动并复查完成状态`);
        }
      }
      await this.sleep(3000);
      list = promoList(await this.dashboard(), day.promo);
    }
    if (!list.length) {
      this.state.promo = day.key; C.writeJSON('state.json', this.state);
      return { status: 'done', detail: '网页活动列表已确认完成' };
    }
    const stillFailed = list.find(p => submitErrors.has(p.offerId));
    if (stillFailed) throw submitErrors.get(stillFailed.offerId);
    return { status: 'pending', detail: `仍有 ${list.length} 项未获完成确认：${list.map(p => String(p.title || '未命名活动').slice(0, 60)).join('、')}` };
  }
  async keyword() {
    if (!this.words.length) {
      const custom = process.env.REWARDS_KEYWORDS;
      if (custom) this.words = custom.split('|').map(s => s.trim()).filter(Boolean);
      if (!this.words.length && flag('REWARDS_HOT_WORDS', true)) {
        // Public title feeds only; never attach Bing cookies or App tokens.
        const sources = [...new Set([process.env.REWARDS_HOT_URL, ...HOT_SOURCES].filter(Boolean))];
        for (const source of sources) {
          let host = '自定义接口';
          try {
            const u = new URL(source);
            if (u.protocol !== 'https:' || u.username || u.password) throw C.fail('热词地址必须为无认证信息的HTTPS URL');
            host = u.hostname;
            const data = await this.request(u.href, { json: true, timeout: 5000, allowedHosts: [u.hostname] });
            if (Number(data?.code) !== 200 || !Array.isArray(data?.data)) throw C.fail('业务状态或词条结构无效');
            const titles = [...new Set(data.data.map(x => x?.title)
              .filter(x => typeof x === 'string').map(x => x.trim().slice(0, 150)).filter(Boolean))];
            if (!titles.length) throw C.fail('未返回有效词条');
            this.words = titles;
            this.log(`[热词] 使用 ${host}，取得 ${titles.length} 条有效词条`);
            break;
          } catch (e) { this.log(`[热词] ${host} 不可用：${C.safeError(e)}；尝试下一接口`); }
        }
        if (!this.words.length) this.log('[热词] 全部接口不可用，改用内置词库');
      }
      // Keep enough distinct fallback topics for the 60-point / 3-point search tier.
      if (!this.words.length) this.words = [
        '天气预报', '中国航天进展', '家常菜做法', '周末徒步装备', '计算机网络基础', '新能源汽车技术',
        '秋季旅游攻略', '天文观测指南', '摄影构图技巧', '开源软件新闻', '历史博物馆', '家庭园艺方法',
        '冬季汽车轮胎保养', '家庭路由器无线信道选择', '咖啡手冲水温', '全麦面包制作方法',
        '室内绿植冬季养护', '星座观测入门', '手机照片备份方法', '自行车链条维护',
        '中国古代建筑榫卯结构', '东北冬季观鸟', '家庭节电方法', '意大利面酱制作',
        '长春地质博物馆介绍', '机械键盘轴体区别', '保温杯清洗方法', '羊毛衣物洗护',
        '地球极光形成原理', '旅行行李收纳方法', '番茄阳台种植', '天文望远镜参数选择',
        '家庭书籍防潮方法', '厨房刀具保养', '数字照片色彩管理', '雪花晶体形成原理'
      ];
      this.wordIndex = Number(this.state.wordIndex || 0) % this.words.length;
    }
    const word = this.words[this.wordIndex++ % this.words.length];
    this.state.wordIndex = this.wordIndex; return word;
  }
  async search() {
    let prev; let stagnant = 0; let sent = 0;
    while (true) {
      this.ensureSameDay();
      const p = searchProgress(await this.dashboard());
      const detail = `PC ${p.pc ? `${p.pc.p}/${p.pc.max}` : '无配额'}，手机 ${p.mobile ? `${p.mobile.p}/${p.mobile.max}` : '无配额'}`;
      this.log(`[搜索] ${detail}；本轮请求 ${sent}/${this.searchLimit}`);
      if ((!p.pc || p.pc.p >= p.pc.max) && (!p.mobile || p.mobile.p >= p.mobile.max)) {
        this.state.search = chinaDate().key;
        return { status: 'done', detail };
      }
      const signature = JSON.stringify(p);
      if (prev !== undefined) stagnant = signature === prev ? stagnant + 1 : 0;
      if (stagnant >= 3) return { status: 'pending', detail: `连续3次未加分，停止本轮；${detail}` };
      if (sent >= this.searchLimit) return { status: 'pending', detail: `已到本轮次数限制；${detail}` };
      const mobile = !p.pc || p.pc.p >= p.pc.max;
      const u = new URL(mobile ? 'https://cn.bing.com/search' : 'https://www.bing.com/search');
      u.search = new URLSearchParams(mobile ? { q: await this.keyword(), cc: 'CN', PC: 'SANSAAND', form: 'LWS001', setlang: 'zh-hans' } :
        { q: await this.keyword(), qs: 'ds', FORM: 'QBLH' }).toString();
      await this.web(u.href, { headers: { 'User-Agent': mobile ? (process.env.REWARDS_MOBILE_UA || MOBILE_UA) : this.ua,
        Referer: mobile ? 'https://cn.bing.com/' : 'https://www.bing.com/' } });
      sent++; prev = signature;
      await this.sleep(Math.max(1000, (this.span + Math.random() * 10 - 5) * 1000));
    }
  }
  async task(name, enabled, fn) {
    if (!enabled) { this.results.push({ name, status: 'skipped', detail: '配置关闭' }); return; }
    this.log(`[${name}] 开始`);
    try { this.results.push({ name, ...await fn() }); }
    catch (e) { this.results.push({ name, status: 'failed', detail: C.safeError(e), code: e?.code }); }
    const result = this.results.at(-1); this.log(`[${name}] ${result.status}: ${result.detail}`);
  }
  async persistCookies() {
    if (JSON.stringify(this.jar) === this.initialCookies) return;
    await C.updateCredentials(current => {
      // A newer browser upload wins over the jar loaded at task start.
      if (JSON.stringify(current.cookies || []) !== this.initialCookies) return current;
      return { ...current, cookies: this.jar };
    });
  }
  async weworkAppNotify(title, content) {
    const raw = (process.env.REWARDS_QYWX_AM || process.env.QYWX_AM || '').trim();
    const [corpid, corpsecret, touser = '@all', agentid] = raw.split(',');
    if (!corpid || !corpsecret || !agentid) throw C.fail('企业微信应用配置不完整（QYWX_AM）');
    const base = 'https://qyapi.weixin.qq.com';
    const tokenData = await this.request(`${base}/cgi-bin/gettoken?${new URLSearchParams({ corpid, corpsecret })}`, {
      json: true, timeout: 10000, allowedHosts: ['qyapi.weixin.qq.com']
    });
    const token = tokenData?.access_token;
    if (typeof token !== 'string' || !token) throw C.fail('企业微信获取 access_token 失败');
    const sent = await this.request(`${base}/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`, {
      method: 'POST', json: true, timeout: 10000, allowedHosts: ['qyapi.weixin.qq.com'],
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ touser, msgtype: 'text', agentid: Number(agentid), text: { content: `${title}\n\n${content}` }, safe: 0 })
    });
    if (sent?.errcode !== 0) throw C.fail(`企业微信发送失败（errcode ${sent?.errcode}）`);
  }
  async notify() {
    const summary = this.results.map(r => `${r.name}: ${r.status} — ${r.detail}`).join('\n');
    if (process.env.REWARDS_PUSH_URL) {
      try {
        const allDone = this.results.every(x => x.status === 'done' || x.status === 'skipped');
        const u = new URL(process.env.REWARDS_PUSH_URL);
        if (u.protocol !== 'https:' || u.username || u.password) throw C.fail('Push URL配置无效');
        if (allDone) await this.request(u.href, { timeout: 10000, allowedHosts: [u.hostname] });
        else this.log('[Push] 本轮仍有未完成任务，不发送成功心跳');
      } catch (_) { this.log('[Push] 推送失败，地址和响应已隐藏'); }
    }
    if (!flag('REWARDS_NOTIFY', false)) return summary;
    const failed = this.results.filter(x => x.status === 'failed' && !['AUTH_WEB', 'AUTH_APP'].includes(x.code));
    const active = this.results.filter(x => x.status !== 'skipped');
    const allDone = active.length > 0 && active.every(x => x.status === 'done');
    let title; let send = false;
    if (failed.length) { title = '微软积分商城｜任务异常'; send = true; }
    else if (allDone && this.state.completeNotify !== chinaDate().key) {
      title = '微软积分商城｜今日任务完成'; send = true;
    }
    if (!send) {
      this.log(allDone ? '[通知] 今日完成通知已发送，不重复推送' : '[通知] 本轮无异常且未全部完成，不发送');
      return summary;
    }
    try {
      await this.weworkAppNotify(title, summary);
      if (allDone) { this.state.completeNotify = chinaDate().key; C.writeJSON('state.json', this.state); }
      this.log('[通知] 企业微信已发送');
    }
    catch (e) { this.log(`[通知] 发送失败：${C.safeError(e)}`); }
    return summary;
  }
  async alertOnce(key, title, detail) {
    if (!flag('REWARDS_NOTIFY', false)) return;
    const today = chinaDate().key;
    const stateKey = `alert_${key}`;
    if (this.state[stateKey] === today) return; // 当日已告警，避免每轮重复轰炸
    this.state[stateKey] = today;
    try { await this.weworkAppNotify(title, detail); this.log(`[告警] ${title}`); }
    catch (e) { this.log(`[告警] 发送失败：${C.safeError(e)}`); }
  }
  async run(checkOnly = false) {
    let webError;
    try { await this.dashboard(); this.log('[登录] 网页会话有效'); }
    catch (e) { webError = e; this.log(`[登录] ${C.safeError(e)}`); }
    if (checkOnly) {
      if (flag('REWARDS_APP', true)) {
        await this.app('/dapi/me?channel=SAAndroid&options=613'); this.log('[登录] App令牌和查询接口有效');
      }
      if (webError) throw webError;
      return;
    }
    const webAuthError = webError?.code === 'AUTH_WEB' ? webError : null;
    if (webAuthError) {
      await this.alertOnce('web', '微软积分商城｜网页登录失效',
        `网页会话已失效，脚本无法恢复。请在浏览器重新登录 Rewards 并同步 Cookie。\n\n${C.safeError(webAuthError)}`);
    }
    const appEnabled = flag('REWARDS_APP', true);
    await this.task('App签到', appEnabled, () => this.sign());
    await this.task('App阅读', appEnabled && flag('REWARDS_READ', true), () => this.read());
    await this.task('每日及更多活动', flag('REWARDS_PROMO', true), () => webAuthError ? Promise.reject(webAuthError) : this.promo());
    await this.task('PC及手机搜索', flag('REWARDS_SEARCH', true), () => webAuthError ? Promise.reject(webAuthError) : this.search());
    if (this.results.some(r => r.code === 'AUTH_APP')) {
      await this.alertOnce('app', '微软积分商城｜App 授权失效',
        'App 授权已失效，脚本无法刷新令牌。请在浏览器重新发起 App 授权。');
    }
    C.writeJSON('state.json', this.state);
    C.writeJSON('last-result.json', { date: new Date().toISOString(), results: this.results });
    this.log(await this.notify());
    if (this.results.some(r => r.status === 'failed')) process.exitCode = 1;
  }
}
async function main() {
  if (process.argv.includes('--help')) {
    console.log('用法: node rewards.js [--check]\n--check 仅查询网页登录和App令牌，不提交搜索、签到或活动。\n需要Node.js>=22，配置见使用说明.txt。'); return;
  }
  if (Number(process.versions.node.split('.')[0]) < 22) throw C.fail('请使用 Node.js 22 或更新版本');
  await C.withLock('runner', async () => {
    const runner = new Runner();
    try { await runner.run(process.argv.includes('--check')); }
    finally { await runner.persistCookies(); }
  }, 0);
}
module.exports = { Runner, chinaDate, progress, searchProgress, readProgress, verificationToken, pageActivityModels, appBusinessOK, promoList };
if (require.main === module) main().catch(e => { console.error(C.safeError(e)); process.exitCode = 1; });
