// ============================================================
//  Cloudflare Worker - 导航站 v2（KV 存储版）
//  绑定 KV 命名空间：LINKS_KV
//  环境变量：PASSWORD（可选）、APEX_DOMAIN（可选）、SITE_DOMAIN（可选）
//
//  v2 改动：
//   1. 全新极简现代 UI（中性色 + 单一强调色，日/夜自动跟随系统）
//   2. 导航页：搜索（按 / 聚焦）、标签筛选、状态点 + 延迟
//   3. ID 由服务端自动生成，后台不再需要手动输入
//   4. 标签改为多标签；输入即补全、自动去重（忽略大小写）；
//      新增「标签管理」：全局重命名 / 合并 / 删除
//   5. 服务商列表去重（别名自动归一，如 BWH → 搬瓦工）
//   6. 后台支持拖拽排序、搜索
//   7. 兼容旧数据：旧的单个 tag 字段自动迁移为 tags 数组
// ============================================================

const KV_KEY = 'links';
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_LINKS = 200;
const MAX_TAGS_PER_LINK = 8;

// ---------- 通用工具 ----------
function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeLinkUrl(value = '') {
    try {
        const parsed = new URL(String(value));
        return /^https?:$/.test(parsed.protocol) ? parsed.href : '#';
    } catch { return '#'; }
}

function safeJson(data) {
    return JSON.stringify(data)
        .replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
        .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
}

function html(body, extra = {}, status = 200) {
    return new Response(body, {
        status,
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'same-origin',
            ...extra
        }
    });
}

// ---------- 认证（HMAC 签名 token） ----------
async function hmacSign(secret, message) {
    const key = await crypto.subtle.importKey(
        'raw', new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
    let bin = '';
    for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

async function makeAuthToken(password) {
    const exp = Date.now() + TOKEN_TTL_MS;
    return `${exp}.${await hmacSign(password, String(exp))}`;
}

async function verifyAuthToken(token, password) {
    if (!token) return false;
    const dot = token.indexOf('.');
    if (dot === -1) return false;
    const exp = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    if (!exp || !sig || Date.now() > Number(exp)) return false;
    return timingSafeEqual(sig, await hmacSign(password, exp));
}

// ---------- 数据规范化 ----------
function genId() {
    const bytes = crypto.getRandomValues(new Uint8Array(5));
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

const tagKey = (s) => String(s).toLowerCase().replace(/\s+/g, '');

function normalizeTags(raw) {
    const out = [];
    const seen = new Set();
    for (const t of Array.isArray(raw) ? raw : []) {
        const name = String(t ?? '').trim().slice(0, 24);
        const k = tagKey(name);
        if (!name || seen.has(k)) continue;
        seen.add(k);
        out.push(name);
        if (out.length >= MAX_TAGS_PER_LINK) break;
    }
    return out;
}

// 将任意输入规范化为标准链接对象；非法时抛错
function normalizeLink(raw, usedIds) {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid link');
    const title = String(raw.title ?? '').trim().slice(0, 40);
    if (!title) throw new Error('服务商/标题不能为空');
    const urlStr = String(raw.url ?? '').trim();
    let parsed;
    try { parsed = new URL(urlStr); } catch { throw new Error('URL 无效'); }
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('Only HTTP/HTTPS URLs are allowed');

    let id = String(raw.id ?? '').trim();
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id)) id = '';
    if (id && usedIds.has(id)) throw new Error(`Duplicate ID: ${id}`);
    if (!id) { do { id = genId(); } while (usedIds.has(id)); }
    usedIds.add(id);

    // 兼容旧的单个 tag 字段
    const rawTags = Array.isArray(raw.tags) ? raw.tags : (raw.tag ? [raw.tag] : []);

    return {
        id,
        title,
        highlight: String(raw.highlight ?? '').trim().slice(0, 40),
        icon: String(raw.icon ?? '').trim().slice(0, 8) || '🔗',
        desc: String(raw.desc ?? '').trim().slice(0, 80),
        tags: normalizeTags(rawTags),
        url: parsed.href
    };
}

function normalizeList(list) {
    const used = new Set();
    return list.map(it => normalizeLink(it, used));
}

const DEFAULT_LINKS = [
    { id: 'bwh', title: '搬瓦工', highlight: 'Megebox Pro', icon: '🖥️', desc: '高速稳定 · 极低延迟', tags: ['Bandwagon'], url: 'https://example.com/' },
    { id: 'dmit', title: 'Dmit', highlight: 'Corona', icon: '🌐', desc: '优质线路 · 畅快体验', tags: ['Dmit'], url: 'https://example.org/' }
];

// ============================================================
//  Worker 入口
// ============================================================
export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const path = url.pathname;
        const host = url.hostname;

        // 可选：设置 APEX_DOMAIN（如 example.com）后，裸域名会 301 跳转到 www
        const APEX_DOMAIN = (env.APEX_DOMAIN || '').trim().toLowerCase();
        if (APEX_DOMAIN && host.toLowerCase() === APEX_DOMAIN) {
            return Response.redirect(`https://www.${APEX_DOMAIN}${path}${url.search}`, 301);
        }

        // 必须设置 PASSWORD（不再提供默认密码，避免开源后被人用默认口令登录）
        const PASSWORD = env.PASSWORD;
        if (!PASSWORD || String(PASSWORD).length < 6) {
            return html(setupPage(host), {}, 503);
        }
        if (!env.LINKS_KV) {
            return html(setupPage(host, 'kv'), {}, 503);
        }
        const SITE_DOMAIN = env.SITE_DOMAIN || host;
        const YEAR = new Date().getFullYear();

        async function getLinks() {
            try {
                const data = await env.LINKS_KV.get(KV_KEY, 'json');
                if (Array.isArray(data) && data.length > 0) {
                    const used = new Set();
                    return data.map(it => {
                        try { return normalizeLink(it, used); } catch { return null; }
                    }).filter(Boolean);
                }
            } catch (e) { /* ignore */ }
            return normalizeList(DEFAULT_LINKS);
        }
        async function saveLinks(links) {
            await env.LINKS_KV.put(KV_KEY, JSON.stringify(links));
        }
        async function isAuthenticated(req) {
            const cookie = req.headers.get('Cookie') || '';
            const m = cookie.match(/auth_token=([^;]+)/);
            if (!m) return false;
            let token;
            try { token = decodeURIComponent(m[1]); } catch { return false; }
            return verifyAuthToken(token, PASSWORD);
        }

        // ---------------- API ----------------
        if (path.startsWith('/api/')) {
            if (!(await isAuthenticated(request))) return json({ error: 'Unauthorized' }, 401);

            if (path === '/api/links' && request.method === 'GET') {
                return json(await getLinks());
            }

            // POST /api/links  —— 整体保存（新增 / 排序 / 标签批量修改）；缺少 ID 的条目自动生成
            if (path === '/api/links' && request.method === 'POST') {
                try {
                    const body = await request.json();
                    if (!Array.isArray(body)) throw new Error('Invalid data');
                    if (body.length > MAX_LINKS) throw new Error('Too many links');
                    const used = new Set();
                    const links = body.map(it => normalizeLink(it, used));
                    await saveLinks(links);
                    return json({ success: true, links });
                } catch (e) {
                    return json({ error: e.message }, 400);
                }
            }

            if (path.startsWith('/api/links/') && request.method === 'DELETE') {
                let id = path.split('/').pop();
                try { id = decodeURIComponent(id); } catch (e) { /* ignore */ }
                const links = await getLinks();
                const filtered = links.filter(i => i.id !== id);
                if (filtered.length === links.length) return json({ error: `Link "${id}" not found` }, 404);
                await saveLinks(filtered);
                return json({ success: true });
            }

            if (path.startsWith('/api/links/') && request.method === 'PUT') {
                let id = path.split('/').pop();
                try { id = decodeURIComponent(id); } catch (e) { /* ignore */ }
                try {
                    const updated = await request.json();
                    if (!updated || typeof updated !== 'object') throw new Error('Invalid data');
                    const links = await getLinks();
                    const index = links.findIndex(i => i.id === id);
                    if (index === -1) return json({ error: 'Not found' }, 404);
                    const merged = normalizeLink({ ...links[index], ...updated, id }, new Set());
                    links[index] = merged;
                    await saveLinks(links);
                    return json({ success: true, link: merged });
                } catch (e) {
                    return json({ error: e.message }, 400);
                }
            }

            // GET /api/status —— 服务端探测可访问性，返回状态码与延迟
            if (path === '/api/status' && request.method === 'GET') {
                const links = await getLinks();
                const results = await Promise.all(links.map(async (item) => {
                    const target = safeLinkUrl(item.url);
                    if (target === '#') return { id: item.id, ok: false };
                    const controller = new AbortController();
                    const timer = setTimeout(() => controller.abort(), 8000);
                    const t0 = Date.now();
                    try {
                        const resp = await fetch(target, { method: 'GET', redirect: 'follow', signal: controller.signal });
                        const ms = Date.now() - t0;
                        if (resp.body) { try { await resp.body.cancel(); } catch (e) { /* ignore */ } }
                        return { id: item.id, ok: resp.status >= 200 && resp.status < 400, status: resp.status, ms };
                    } catch (e) {
                        return { id: item.id, ok: false };
                    } finally {
                        clearTimeout(timer);
                    }
                }));
                return json(results);
            }

            return json({ error: 'Not Found' }, 404);
        }

        // ---------------- 登录 / 退出 ----------------
        if (path === '/login' && request.method === 'POST') {
            const form = await request.formData();
            const input = String(form.get('password') || '');
            if (timingSafeEqual(input, String(PASSWORD))) {
                const token = await makeAuthToken(PASSWORD);
                return new Response(null, {
                    status: 302,
                    headers: {
                        'Location': '/',
                        'Set-Cookie': `auth_token=${encodeURIComponent(token)}; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Strict`
                    }
                });
            }
            return html(loginPage(true, SITE_DOMAIN, YEAR));
        }

        if (path === '/logout') {
            return new Response(null, {
                status: 302,
                headers: {
                    'Location': '/',
                    'Set-Cookie': 'auth_token=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict'
                }
            });
        }

        // ---------------- 管理后台 ----------------
        if (path === '/admin') {
            if (!(await isAuthenticated(request))) {
                return new Response(null, { status: 302, headers: { 'Location': '/' } });
            }
            return html(adminPage(SITE_DOMAIN, YEAR));
        }

        // ---------------- 主页 ----------------
        if (await isAuthenticated(request)) {
            return html(contentPage(await getLinks(), SITE_DOMAIN, YEAR));
        }
        return html(loginPage(false, SITE_DOMAIN, YEAR));
    }
};

