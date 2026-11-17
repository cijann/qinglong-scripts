// ==UserScript==
// @name         Microsoft Rewards 青龙桥接助手
// @namespace    rewards-qinglong-bridge-local
// @version      1.0.0
// @description  用户配置桥接地址后同步 Bing Cookie，并完成独立的 Rewards App 授权。
// @license      GPL-3.0
// @author       QingLong adapter; protocol reference: geoi6sam1 & Soul233
// Modified implementation 2026-10-26; references ScriptCat #3947 / #3956.
// @storageName  rewards-qinglong-bridge-7f4d67b9-v1
// @match        https://www.bing.com/*
// @match        https://cn.bing.com/*
// @match        https://rewards.bing.com/*
// @match        https://login.live.com/oauth20_desktop.srf*
// @noframes
// @run-at       document-start
// @grant        GM_cookie
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM.setValue
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @grant        GM_notification
// @connect      bing.com
// @connect      *.bing.com
// @connect      login.live.com
// @connect      127.0.0.1
// @connect      localhost
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE = 'rewards-ql-bridge-7f4d67b9:';
  const CLIENT_ID = '0000000040170455';
  const SCOPE = 'service::prod.rewardsplatform.microsoft.com::MBI_SSL';
  const REDIRECT_URI = 'https://login.live.com/oauth20_desktop.srf';
  const USERINFO_URL = 'https://rewards.bing.com/api/getuserinfo?type=1';
  const INTERVAL = 15 * 60_000;
  const PENDING_TTL = 10 * 60_000;
  const BODY_LIMIT = 64 * 1024;
  let cookieBusy = false;
  let oauthBusy = false;
  let retryAuthorization = null;
  let lastAutomaticError = '';
  let lastAutomaticErrorAt = 0;

  class HelperError extends Error {}
  function failure(message) { return new HelperError(message); }
  function safeMessage(error) {
    return error instanceof HelperError ? error.message : '操作失败，请检查助手权限及桥接服务配置。';
  }
  function notify(text) {
    try {
      GM_notification({ title: 'Rewards 青龙桥接助手', text, timeout: 7000 });
    } catch {
      console.warn('[Rewards 桥接助手] 通知不可用。');
    }
  }
  function reportAutomatic(error) {
    const text = safeMessage(error);
    const now = Date.now();
    if (text !== lastAutomaticError || now - lastAutomaticErrorAt >= INTERVAL) {
      console.warn(`[Rewards 桥接助手] ${text}`);
      lastAutomaticError = text;
      lastAutomaticErrorAt = now;
    }
  }
  async function getStored(name, fallback) {
    return await GM_getValue(STORAGE + name, fallback);
  }
  async function setStored(name, value) {
    await GM.setValue(STORAGE + name, value);
  }
  async function sha256(value) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  function randomState() {
    return Array.from(crypto.getRandomValues(new Uint8Array(32)),
      (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  function validKey(key) {
    return typeof key === 'string' && /^[\x21-\x7e]{32,1024}$/.test(key);
  }
  function ipv4(host) {
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
    const parts = host.split('.').map(Number);
    return parts.every((part) => part >= 0 && part <= 255) ? parts : null;
  }
  function isLoopback(host) {
    const parts = ipv4(host);
    return host === 'localhost' || host === '[::1]' || Boolean(parts && parts[0] === 127);
  }
  function isPrivate(host) {
    const parts = ipv4(host);
    if (parts) {
      return parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
        (parts[0] === 192 && parts[1] === 168);
    }
    return /^\[f[cd][0-9a-f]{2}:/i.test(host);
  }
  function parseBase(input) {
    if (typeof input !== 'string' || input.length > 2048 ||
        !/^https?:\/\/[^/?#]+\/?$/i.test(input) || /[\s\\\x00-\x1f\x7f]/.test(input)) {
      throw failure('桥接地址须为完整的 HTTPS 地址或允许的 HTTP 地址。');
    }
    let url;
    try { url = new URL(input); } catch { throw failure('桥接地址或端口无效。'); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname ||
        url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
        (url.port && (!/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535))) {
      throw failure('地址只能包含协议、主机和有效端口，不能包含账号、路径、查询或片段。');
    }
    if (url.protocol === 'http:' && !isLoopback(url.hostname) && !isPrivate(url.hostname)) {
      throw failure('HTTP 仅允许回环地址或明确确认过的私网 IP；其他地址请使用 HTTPS。');
    }
    return url;
  }
  async function configuration() {
    const stored = await getStored('config', null);
    if (!stored) return null;
    const url = parseBase(stored.baseUrl);
    if (!validKey(stored.key)) throw failure('专用同步密钥无效，请重新配置。');
    if (url.protocol === 'http:' && !isLoopback(url.hostname) && stored.httpApprovedOrigin !== url.origin) {
      throw failure('私网 HTTP 尚未明确确认，请从菜单重新配置。');
    }
    return { baseUrl: url.origin, key: stored.key, httpApprovedOrigin: stored.httpApprovedOrigin || '' };
  }
  async function configSignature(config) {
    return await sha256(JSON.stringify([config.baseUrl, config.key]));
  }
  async function ensureSameConfiguration(config) {
    const current = await configuration();
    if (!current || current.baseUrl !== config.baseUrl || current.key !== config.key) {
      throw failure('桥接配置已改变，请重新执行操作。');
    }
  }
  async function configure() {
    const old = await getStored('config', null);
    const input = window.prompt('输入桥接服务地址（仅协议、主机和端口）。例如 http://127.0.0.1:8787',
      old && typeof old.baseUrl === 'string' ? old.baseUrl : 'http://127.0.0.1:8787');
    if (input === null) return;
    const url = parseBase(input.trim());
    let approvedOrigin = '';
    if (url.protocol === 'http:' && !isLoopback(url.hostname)) {
      const approved = window.confirm(
        `将通过明文 HTTP 向私网服务 ${url.origin} 发送 Bing Cookie、OAuth code 和专用同步密钥。\n` +
        '请确认该地址属于你控制的可信内网，且服务端已设置 REWARDS_ALLOW_HTTP=1。\n是否明确允许？');
      if (!approved) return;
      approvedOrigin = url.origin;
    }
    const keyInput = window.prompt('输入 REWARDS_SYNC_KEY 专用同步密钥（32 至 1024 个非空白 ASCII 字符）。不要填写青龙管理密钥。');
    if (keyInput === null) return;
    if (!validKey(keyInput)) throw failure('专用同步密钥必须为 32 至 1024 个不含空白的 ASCII 字符。');
    await setStored('config', { baseUrl: url.origin, key: keyInput, httpApprovedOrigin: approvedOrigin });
    await setStored('fingerprint', null);
    await setStored('pending', null);
    retryAuthorization = null;
    notify('桥接配置已保存。其他域名需要在 ScriptCat 中授予连接权限。');
    void synchronizeCookies(false).catch(reportAutomatic);
  }

  function request(details) {
    return new Promise((resolve, reject) => {
      try {
        GM_xmlhttpRequest({
          ...details,
          timeout: 20_000,
          redirect: 'error',
          onload(response) {
            try {
              // 禁止重定向将带密钥的请求转发给另一个地址。
              if (response.finalUrl && new URL(response.finalUrl).href !== new URL(details.url).href) {
                reject(failure('请求发生重定向，已拒绝接受结果，请检查服务地址。'));
                return;
              }
              resolve(response);
            } catch {
              reject(failure('响应地址无效。'));
            }
          },
          onerror() { reject(failure('网络请求失败，请检查桥接服务及 ScriptCat 连接权限。')); },
          ontimeout() { reject(failure('请求超时，请稍后重试。')); },
          onabort() { reject(failure('请求已中止。')); },
        });
      } catch {
        reject(failure('无法发起请求，请检查 ScriptCat 权限。'));
      }
    });
  }
  function responseJson(response, maxLength) {
    try {
      if (typeof response.responseText !== 'string' || response.responseText.length > maxLength) throw new Error();
      const data = JSON.parse(response.responseText);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
      return data;
    } catch {
      throw failure('服务返回了无效数据，请检查服务地址和登录状态。');
    }
  }
  async function post(config, route, body) {
    if (!['/sync/cookies', '/sync/oauth'].includes(route)) throw failure('同步接口无效。');
    await ensureSameConfiguration(config);
    const data = JSON.stringify(body);
    if (new TextEncoder().encode(data).length > BODY_LIMIT) throw failure('同步数据超过 64KB，未发送。');
    const response = await request({
      method: 'POST',
      url: config.baseUrl + route,
      anonymous: true,
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${config.key}` },
      data,
    });
    if (response.status === 401) throw failure('桥接认证失败，请核对专用同步密钥。');
    if (response.status === 409) throw failure('该授权已被服务成功处理，请使用新的授权或确认服务端状态。');
    if (response.status === 429) throw failure('桥接服务繁忙，请稍后重试。');
    if (response.status < 200 || response.status >= 300) throw failure('桥接同步失败，请检查服务端配置或重新授权。');
    if (responseJson(response, 4096).ok !== true) throw failure('桥接服务未确认同步成功。');
  }

  function bingDomain(domain) {
    return typeof domain === 'string' &&
      /^\.?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*bing\.com$/i.test(domain);
  }
  function listCookies(options) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(null, true), 10_000);
      function finish(cookies, failed) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (failed || !Array.isArray(cookies)) {
          reject(failure('无法读取 Cookie，请确认 ScriptCat 已授予 GM_cookie 权限。'));
        } else {
          resolve(cookies);
        }
      }
      try {
        if (typeof GM_cookie !== 'function') return finish(null, true);
        GM_cookie('list', options, (cookies, error) => finish(cookies, Boolean(error)));
      } catch {
        finish(null, true);
      }
    });
  }
  async function collectCookies() {
    // 域查询与 URL 查询合并，兼顾 HttpOnly、hostOnly 和不同子域的 Cookie。
    const results = await Promise.allSettled([
      listCookies({ domain: 'bing.com' }),
      listCookies({ url: 'https://www.bing.com/' }),
      listCookies({ url: 'https://cn.bing.com/' }),
      listCookies({ url: 'https://rewards.bing.com/' }),
    ]);
    const available = results.filter((result) => result.status === 'fulfilled');
    if (!available.length ||
        (!(results[0].status === 'fulfilled' && results[0].value.length > 0) &&
         results.slice(1).some((result) => result.status !== 'fulfilled'))) {
      throw failure('无法完整读取 Bing Cookie，请检查 ScriptCat 的 GM_cookie 权限。');
    }
    const unique = new Map();
    for (const result of available) {
      for (const cookie of result.value) {
        if (!cookie || !bingDomain(cookie.domain)) continue;
        if (cookie.expirationDate !== undefined && cookie.expirationDate !== -1 &&
            cookie.expirationDate <= Date.now() / 1000) continue;
        if (typeof cookie.name !== 'string' || typeof cookie.value !== 'string' ||
            typeof cookie.path !== 'string' || !cookie.path.startsWith('/')) {
          throw failure('浏览器返回了不完整的 Cookie，未执行同步。');
        }
        const normalized = {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain.toLowerCase(),
          path: cookie.path,
          secure: Boolean(cookie.secure),
          httpOnly: Boolean(cookie.httpOnly),
          hostOnly: typeof cookie.hostOnly === 'boolean' ? cookie.hostOnly : !cookie.domain.startsWith('.'),
        };
        if (typeof cookie.expirationDate === 'number' && Number.isFinite(cookie.expirationDate)) {
          normalized.expirationDate = cookie.expirationDate;
        }
        unique.set(JSON.stringify([normalized.domain, normalized.path, normalized.name]), normalized);
      }
    }
    const cookies = [...unique.values()].sort((a, b) => {
      const left = JSON.stringify([a.domain, a.path, a.name]);
      const right = JSON.stringify([b.domain, b.path, b.name]);
      return left < right ? -1 : left > right ? 1 : 0;
    });
    if (!cookies.length) throw failure('没有可同步的 Bing Cookie，请先登录 Rewards。');
    return cookies;
  }
  async function verifyDashboard() {
    const response = await request({
      method: 'GET',
      url: USERINFO_URL,
      anonymous: false,
      headers: { Accept: 'application/json' },
    });
    if (response.status !== 200) throw failure('Rewards 登录状态验证失败，请先在浏览器中登录。');
    const data = responseJson(response, 4 * 1024 * 1024);
    if (!data.dashboard || typeof data.dashboard !== 'object' || Array.isArray(data.dashboard)) {
      throw failure('未检测到已登录的 Rewards dashboard，已跳过 Cookie 同步。');
    }
  }
  async function synchronizeCookies(manual) {
    if (cookieBusy) {
      if (manual) notify('Cookie 同步正在进行，请稍后重试。');
      return;
    }
    cookieBusy = true;
    try {
      const config = await configuration();
      if (!config) {
        if (manual) notify('请先从菜单配置桥接地址和专用同步密钥。');
        return;
      }
      await verifyDashboard();
      const cookies = await collectCookies();
      const userAgent = navigator.userAgent;
      const signature = await configSignature(config);
      const fingerprint = await sha256(JSON.stringify({ cookies, userAgent }));
      const previous = await getStored('fingerprint', null);
      if (!manual && previous && previous.destination === signature && previous.value === fingerprint &&
          Date.now() - Number(previous.syncedAt || 0) < 60 * 60_000) return;
      await post(config, '/sync/cookies', { cookies, userAgent });
      await ensureSameConfiguration(config);
      await setStored('fingerprint', { destination: signature, value: fingerprint, syncedAt: Date.now() });
      if (manual) notify('Bing Cookie 已同步。');
    } finally {
      cookieBusy = false;
    }
  }

  async function beginAuthorization() {
    const config = await configuration();
    if (!config) throw failure('请先从菜单配置桥接地址和专用同步密钥。');
    if (oauthBusy) throw failure('授权同步正在进行，请稍后重试。');
    const state = randomState();
    await setStored('pending', { state, createdAt: Date.now(), destination: await configSignature(config) });
    retryAuthorization = null;
    const url = new URL('https://login.live.com/oauth20_authorize.srf');
    url.searchParams.set('client_id', CLIENT_ID);
    url.searchParams.set('scope', SCOPE);
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);
    try {
      GM_openInTab(url.href, { active: true, insert: true, setParent: true });
    } catch {
      await setStored('pending', null);
      throw failure('无法打开授权页面，请检查 ScriptCat 的 GM_openInTab 权限。');
    }
  }
  function captureCallback() {
    if (location.origin !== 'https://login.live.com' || location.pathname !== '/oauth20_desktop.srf') return null;
    const url = new URL(location.href);
    const params = url.searchParams;
    if (!['code', 'state', 'error', 'error_description'].some((name) => params.has(name))) return null;
    const callback = {
      code: params.get('code'),
      state: params.get('state'),
      invalid: params.getAll('code').length > 1 || params.getAll('state').length > 1 || params.has('error'),
      cleaned: false,
    };
    for (const key of ['code', 'state', 'error', 'error_description']) params.delete(key);
    try {
      history.replaceState(null, '', url.pathname + url.search + url.hash);
      callback.cleaned = true;
    } catch {
      // 地址清理失败时保留内存中的数据，不向日志输出地址或异常。
    }
    return callback;
  }
  function validPending(pending) {
    return pending && typeof pending.state === 'string' && /^[a-f0-9]{64}$/.test(pending.state) &&
      typeof pending.createdAt === 'number' && Number.isFinite(pending.createdAt) &&
      Date.now() >= pending.createdAt && Date.now() - pending.createdAt <= PENDING_TTL;
  }
  async function submitAuthorization() {
    if (oauthBusy) throw failure('授权同步正在进行，请稍后重试。');
    if (!retryAuthorization) throw failure('当前页面没有可重试的授权，请重新发起 App 授权。');
    oauthBusy = true;
    try {
      const captured = retryAuthorization;
      const pending = await getStored('pending', null);
      const config = await configuration();
      if (!config || !validPending(pending) || pending.state !== captured.state ||
          pending.destination !== await configSignature(config)) {
        retryAuthorization = null;
        throw failure('授权已过期或状态不匹配，请重新发起 App 授权。');
      }
      await post(config, '/sync/oauth', { code: captured.code });
      // 成功后才删除 pending；失败时 code 仅留在本页内存，菜单可重试。
      const current = await getStored('pending', null);
      if (current && current.state === captured.state) await setStored('pending', null);
      retryAuthorization = null;
      notify('App 授权已同步，后续令牌刷新由服务端处理。');
    } finally {
      oauthBusy = false;
    }
  }
  async function handleCallback(callback) {
    if (!callback) return;
    if (!callback.cleaned) {
      retryAuthorization = null;
      throw failure('无法清理授权回调地址，请关闭此页并重新发起授权。');
    }
    if (callback.invalid || typeof callback.code !== 'string' || callback.code.length < 1 ||
        callback.code.length > 4096 || /[\x00-\x20\x7f]/.test(callback.code) ||
        typeof callback.state !== 'string' || !/^[a-f0-9]{64}$/.test(callback.state)) {
      throw failure('授权回调无效或授权已取消，请重新发起 App 授权。');
    }
    const pending = await getStored('pending', null);
    const config = await configuration();
    if (!config || !validPending(pending) || pending.state !== callback.state ||
        pending.destination !== await configSignature(config)) {
      throw failure('授权状态不匹配或已超过 10 分钟，已拒绝提交。');
    }
    retryAuthorization = { code: callback.code, state: callback.state };
    try {
      await submitAuthorization();
    } catch (error) {
      notify(`${safeMessage(error)} 若尚未成功，可保持本页打开并使用“重试本页 App 授权同步”菜单；刷新后请重新授权。`);
    } finally {
      callback.code = null;
    }
  }
  function menu(label, action) {
    GM_registerMenuCommand(label, () => {
      Promise.resolve().then(action).catch((error) => notify(safeMessage(error)));
    });
  }

  // 最早捕获并清除敏感查询参数，随后才读取存储、发请求或显示通知。
  const callback = captureCallback();
  menu('配置桥接 URL 和专用同步密钥', configure);
  menu('立即同步 Bing Cookie', () => synchronizeCookies(true));
  menu('首次 / 重新授权 Rewards App', beginAuthorization);
  menu('重试本页 App 授权同步', submitAuthorization);
  void handleCallback(callback).catch((error) => notify(safeMessage(error)));
  if (/^(?:www|cn|rewards)\.bing\.com$/.test(location.hostname)) {
    const automatic = () => { void synchronizeCookies(false).catch(reportAutomatic); };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', automatic, { once: true });
    } else {
      automatic();
    }
    setInterval(automatic, INTERVAL);
  }
})();
