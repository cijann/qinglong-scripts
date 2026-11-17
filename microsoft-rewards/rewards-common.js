/* SPDX-License-Identifier: GPL-3.0-only
 * Microsoft Rewards / QingLong adapter.
 * Protocol reference: ScriptCat #3947 v3.0.6, geoi6sam1 & Soul233.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const DATA_DIR = path.resolve(process.env.REWARDS_DATA_DIR || path.join(__dirname, '.rewards-data'));
const CLIENT = '0000000040170455';
const SCOPE = 'service::prod.rewardsplatform.microsoft.com::MBI_SSL';
const REDIRECT = 'https://login.live.com/oauth20_desktop.srf';
function fail(message, code = 'REWARDS_ERROR') {
  const e = new Error(message); e.safeMessage = message; e.code = code; return e;
}
function safeError(e) {
  if (e?.safeMessage) return e.safeMessage;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return '网络请求超时或已取消';
  if (e?.code === 'ENOENT') return '找不到所需文件';
  if (e?.code === 'EACCES') return '数据目录没有读写权限';
  return '操作失败，请检查网络、配置和服务状态（凭据与上游响应已隐藏）';
}
function ensureDir() { fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 }); }
function readJSON(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw fail(`无法读取 ${name}，请检查文件完整性`); }
}
function writeJSON(name, data) {
  ensureDir();
  const target = path.join(DATA_DIR, name);
  const temp = `${target}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, target);
  } finally { try { fs.unlinkSync(temp); } catch (_) {} }
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function withLock(name, fn, waitMs = 15000) {
  ensureDir();
  const filename = path.join(DATA_DIR, `${name}.lock`);
  const start = Date.now(); let fd;
  for (;;) {
    try { fd = fs.openSync(filename, 'wx', 0o600); fs.writeFileSync(fd, String(process.pid)); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Never delete a lock based on a stale observation: another process could own it now.
      // An unclean shutdown requires explicit offline maintenance; see 使用说明.txt.
      if (Date.now() - start >= waitMs) throw fail('另一进程正在运行，请稍后重试', 'BUSY');
      await delay(80);
    }
  }
  try { return await fn(); }
  finally { fs.closeSync(fd); try { fs.unlinkSync(filename); } catch (_) {} }
}
function readCredentials() { return readJSON('credentials.json', { cookies: [], app: {} }); }
async function updateCredentials(mutator) {
  return withLock('credentials', async () => {
    const current = readCredentials();
    const next = (await mutator(current)) || current;
    next.updatedAt = new Date().toISOString();
    writeJSON('credentials.json', next); return next;
  });
}
function isBing(host) { return host === 'bing.com' || host.endsWith('.bing.com'); }
function cookieMatches(c, url) {
  const u = new URL(url); const domain = String(c.domain || '').toLowerCase().replace(/^\./, '');
  if (!domain || !isBing(domain) || !isBing(u.hostname)) return false;
  if (c.hostOnly ? u.hostname !== domain : !(u.hostname === domain || u.hostname.endsWith('.' + domain))) return false;
  if (c.secure && u.protocol !== 'https:') return false;
  if (c.expirationDate > 0 && c.expirationDate * 1000 <= Date.now()) return false;
  const p = c.path || '/';
  return u.pathname === p || (u.pathname.startsWith(p) && (p.endsWith('/') || u.pathname[p.length] === '/'));
}
function cookieHeader(cookies, url) {
  return cookies.filter(c => cookieMatches(c, url)).sort((a, b) => (b.path || '/').length - (a.path || '/').length)
    .map(c => `${c.name}=${c.value}`).join('; ');
}
function mergeSetCookies(jar, lines, url) {
  const u = new URL(url);
  if (!isBing(u.hostname)) return;
  for (const line of lines) {
    const [pair, ...attrs] = line.split(';'); const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const c = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), domain: u.hostname,
      hostOnly: true, path: u.pathname.slice(0, u.pathname.lastIndexOf('/') + 1) || '/', secure: false };
    let maxAge;
    for (const attr of attrs) {
      const i = attr.indexOf('='); const k = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
      const v = i < 0 ? '' : attr.slice(i + 1).trim();
      if (k === 'domain') { c.domain = v.toLowerCase().replace(/^\./, ''); c.hostOnly = false; }
      if (k === 'path' && v.startsWith('/')) c.path = v;
      if (k === 'secure') c.secure = true;
      if (k === 'httponly') c.httpOnly = true;
      if (k === 'max-age' && /^-?\d+$/.test(v)) maxAge = Number(v);
      if (k === 'expires' && Number.isFinite(Date.parse(v))) c.expirationDate = Date.parse(v) / 1000;
    }
    if (maxAge !== undefined) c.expirationDate = Date.now() / 1000 + maxAge;
    if (!isBing(c.domain) || !(u.hostname === c.domain || u.hostname.endsWith('.' + c.domain))) continue;
    const idx = jar.findIndex(x => x.name === c.name && x.domain.replace(/^\./, '') === c.domain && (x.path || '/') === c.path);
    if (idx >= 0) jar.splice(idx, 1);
    if (!c.expirationDate || c.expirationDate > Date.now() / 1000) jar.push(c);
  }
}
// Cookie headers are recalculated on every redirect; OAuth headers never cross origins.
async function request(url, options = {}) {
  let current = new URL(url); let method = options.method || 'GET'; let body = options.body;
  let headers = { ...options.headers }; const initialOrigin = current.origin;
  const timeout = AbortSignal.timeout(options.timeout || 20000);
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (current.protocol !== 'https:' && !options.allowHttp) throw fail('拒绝向非 HTTPS 地址发送请求');
    if (options.allowedHosts && !options.allowedHosts.includes(current.hostname)) throw fail('请求重定向到了未允许的域名');
    const sent = { ...headers };
    delete sent.Cookie; delete sent.cookie;
    if (options.cookies) {
      const value = cookieHeader(options.cookies, current.href); if (value) sent.Cookie = value;
    }
    const response = await fetch(current, { method, body, headers: sent, redirect: 'manual', signal: timeout });
    if (options.cookies) mergeSetCookies(options.cookies, response.headers.getSetCookie(), current.href);
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.has('location')) {
      await response.body?.cancel();
      const next = new URL(response.headers.get('location'), current);
      if (next.origin !== initialOrigin) {
        for (const key of Object.keys(headers)) if (/authorization|cookie/i.test(key)) delete headers[key];
        if (method !== 'GET' && method !== 'HEAD') throw fail('拒绝跨域重定向带有凭据的请求体');
      }
      if (response.status === 303 || ([301, 302].includes(response.status) && method === 'POST')) {
        method = 'GET'; body = undefined;
        for (const key of Object.keys(headers)) if (/^content-type$/i.test(key)) delete headers[key];
      }
      current = next; continue;
    }
    const chunks = []; let size = 0;
    for await (const chunk of response.body || []) {
      size += chunk.length; if (size > 4 * 1024 * 1024) throw fail('响应内容超过允许大小');
      chunks.push(Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (!response.ok) throw fail(`${current.hostname} 返回 HTTP ${response.status}`, `HTTP_${response.status}`);
    if (options.json) {
      try { return JSON.parse(text); } catch (_) { throw fail(`${current.hostname} 返回了非 JSON 数据，请检查登录状态`); }
    }
    return text;
  }
  throw fail('重定向次数过多，可能需要重新登录');
}
async function tokenRequest(fields) {
  const data = await request('https://login.live.com/oauth20_token.srf', {
    method: 'POST', json: true, allowedHosts: ['login.live.com'],
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT, scope: SCOPE, redirect_uri: REDIRECT, ...fields }).toString()
  });
  if (data.error || typeof data.access_token !== 'string' || typeof data.refresh_token !== 'string' || !Number.isFinite(Number(data.expires_in))) {
    throw fail('App 授权不可用，请在浏览器重新授权', 'AUTH_APP');
  }
  return { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() / 1000 + Number(data.expires_in) };
}
async function exchangeCode(code) { return tokenRequest({ grant_type: 'authorization_code', code }); }
async function appToken(force = false) {
  return withLock('oauth', async () => {
    const creds = readCredentials();
    if (!force && creds.app?.access_token && creds.app.expires_at > Date.now() / 1000 + 300) return creds.app.access_token;
    const refresh = creds.app?.refresh_token || process.env.REWARDS_REFRESH_TOKEN;
    if (!refresh) throw fail('尚未完成 App 授权，请使用浏览器助手的授权菜单', 'AUTH_APP');
    const app = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh });
    await updateCredentials(c => ({ ...c, app: { ...c.app, ...app } })); return app.access_token;
  }, 45000);
}
module.exports = { DATA_DIR, CLIENT, SCOPE, REDIRECT, fail, safeError, delay, withLock, readJSON, writeJSON,
  readCredentials, updateCredentials, cookieMatches, cookieHeader, mergeSetCookies, request, exchangeCode, appToken, isBing };