// ============================================================
//  共享：主题 / 基础样式
// ============================================================
const THEME_INIT = `<script>try{var t=localStorage.getItem('theme');if(!t)t=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme='dark'}</script>`;

const ICON_SUN = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`;
const ICON_MOON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`;

const THEME_BTN = `<button class="icon-btn" id="themeBtn" type="button" aria-label="切换主题" title="切换主题"><span class="i-sun">${ICON_SUN}</span><span class="i-moon">${ICON_MOON}</span></button>`;

const THEME_JS = `
(function(){
  var b=document.getElementById('themeBtn');if(!b)return;
  b.addEventListener('click',function(){
    var n=document.documentElement.dataset.theme==='light'?'dark':'light';
    document.documentElement.dataset.theme=n;
    try{localStorage.setItem('theme',n)}catch(e){}
  });
})();`;

const BASE_CSS = `
:root{
  --bg:#09090b;--surface:#111113;--surface2:#1a1a1e;--border:#26262b;--border-strong:#3a3a42;
  --text:#fafafa;--muted:#9a9aa5;--faint:#6b6b76;
  --accent:#7c83ff;--accent-soft:rgba(124,131,255,.14);--accent-fg:#0b0b14;
  --ok:#34d399;--bad:#f87171;--warn:#fbbf24;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 8px 30px rgba(0,0,0,.25);
  --radius:14px;color-scheme:dark;
}
[data-theme=light]{
  --bg:#f5f6f8;--surface:#ffffff;--surface2:#f0f1f4;--border:#e3e5ea;--border-strong:#cfd2da;
  --text:#14151a;--muted:#5d6270;--faint:#8b90a0;
  --accent:#4f46e5;--accent-soft:rgba(79,70,229,.09);--accent-fg:#ffffff;
  --ok:#059669;--bad:#dc2626;--warn:#d97706;
  --shadow:0 1px 2px rgba(20,21,26,.06),0 8px 30px rgba(20,21,26,.07);
  color-scheme:light;
}
*{margin:0;padding:0;box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',Roboto,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;line-height:1.5;-webkit-font-smoothing:antialiased}
body::before{content:'';position:fixed;inset:0;pointer-events:none;z-index:0;
  background:radial-gradient(900px 420px at 50% -120px,var(--accent-soft),transparent 70%)}
a{color:inherit;text-decoration:none}
button,input{font-family:inherit;font-size:inherit;color:inherit}
button{cursor:pointer}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.i-sun{display:none}.i-moon{display:inline-flex}
[data-theme=dark] .i-sun{display:inline-flex}[data-theme=dark] .i-moon{display:none}

.icon-btn{display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;border-radius:10px;border:1px solid var(--border);background:var(--surface);color:var(--muted);transition:.15s}
.icon-btn:hover{color:var(--text);border-color:var(--border-strong);background:var(--surface2)}

.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:38px;padding:0 16px;border-radius:10px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-weight:500;font-size:14px;transition:.15s;white-space:nowrap}
.btn:hover{border-color:var(--border-strong);background:var(--surface2)}
.btn-primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
.btn-primary:hover{background:var(--accent);filter:brightness(1.1)}
.btn-danger:hover{color:var(--bad);border-color:var(--bad)}
.btn:disabled{opacity:.5;cursor:not-allowed}

.input{width:100%;height:40px;padding:0 12px;border-radius:10px;border:1px solid var(--border);background:var(--surface);color:var(--text);outline:none;transition:.15s}
.input::placeholder{color:var(--faint)}
.input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}

.chip{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 9px;border-radius:999px;font-size:12px;font-weight:500;background:var(--surface2);border:1px solid var(--border);color:var(--muted);white-space:nowrap}

@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important}}
`;


// ============================================================
//  未配置提示页（缺少 PASSWORD / KV 绑定时显示）
// ============================================================
function setupPage(host, kind) {
    const msg = kind === 'kv'
        ? '尚未绑定 KV 命名空间。请在 Worker 的 Settings → Bindings 中添加 KV 绑定，变量名填 <code>LINKS_KV</code>。'
        : '尚未设置访问密码。请在 Worker 的 Settings → Variables and Secrets 中添加名为 <code>PASSWORD</code> 的 Secret（至少 6 位）。';
    return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>需要配置 · ${escapeHtml(host)}</title>${THEME_INIT}
<style>${BASE_CSS}body{display:flex;align-items:center;justify-content:center;padding:20px}
.c{position:relative;z-index:1;max-width:460px;background:var(--surface);border:1px solid var(--border);border-radius:18px;padding:28px;box-shadow:var(--shadow)}
h1{font-size:20px;margin-bottom:10px}p{color:var(--muted);font-size:14px}code{background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:1px 6px;font-size:13px;color:var(--text)}</style>
</head><body><div class="c"><h1>⚙️ 还差一步配置</h1><p>${msg}</p><p style="margin-top:10px">保存后刷新本页即可。</p></div></body></html>`;
}

// ============================================================
//  登录页
// ============================================================
function loginPage(hasError, siteDomain, year) {
    return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>登录 · ${escapeHtml(siteDomain)}</title>
${THEME_INIT}
<style>
${BASE_CSS}
body{display:flex;align-items:center;justify-content:center;padding:20px}
.wrap{position:relative;z-index:1;width:100%;max-width:380px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:36px 30px 28px;box-shadow:var(--shadow)}
.logo{width:44px;height:44px;border-radius:12px;background:var(--accent-soft);color:var(--accent);display:flex;align-items:center;justify-content:center;margin-bottom:18px}
h1{font-size:22px;font-weight:650;letter-spacing:-.01em}
.sub{color:var(--muted);font-size:14px;margin:4px 0 24px}
.field{position:relative;margin-bottom:14px}
.field .input{height:46px;padding-right:44px}
.eye{position:absolute;right:6px;top:50%;transform:translateY(-50%);width:34px;height:34px;border:none;background:none;color:var(--faint);border-radius:8px;display:flex;align-items:center;justify-content:center}
.eye:hover{color:var(--text)}
.submit{width:100%;height:46px;font-size:15px}
.err{margin-bottom:14px;padding:10px 12px;border-radius:10px;font-size:13px;color:var(--bad);background:color-mix(in srgb,var(--bad) 10%,transparent);border:1px solid color-mix(in srgb,var(--bad) 30%,transparent)}
.foot{text-align:center;color:var(--faint);font-size:12px;margin-top:18px}
.theme{position:fixed;top:16px;right:16px;z-index:5}
</style>
</head>
<body>
<div class="theme">${THEME_BTN}</div>
<div class="wrap">
  <form class="card" method="POST" action="/login" autocomplete="off">
    <div class="logo"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg></div>
    <h1>访问验证</h1>
    <div class="sub">请输入密码以继续</div>
    ${hasError ? '<div class="err">密码错误，请重试</div>' : ''}
    <div class="field">
      <input class="input" type="password" id="pw" name="password" placeholder="密码" required autofocus>
      <button class="eye" type="button" id="eye" aria-label="显示密码"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg></button>
    </div>
    <button class="btn btn-primary submit" type="submit">进入</button>
    <div class="foot">© ${year} ${escapeHtml(siteDomain)}</div>
  </form>
</div>
<script>
document.getElementById('eye').addEventListener('click',function(){var p=document.getElementById('pw');p.type=p.type==='password'?'text':'password';});
${THEME_JS}
</script>
</body>
</html>`;
}

// ============================================================
//  导航页
// ============================================================
const NAV_CSS = `
.page{position:relative;z-index:1;max-width:1080px;margin:0 auto;padding:0 20px 40px}
.topbar{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:10px;padding:14px 0;background:color-mix(in srgb,var(--bg) 82%,transparent);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}
.brand{display:flex;align-items:center;gap:10px;font-weight:650;font-size:16px;letter-spacing:-.01em;margin-right:6px}
.brand .mark{width:30px;height:30px;border-radius:9px;background:var(--accent);color:var(--accent-fg);display:flex;align-items:center;justify-content:center}
.search{position:relative;flex:1;min-width:0}
.search svg{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--faint);pointer-events:none}
.search .input{padding-left:38px;padding-right:44px}
.kbd{position:absolute;right:10px;top:50%;transform:translateY(-50%);font-size:11px;color:var(--faint);border:1px solid var(--border);border-radius:6px;padding:1px 6px;background:var(--surface2);pointer-events:none}
.hero{padding:28px 0 8px}
.hero h1{font-size:28px;font-weight:700;letter-spacing:-.02em}
.hero p{color:var(--muted);margin-top:4px;font-size:14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0 20px}
.filter{height:32px;padding:0 13px;border-radius:999px;border:1px solid var(--border);background:var(--surface);color:var(--muted);font-size:13px;font-weight:500;transition:.15s;display:inline-flex;align-items:center;gap:6px}
.filter:hover{color:var(--text);border-color:var(--border-strong)}
.filter.active{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
.filter .n{font-size:11px;opacity:.65}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
.card{position:relative;display:flex;flex-direction:column;gap:14px;padding:18px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);transition:transform .18s,border-color .18s,box-shadow .18s;animation:rise .35s ease both}
.card:hover{transform:translateY(-3px);border-color:var(--accent);box-shadow:var(--shadow)}
@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.card-top{display:flex;align-items:center;gap:12px}
.ico{width:44px;height:44px;border-radius:12px;background:var(--surface2);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0}
.meta{min-width:0;flex:1}
.name{font-weight:600;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.type{color:var(--accent);font-weight:500;margin-left:6px}
.host{color:var(--faint);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.desc{color:var(--muted);font-size:13px;min-height:19px}
.card-bottom{display:flex;align-items:center;justify-content:space-between;gap:10px}
.tags{display:flex;gap:6px;flex-wrap:wrap;min-width:0}
.stat{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--faint);flex-shrink:0}
.dot{width:8px;height:8px;border-radius:50%;background:var(--faint)}
.dot.checking{background:var(--warn);animation:pulse 1.1s ease-in-out infinite}
.dot.ok{background:var(--ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--ok) 20%,transparent)}
.dot.bad{background:var(--bad);box-shadow:0 0 0 3px color-mix(in srgb,var(--bad) 20%,transparent)}
@keyframes pulse{0%,100%{opacity:.4}50%{opacity:1}}
.empty{grid-column:1/-1;text-align:center;color:var(--faint);padding:60px 0}
.footer{margin-top:36px;padding-top:18px;border-top:1px solid var(--border);color:var(--faint);font-size:12px;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}
.spin svg{transition:transform .5s}.spin.run svg{animation:rot .8s linear infinite}
@keyframes rot{to{transform:rotate(360deg)}}
@media(max-width:560px){.brand span.t{display:none}.hero h1{font-size:23px}.grid{grid-template-columns:1fr}.kbd{display:none}.search .input{padding-right:12px}}
`;

const NAV_JS = String.raw`
(function(){
var LINKS=window.__LINKS__||[];
var $=function(s){return document.querySelector(s)};
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function safeUrl(u){try{var p=new URL(u);return /^https?:$/.test(p.protocol)?p.href:'#'}catch(e){return '#'}}
function hostOf(u){try{return new URL(u).host}catch(e){return ''}}
var norm=function(s){return String(s).toLowerCase().replace(/\s+/g,'')};

var activeTag=null,query='',status={};

function tagList(){
  var map={},order=[];
  LINKS.forEach(function(l){(l.tags||[]).forEach(function(t){
    var k=norm(t);if(!map[k]){map[k]={name:t,n:0};order.push(k)}map[k].n++;
  })});
  return order.map(function(k){return map[k]}).sort(function(a,b){return b.n-a.n||a.name.localeCompare(b.name)});
}

function renderFilters(){
  var tags=tagList(),el=$('#filters');
  if(!tags.length){el.innerHTML='';return}
  var h='<button class="filter'+(activeTag===null?' active':'')+'" data-tag="">全部 <span class="n">'+LINKS.length+'</span></button>';
  tags.forEach(function(t){
    h+='<button class="filter'+(activeTag===norm(t.name)?' active':'')+'" data-tag="'+esc(norm(t.name))+'">'+esc(t.name)+' <span class="n">'+t.n+'</span></button>';
  });
  el.innerHTML=h;
}

function matches(l){
  if(activeTag!==null&&!(l.tags||[]).some(function(t){return norm(t)===activeTag}))return false;
  if(!query)return true;
  var q=norm(query);
  var hay=norm([l.title,l.highlight,l.desc,(l.tags||[]).join(' '),hostOf(l.url)].join(' '));
  return hay.indexOf(q)!==-1;
}

function statusHtml(id){
  var s=status[id];
  if(!s)return '<span class="dot checking"></span><span>检测中</span>';
  if(s.ok)return '<span class="dot ok"></span><span>'+(s.ms!=null?s.ms+' ms':'在线')+'</span>';
  return '<span class="dot bad"></span><span>不可达</span>';
}

function render(){
  var list=LINKS.filter(matches),el=$('#grid');
  if(!list.length){el.innerHTML='<div class="empty">没有匹配的链接</div>';return}
  el.innerHTML=list.map(function(l,i){
    return '<a class="card" style="animation-delay:'+Math.min(i,12)*30+'ms" href="'+esc(safeUrl(l.url))+'" target="_blank" rel="noopener noreferrer">'+
      '<div class="card-top"><div class="ico">'+esc(l.icon||'🔗')+'</div>'+
      '<div class="meta"><div class="name">'+esc(l.title)+(l.highlight?'<span class="type">'+esc(l.highlight)+'</span>':'')+'</div>'+
      '<div class="host">'+esc(hostOf(l.url))+'</div></div></div>'+
      '<div class="desc">'+esc(l.desc||'')+'</div>'+
      '<div class="card-bottom"><div class="tags">'+(l.tags||[]).map(function(t){return '<span class="chip">'+esc(t)+'</span>'}).join('')+'</div>'+
      '<span class="stat" data-stat="'+esc(l.id)+'">'+statusHtml(l.id)+'</span></div></a>';
  }).join('');
}

function paintStatus(){
  document.querySelectorAll('[data-stat]').forEach(function(el){el.innerHTML=statusHtml(el.getAttribute('data-stat'))});
}

function loadStatus(){
  var btn=$('#refresh');btn.classList.add('run');
  status={};paintStatus();
  fetch('/api/status',{cache:'no-store'}).then(function(r){return r.ok?r.json():Promise.reject()})
  .then(function(rs){rs.forEach(function(r){status[r.id]=r});})
  .catch(function(){LINKS.forEach(function(l){status[l.id]={ok:false}})})
  .then(function(){paintStatus();btn.classList.remove('run')});
}

$('#filters').addEventListener('click',function(e){
  var b=e.target.closest('.filter');if(!b)return;
  var t=b.getAttribute('data-tag');activeTag=t===''?null:t;
  renderFilters();render();
});
var s=$('#q');
s.addEventListener('input',function(){query=s.value.trim();render()});
document.addEventListener('keydown',function(e){
  var tag=(document.activeElement&&document.activeElement.tagName)||'';
  if(e.key==='/'&&tag!=='INPUT'){e.preventDefault();s.focus()}
  else if(e.key==='Escape'&&document.activeElement===s){s.value='';query='';render();s.blur()}
  else if(e.key==='Enter'&&document.activeElement===s){
    var first=LINKS.filter(matches)[0];if(first){window.open(safeUrl(first.url),'_blank','noopener')}
  }
});
$('#refresh').addEventListener('click',loadStatus);

renderFilters();render();loadStatus();
})();`;

function contentPage(links, siteDomain, year) {
    return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>导航 · ${escapeHtml(siteDomain)}</title>
${THEME_INIT}
<style>
${BASE_CSS}
${NAV_CSS}
</style>
</head>
<body>
<div class="page">
  <header class="topbar">
    <div class="brand"><div class="mark"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 4 7v10l8 5 8-5V7z"/><path d="M12 22V12M4 7l8 5 8-5"/></svg></div><span class="t">导航</span></div>
    <label class="search">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input class="input" id="q" type="search" placeholder="搜索名称、标签、域名…" autocomplete="off">
      <span class="kbd">/</span>
    </label>
    <button class="icon-btn spin" id="refresh" type="button" title="重新检测状态" aria-label="重新检测状态"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg></button>
    ${THEME_BTN}
    <a class="icon-btn" href="/admin" title="管理" aria-label="管理"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg></a>
    <a class="icon-btn" href="/logout" title="退出登录" aria-label="退出登录"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/></svg></a>
  </header>

  <section class="hero">
    <h1>服务入口</h1>
    <p>共 ${links.length} 个链接 · 按 <span class="chip" style="height:20px">/</span> 聚焦搜索框，搜索时按 <span class="chip" style="height:20px">Enter</span> 直接进入第一个链接</p>
  </section>

  <div class="filters" id="filters"></div>
  <div class="grid" id="grid"></div>

  <footer class="footer"><span>© ${year} ${escapeHtml(siteDomain)}</span><span>状态检测由服务端发起，仅供参考</span></footer>
</div>
<script>window.__LINKS__=${safeJson(links)};</script>
<script>${NAV_JS}</script>
<script>${THEME_JS}</script>
</body>
</html>`;
}

// ============================================================
//  管理后台
// ============================================================
const ADMIN_CSS = `
.page{position:relative;z-index:1;max-width:960px;margin:0 auto;padding:0 20px 60px}
.topbar{display:flex;align-items:center;gap:10px;padding:18px 0}
.topbar h1{font-size:20px;font-weight:650;letter-spacing:-.01em;flex:1}
.back{display:inline-flex;align-items:center;gap:6px;color:var(--muted);font-size:14px}
.back:hover{color:var(--text)}
.toolbar{display:flex;gap:10px;margin:6px 0 16px;flex-wrap:wrap}
.toolbar .search{flex:1;min-width:180px}
.list{display:flex;flex-direction:column;gap:8px}
.row{display:flex;align-items:center;gap:12px;padding:12px 14px;background:var(--surface);border:1px solid var(--border);border-radius:12px;transition:border-color .15s,opacity .15s}
.row:hover{border-color:var(--border-strong)}
.row.dragging{opacity:.4}
.row.over{border-color:var(--accent);box-shadow:0 -2px 0 var(--accent)}
.grip{color:var(--faint);cursor:grab;user-select:none;font-size:16px;line-height:1;padding:4px 2px;letter-spacing:-2px}
.grip.off{opacity:.25;cursor:not-allowed}
.r-ico{width:38px;height:38px;border-radius:10px;background:var(--surface2);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:19px;flex-shrink:0}
.r-main{flex:1;min-width:0}
.r-name{font-weight:600;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.r-name .type{color:var(--accent);font-weight:500;margin-left:6px}
.r-sub{color:var(--faint);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.r-tags{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;max-width:240px}
.r-act{display:flex;gap:6px}
.r-act .icon-btn{width:34px;height:34px}
.r-act .icon-btn.danger:hover{color:var(--bad);border-color:var(--bad)}
.empty{text-align:center;color:var(--faint);padding:56px 0;border:1px dashed var(--border);border-radius:12px}
.hint{color:var(--faint);font-size:12px;margin-top:14px}

.backdrop{position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.55);backdrop-filter:blur(3px);display:none;align-items:center;justify-content:center;padding:16px}
.backdrop.open{display:flex}
.modal{width:100%;max-width:560px;max-height:92vh;overflow:auto;background:var(--surface);border:1px solid var(--border);border-radius:18px;box-shadow:var(--shadow);animation:pop .18s ease}
@keyframes pop{from{opacity:0;transform:scale(.97) translateY(6px)}to{opacity:1;transform:none}}
.m-head{display:flex;align-items:center;justify-content:space-between;padding:18px 20px 6px}
.m-head h2{font-size:17px;font-weight:650}
.m-body{padding:10px 20px 6px;display:grid;grid-template-columns:1fr 1fr;gap:14px}
.m-body .full{grid-column:1/-1}
.m-foot{display:flex;justify-content:flex-end;gap:10px;padding:14px 20px 18px}
.f label{display:block;font-size:12px;font-weight:500;color:var(--muted);margin-bottom:6px}
.f .opt-label{color:var(--faint);font-weight:400}
.rel{position:relative}
.sug{display:none;position:absolute;left:0;right:0;top:calc(100% + 6px);z-index:60;max-height:220px;overflow-y:auto;padding:6px;background:var(--surface);border:1px solid var(--border-strong);border-radius:12px;box-shadow:var(--shadow)}
.sug.open{display:block}
.sug .opt{display:block;width:100%;text-align:left;padding:8px 10px;border:none;border-radius:8px;background:none;font-size:14px;color:var(--text)}
.sug .opt:hover,.sug .opt.hl{background:var(--accent-soft)}
.ins-btn{position:absolute;right:5px;top:50%;transform:translateY(-50%);width:34px;height:30px;border-radius:8px;border:1px solid var(--border);background:var(--surface2);color:var(--text);font-size:20px;font-weight:700;line-height:1;display:flex;align-items:center;justify-content:center;transition:.15s}
.ins-btn:hover{border-color:var(--accent);color:var(--accent)}
.icons{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.icons button{width:34px;height:34px;border-radius:9px;border:1px solid var(--border);background:var(--surface2);font-size:18px;display:flex;align-items:center;justify-content:center;transition:.12s}
.icons button:hover{border-color:var(--accent)}
.icons button.on{border-color:var(--accent);background:var(--accent-soft)}
.tagbox{display:flex;flex-wrap:wrap;gap:6px;align-items:center;min-height:40px;padding:5px 8px;border:1px solid var(--border);border-radius:10px;background:var(--surface);transition:.15s;cursor:text}
.tagbox:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.tagbox input{flex:1;min-width:90px;height:28px;border:none;background:none;outline:none;color:var(--text)}
.tagbox .chip{background:var(--accent-soft);border-color:transparent;color:var(--accent);height:26px}
.tagbox .chip button{border:none;background:none;color:inherit;font-size:14px;line-height:1;padding:0 0 1px 2px;opacity:.7}
.tagbox .chip button:hover{opacity:1}
.tm-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)}
.tm-row:last-child{border:none}
.tm-row .input{height:36px}
.tm-n{color:var(--faint);font-size:12px;white-space:nowrap;min-width:48px;text-align:right}
.toasts{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:100;display:flex;flex-direction:column;gap:8px;align-items:center}
.toast{padding:10px 16px;border-radius:10px;background:var(--text);color:var(--bg);font-size:14px;box-shadow:var(--shadow);animation:pop .18s ease}
.toast.error{background:var(--bad);color:#fff}
@media(max-width:600px){.m-body{grid-template-columns:1fr}.r-tags{display:none}}
`;

const ADMIN_JS = String.raw`
(function(){
var API='/api/links';
var links=[],editingId=null,dragId=null,q='';
var $=function(s){return document.querySelector(s)};
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
var norm=function(s){return String(s==null?'':s).toLowerCase().replace(/[^\p{L}\p{N}]/gu,'')};
function hostOf(u){try{return new URL(u).host}catch(e){return u}}

/* ---------- 服务商目录：每行第一个是标准名称，其余是别名（自动归一，避免重复） ---------- */
var PROVIDERS=[
 ['搬瓦工','BWH','Bandwagon','BandwagonHost'],['Vmiss','VMISS'],['DMIT'],['Gomami'],['ISIF'],['V.PS','VPS'],
 ['小秘书'],['BageVM'],['Skyline'],['IPraft'],['Uzumaru'],['RFCHOST'],['Lengend','Legend'],['OrangeVPS'],['Nube'],
 ['Taphip'],['咸鱼云'],['AKKO'],['VIRCS'],['QQPW'],['AaITR','aait'],['WireCat'],['SixtyNet'],
 ['ResidentialVPS','residential','resvps'],['ZoroCloud'],['CstoneCloud'],['Lisa'],['SolaDrive'],['Yin-Net'],
 ['Webshare'],['IP2World'],['MRRDP'],['99RDP'],['IPMela'],['Zgo'],['LightLayer'],['CC'],['CCS'],['RN'],
 ['Misaka'],['Lycheen'],['白丝云'],['Yunyoo'],['Evoxt'],['港仔']
];
var ICONS=['🖥️','💻','🗄️','🌐','🌍','📡','🔗','🚀','⚡','🛡️','🔒','☁️','🛰️','🧩','🔧','📦'];

function canonProvider(name){
  var k=norm(name);if(!k)return String(name||'').trim();
  for(var i=0;i<PROVIDERS.length;i++){
    for(var j=0;j<PROVIDERS[i].length;j++){if(norm(PROVIDERS[i][j])===k)return PROVIDERS[i][0]}
  }
  for(var m=0;m<links.length;m++){if(norm(links[m].title)===k)return links[m].title}
  return String(name).trim();
}
function providerOptions(){
  var seen={},out=[];
  function add(n){var k=norm(n);if(k&&!seen[k]){seen[k]=1;out.push(n)}}
  links.forEach(function(l){add(canonProvider(l.title))});
  PROVIDERS.forEach(function(p){add(p[0])});
  return out;
}

/* ---------- 标签 ---------- */
function tagStats(){
  var map={},order=[];
  links.forEach(function(l){(l.tags||[]).forEach(function(t){
    var k=norm(t);if(!map[k]){map[k]={name:t,n:0};order.push(k)}map[k].n++;
  })});
  return order.map(function(k){return map[k]}).sort(function(a,b){return b.n-a.n||a.name.localeCompare(b.name)});
}

/* ---------- 通用 ---------- */
function toast(msg,type){
  var el=document.createElement('div');el.className='toast'+(type==='error'?' error':'');el.textContent=msg;
  $('#toasts').appendChild(el);setTimeout(function(){el.remove()},type==='error'?4500:2200);
}
function api(method,url,body){
  return fetch(url,{method:method,headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined})
  .then(function(r){return r.json().catch(function(){return {}}).then(function(d){
    if(!r.ok)throw new Error(d.error||('HTTP '+r.status));return d;
  })});
}
function load(){return api('GET',API).then(function(d){links=d;render()}).catch(function(e){toast(e.message,'error')})}
function persist(next,okMsg){
  return api('POST',API,next).then(function(d){links=d.links;render();if(okMsg)toast(okMsg);return true})
  .catch(function(e){toast(e.message,'error');return load().then(function(){return false})});
}
function openModal(id){$(id).classList.add('open')}
function closeModal(id){$(id).classList.remove('open')}

/* ---------- 列表 ---------- */
function render(){
  var el=$('#list'),ql=norm(q);
  var shown=links.filter(function(l){
    if(!ql)return true;
    return norm([l.title,l.highlight,l.desc,(l.tags||[]).join(' '),l.url].join(' ')).indexOf(ql)!==-1;
  });
  $('#count').textContent=links.length+' 个链接';
  if(!shown.length){el.innerHTML='<div class="empty">'+(links.length?'没有匹配的链接':'还没有链接，点击右上角「新增链接」')+'</div>';return}
  el.innerHTML=shown.map(function(l){
    return '<div class="row" data-id="'+esc(l.id)+'" draggable="'+(ql?'false':'true')+'">'+
      '<span class="grip'+(ql?' off':'')+'" title="'+(ql?'搜索时无法排序':'拖动排序')+'">⋮⋮</span>'+
      '<div class="r-ico">'+esc(l.icon||'🔗')+'</div>'+
      '<div class="r-main"><div class="r-name">'+esc(l.title)+(l.highlight?'<span class="type">'+esc(l.highlight)+'</span>':'')+'</div>'+
      '<div class="r-sub">'+esc(l.desc?l.desc+' · ':'')+esc(hostOf(l.url))+'</div></div>'+
      '<div class="r-tags">'+(l.tags||[]).map(function(t){return '<span class="chip">'+esc(t)+'</span>'}).join('')+'</div>'+
      '<div class="r-act"><button class="icon-btn" data-act="edit" title="编辑" aria-label="编辑">✏️</button>'+
      '<button class="icon-btn danger" data-act="del" title="删除" aria-label="删除">🗑️</button></div></div>';
  }).join('');
}

$('#list').addEventListener('click',function(e){
  var b=e.target.closest('[data-act]');if(!b)return;
  var id=b.closest('.row').getAttribute('data-id');
  if(b.getAttribute('data-act')==='edit')openForm(id);
  else{
    var it=links.find(function(l){return l.id===id});
    if(it&&confirm('确认删除「'+it.title+(it.highlight?' '+it.highlight:'')+'」？'))
      api('DELETE',API+'/'+encodeURIComponent(id)).then(function(){toast('已删除');return load()}).catch(function(e){toast(e.message,'error')});
  }
});
$('#list').addEventListener('dragstart',function(e){
  var r=e.target.closest('.row');if(!r)return;dragId=r.getAttribute('data-id');r.classList.add('dragging');
  e.dataTransfer.effectAllowed='move';try{e.dataTransfer.setData('text/plain',dragId)}catch(x){}
});
$('#list').addEventListener('dragover',function(e){
  if(!dragId)return;e.preventDefault();
  document.querySelectorAll('.row.over').forEach(function(x){x.classList.remove('over')});
  var r=e.target.closest('.row');if(r&&r.getAttribute('data-id')!==dragId)r.classList.add('over');
});
$('#list').addEventListener('dragend',function(){dragId=null;document.querySelectorAll('.row.dragging,.row.over').forEach(function(x){x.classList.remove('dragging','over')})});
$('#list').addEventListener('drop',function(e){
  e.preventDefault();var r=e.target.closest('.row');if(!r||!dragId)return;
  var to=r.getAttribute('data-id');if(to===dragId)return;
  var from=links.findIndex(function(l){return l.id===dragId});
  var item=links.splice(from,1)[0];
  var idx=links.findIndex(function(l){return l.id===to});
  links.splice(idx,0,item);dragId=null;render();
  persist(links.slice());
});
$('#search').addEventListener('input',function(e){q=e.target.value.trim();render()});

/* ---------- 下拉建议 ---------- */
function attachSuggest(input,panel,getItems,onPick){
  var hl=-1;
  function items(){var k=norm(input.value);return getItems().filter(function(x){return !k||norm(x).indexOf(k)!==-1}).slice(0,60)}
  function show(){
    var list=items();hl=-1;
    if(!list.length){panel.classList.remove('open');return}
    panel.innerHTML=list.map(function(x){return '<button type="button" class="opt" data-v="'+esc(x)+'">'+esc(x)+'</button>'}).join('');
    panel.classList.add('open');
  }
  input.addEventListener('focus',show);
  input.addEventListener('input',show);
  input.addEventListener('keydown',function(e){
    var opts=panel.querySelectorAll('.opt');
    if(!panel.classList.contains('open')||!opts.length)return;
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){
      e.preventDefault();hl=(hl+(e.key==='ArrowDown'?1:-1)+opts.length)%opts.length;
      opts.forEach(function(o,i){o.classList.toggle('hl',i===hl)});opts[hl].scrollIntoView({block:'nearest'});
    }else if(e.key==='Enter'&&hl>=0){e.preventDefault();e.stopPropagation();onPick(opts[hl].getAttribute('data-v'));panel.classList.remove('open')}
    else if(e.key==='Escape'){panel.classList.remove('open')}
  });
  panel.addEventListener('mousedown',function(e){
    var b=e.target.closest('.opt');if(!b)return;e.preventDefault();
    onPick(b.getAttribute('data-v'));panel.classList.remove('open');
  });
  input.addEventListener('blur',function(){setTimeout(function(){panel.classList.remove('open')},120)});
  return show;
}

/* ---------- 标签输入 ---------- */
var formTags=[];
function renderTagbox(){
  var box=$('#tagbox'),inp=$('#tagInput');
  box.querySelectorAll('.chip').forEach(function(c){c.remove()});
  formTags.forEach(function(t,i){
    var c=document.createElement('span');c.className='chip';
    c.innerHTML=esc(t)+'<button type="button" data-i="'+i+'" aria-label="移除">×</button>';
    box.insertBefore(c,inp);
  });
}
function addFormTag(raw){
  var t=String(raw||'').trim().slice(0,24);if(!t)return;
  var k=norm(t);if(!k)return;
  if(formTags.some(function(x){return norm(x)===k}))return;
  if(formTags.length>=8){toast('每个链接最多 8 个标签','error');return}
  var ex=tagStats().find(function(s){return norm(s.name)===k});
  formTags.push(ex?ex.name:t);renderTagbox();
}
$('#tagbox').addEventListener('click',function(e){
  var b=e.target.closest('button[data-i]');
  if(b){formTags.splice(Number(b.getAttribute('data-i')),1);renderTagbox()}
  $('#tagInput').focus();
});
$('#tagInput').addEventListener('keydown',function(e){
  var v=this.value;
  if(e.key==='Enter'||e.key===','||e.key==='，'){
    if(v.trim()||e.key!=='Enter'){e.preventDefault();addFormTag(v);this.value=''}
  }else if(e.key==='Backspace'&&!v&&formTags.length){formTags.pop();renderTagbox()}
});
$('#tagInput').addEventListener('blur',function(){var v=this.value;setTimeout(function(){if(v.trim()){addFormTag(v);$('#tagInput').value=''}},130)});
attachSuggest($('#tagInput'),$('#tagSug'),function(){
  return tagStats().map(function(s){return s.name}).filter(function(n){return !formTags.some(function(x){return norm(x)===norm(n)})});
},function(v){addFormTag(v);$('#tagInput').value='';$('#tagInput').focus()});

/* ---------- 新增 / 编辑表单 ---------- */
attachSuggest($('#fTitle'),$('#titleSug'),providerOptions,function(v){$('#fTitle').value=v});
$('#fTitle').addEventListener('blur',function(){var v=this.value.trim();if(v)this.value=canonProvider(v)});

$('#iconRow').innerHTML=ICONS.map(function(i){return '<button type="button" data-i="'+i+'">'+i+'</button>'}).join('');
function syncIconSel(){document.querySelectorAll('#iconRow button').forEach(function(b){b.classList.toggle('on',b.getAttribute('data-i')===$('#fIcon').value.trim())})}
$('#iconRow').addEventListener('click',function(e){var b=e.target.closest('button');if(!b)return;$('#fIcon').value=b.getAttribute('data-i');syncIconSel()});
$('#fIcon').addEventListener('input',syncIconSel);

/* 描述框：在光标处插入 " · "（避免重复空格） */
function insertDot(){
  var el=$('#fDesc'),v=el.value,s=el.selectionStart==null?v.length:el.selectionStart,e=el.selectionEnd==null?s:el.selectionEnd;
  var before=v.slice(0,s),after=v.slice(e);
  var ins=(before===''||/\s$/.test(before)?'':' ')+'·'+(/^\s/.test(after)?'':' ');
  var next=before+ins+after;
  if(next.length>el.maxLength&&el.maxLength>0)return;
  el.value=next;var pos=(before+ins).length;
  el.focus();try{el.setSelectionRange(pos,pos)}catch(x){}
}
$('#insDot').addEventListener('mousedown',function(e){e.preventDefault()});
$('#insDot').addEventListener('click',insertDot);
$('#fDesc').addEventListener('keydown',function(e){if(e.altKey&&(e.key==='.'||e.code==='Period')){e.preventDefault();insertDot()}});

function openForm(id){
  editingId=id||null;
  var it=id?links.find(function(l){return l.id===id}):null;
  $('#formTitle').textContent=it?'编辑链接':'新增链接';
  $('#fTitle').value=it?it.title:'';
  $('#fType').value=it?it.highlight||'':'';
  $('#fIcon').value=it?it.icon||'':'🔗';
  $('#fDesc').value=it?it.desc||'':'';
  $('#fUrl').value=it?it.url:'';
  formTags=it?(it.tags||[]).slice():[];$('#tagInput').value='';renderTagbox();syncIconSel();
  openModal('#formModal');setTimeout(function(){$('#fTitle').focus()},30);
}
$('#addBtn').addEventListener('click',function(){openForm(null)});
$('#formCancel').addEventListener('click',function(){closeModal('#formModal')});

function submitForm(){
  addFormTag($('#tagInput').value);$('#tagInput').value='';
  var data={
    title:canonProvider($('#fTitle').value.trim()),
    highlight:$('#fType').value.trim(),
    icon:$('#fIcon').value.trim()||'🔗',
    desc:$('#fDesc').value.trim(),
    tags:formTags.slice(),
    url:$('#fUrl').value.trim()
  };
  if(!data.title){toast('请填写服务商','error');$('#fTitle').focus();return}
  try{var u=new URL(data.url);if(!/^https?:$/.test(u.protocol))throw 0}catch(e){toast('URL 必须是有效的 http(s):// 地址','error');$('#fUrl').focus();return}
  var btn=$('#formSave');btn.disabled=true;
  var wasEdit=!!editingId;
  var p=wasEdit
    ? api('PUT',API+'/'+encodeURIComponent(editingId),data).then(function(){return load()}).then(function(){return true}).catch(function(e){toast(e.message,'error');return false})
    : persist(links.concat([data]));
  p.then(function(ok){btn.disabled=false;if(ok){toast(wasEdit?'已更新':'已添加');closeModal('#formModal')}});
}
$('#formSave').addEventListener('click',submitForm);
$('#formModal').addEventListener('keydown',function(e){
  if(e.key==='Enter'&&e.target.tagName==='INPUT'&&e.target.id!=='tagInput'){e.preventDefault();submitForm()}
});

/* ---------- 标签管理 ---------- */
function renderTagManager(){
  var st=tagStats(),el=$('#tmList');
  if(!st.length){el.innerHTML='<div class="empty" style="padding:32px 0">暂无标签</div>';return}
  el.innerHTML=st.map(function(s){
    return '<div class="tm-row" data-name="'+esc(s.name)+'"><input class="input" value="'+esc(s.name)+'" maxlength="24" aria-label="标签名">'+
      '<span class="tm-n">'+s.n+' 个链接</span><button class="btn btn-danger" data-act="del" type="button">删除</button></div>';
  }).join('');
}
function mapTags(fn){
  return links.map(function(l){
    var out=[],seen={};
    (l.tags||[]).forEach(function(t){var n=fn(t);if(!n)return;var k=norm(n);if(!k||seen[k])return;seen[k]=1;out.push(n)});
    return Object.assign({},l,{tags:out});
  });
}
$('#tmBtn').addEventListener('click',function(){renderTagManager();openModal('#tmModal')});
$('#tmClose').addEventListener('click',function(){closeModal('#tmModal')});
$('#tmList').addEventListener('change',function(e){
  var row=e.target.closest('.tm-row');if(!row)return;
  var old=row.getAttribute('data-name'),nu=e.target.value.trim().slice(0,24);
  if(!nu||nu===old){e.target.value=old;return}
  var ex=tagStats().find(function(s){return norm(s.name)===norm(nu)&&norm(s.name)!==norm(old)});
  if(ex&&!confirm('已存在标签「'+ex.name+'」，将两者合并，继续？')){e.target.value=old;return}
  if(ex)nu=ex.name;
  persist(mapTags(function(t){return norm(t)===norm(old)?nu:t}),'标签已更新').then(renderTagManager);
});
$('#tmList').addEventListener('click',function(e){
  var b=e.target.closest('[data-act="del"]');if(!b)return;
  var old=b.closest('.tm-row').getAttribute('data-name');
  if(!confirm('从所有链接中删除标签「'+old+'」？'))return;
  persist(mapTags(function(t){return norm(t)===norm(old)?null:t}),'标签已删除').then(renderTagManager);
});

/* ---------- 弹窗关闭 ---------- */
document.querySelectorAll('.backdrop').forEach(function(b){
  b.addEventListener('mousedown',function(e){if(e.target===b)b.classList.remove('open')});
});
document.addEventListener('keydown',function(e){
  if(e.key==='Escape')document.querySelectorAll('.backdrop.open').forEach(function(b){b.classList.remove('open')});
});

load();
})();`;

function adminPage(siteDomain, year) {
    return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>管理 · ${escapeHtml(siteDomain)}</title>
${THEME_INIT}
<style>
${BASE_CSS}
${ADMIN_CSS}
</style>
</head>
<body>
<div class="page">
  <div class="topbar">
    <a class="back" href="/"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>返回</a>
    <h1>管理链接 <span class="chip" id="count" style="margin-left:6px;vertical-align:middle">…</span></h1>
    ${THEME_BTN}
  </div>

  <div class="toolbar">
    <input class="input search" id="search" type="search" placeholder="搜索链接…" autocomplete="off">
    <button class="btn" id="tmBtn" type="button">🏷️ 标签管理</button>
    <button class="btn btn-primary" id="addBtn" type="button">＋ 新增链接</button>
  </div>

  <div class="list" id="list"></div>
  <div class="hint">拖动左侧 ⋮⋮ 可调整顺序（顺序即导航页显示顺序）。ID 由系统自动生成，无需填写。© ${year} ${escapeHtml(siteDomain)}</div>
</div>

<!-- 新增/编辑 -->
<div class="backdrop" id="formModal">
  <div class="modal" role="dialog" aria-modal="true">
    <div class="m-head"><h2 id="formTitle">新增链接</h2></div>
    <div class="m-body">
      <div class="f rel"><label>服务商</label>
        <input class="input" id="fTitle" placeholder="选择或输入，如 搬瓦工" autocomplete="off">
        <div class="sug" id="titleSug"></div>
      </div>
      <div class="f"><label>类型 <span class="opt-label">（可选）</span></label>
        <input class="input" id="fType" placeholder="如 MegaBox Pro" autocomplete="off">
      </div>
      <div class="f full"><label>图标</label>
        <input class="input" id="fIcon" placeholder="🔗" maxlength="8" autocomplete="off" style="max-width:120px">
        <div class="icons" id="iconRow"></div>
      </div>
      <div class="f full"><label>描述 <span class="opt-label">（可选）</span></label>
        <div class="rel">
          <input class="input" id="fDesc" placeholder="一句话说明" maxlength="80" autocomplete="off" style="padding-right:48px">
          <button type="button" class="ins-btn" id="insDot" title="在光标处插入分隔符 ·（快捷键 Alt+.）" aria-label="插入分隔符">·</button>
        </div>
      </div>
      <div class="f full rel"><label>标签 <span class="opt-label">（回车或逗号添加，可多个）</span></label>
        <div class="tagbox" id="tagbox"><input id="tagInput" placeholder="输入标签…" autocomplete="off"></div>
        <div class="sug" id="tagSug"></div>
      </div>
      <div class="f full"><label>URL</label>
        <input class="input" id="fUrl" placeholder="https://" autocomplete="off" inputmode="url">
      </div>
    </div>
    <div class="m-foot">
      <button class="btn" id="formCancel" type="button">取消</button>
      <button class="btn btn-primary" id="formSave" type="button">保存</button>
    </div>
  </div>
</div>

<!-- 标签管理 -->
<div class="backdrop" id="tmModal">
  <div class="modal" role="dialog" aria-modal="true" style="max-width:480px">
    <div class="m-head"><h2>标签管理</h2></div>
    <div style="padding:4px 20px 0;color:var(--faint);font-size:12px">修改名称即全局重命名；改成已有标签名会自动合并。</div>
    <div style="padding:8px 20px" id="tmList"></div>
    <div class="m-foot"><button class="btn" id="tmClose" type="button">完成</button></div>
  </div>
</div>

<div class="toasts" id="toasts"></div>
<script>${ADMIN_JS}</script>
<script>${THEME_JS}</script>
</body>
</html>`;
}
