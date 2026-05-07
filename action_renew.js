const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

// ==============================================================================
// 配置区：所有敏感信息从 GitHub Actions Secrets 环境变量读取
//
// USERS_JSON Secret 格式（JSON 数组，每个对象一个账号）：
// [
//   {"username":"email1@x.com","password":"pass1","server_id":"233971"},
//   {"username":"email2@x.com","password":"pass2","server_id":"233972"}
// ]
//
// TG_BOT Secret 格式：bot_token:chat_id
// ==============================================================================
const TG_BOT      = process.env.TG_BOT || '';
const TG_BOT_TOKEN = TG_BOT.includes(':') ? TG_BOT.split(':')[0] : '';
const TG_CHAT_ID   = TG_BOT.includes(':') ? TG_BOT.split(':').slice(1).join(':') : '';

// ==============================================================================
// Telegram 通知（图文合并）
// ==============================================================================
function escapeMarkdown(text) {
  return String(text || '').replace(/([_*`\[])/g, '\\$1');
}

async function sendTelegramMessage(message, imagePath = null) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  try {
    if (imagePath && fs.existsSync(imagePath)) {
      const FormData = require('form-data');
      const form = new FormData();
      form.append('chat_id', TG_CHAT_ID);
      form.append('photo', fs.createReadStream(imagePath));
      form.append('caption', message);
      form.append('parse_mode', 'Markdown');
      await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto`, form, {
        headers: form.getHeaders()
      });
      console.log('[Telegram] 图文消息已发送。');
    } else {
      await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
        chat_id: TG_CHAT_ID,
        text: message,
        parse_mode: 'Markdown'
      });
      console.log('[Telegram] 文本消息已发送。');
    }
  } catch (e) {
    console.error('[Telegram] 发送失败:', e.message);
  }
}

// ==============================================================================
// 浏览器 & 代理配置
// ==============================================================================
chromium.use(stealth);

const CHROME_PATH    = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT     = 9222;
const VIEWPORT_WIDTH  = 1280;
const VIEWPORT_HEIGHT = 720;
const RENEW_MAX_ATTEMPTS = 3;
process.env.NO_PROXY = 'localhost,127.0.0.1';

// WARP + GOST 固定本地 HTTP 代理（workflow 已启动）
const HTTP_PROXY = process.env.HTTP_PROXY || 'http://127.0.0.1:8080';
let PROXY_CONFIG = null;

if (HTTP_PROXY) {
  try {
    const proxyUrl = new URL(HTTP_PROXY);
    PROXY_CONFIG = {
      server:   `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
      username: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
      password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined
    };
    console.log(`[代理] 检测到配置: 服务器=${PROXY_CONFIG.server}`);
  } catch (e) {
    console.error('[代理] HTTP_PROXY 格式无效。');
    process.exit(1);
  }
}

// ==============================================================================
// 注入脚本：Hook Shadow DOM 获取 Turnstile checkbox 坐标
// ==============================================================================
const INJECTED_SCRIPT = `
(function() {
  if (window.self === window.top) return;
  try {
    function getRandomInt(min, max) {
      return Math.floor(Math.random() * (max - min + 1)) + min;
    }
    let screenX = getRandomInt(800, 1200);
    let screenY = getRandomInt(400, 600);
    Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX });
    Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY });
  } catch (e) {}

  try {
    const originalAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function(init) {
      const shadowRoot = originalAttachShadow.call(this, init);
      if (shadowRoot) {
        const checkAndReport = () => {
          const checkbox = shadowRoot.querySelector('input[type="checkbox"]');
          if (checkbox) {
            const rect = checkbox.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0 && window.innerWidth > 0 && window.innerHeight > 0) {
              const xRatio = (rect.left + rect.width / 2) / window.innerWidth;
              const yRatio = (rect.top + rect.height / 2) / window.innerHeight;
              window.__turnstile_data = { xRatio, yRatio };
              return true;
            }
          }
          return false;
        };
        if (!checkAndReport()) {
          const observer = new MutationObserver(() => {
            if (checkAndReport()) observer.disconnect();
          });
          observer.observe(shadowRoot, { childList: true, subtree: true });
        }
      }
      return shadowRoot;
    };
  } catch (e) {
    console.error('[注入] Hook attachShadow 失败:', e);
  }
})();
`;

// ==============================================================================
// 工具函数
// ==============================================================================
async function checkProxy() {
  if (!PROXY_CONFIG) return true;
  console.log('[代理] 正在验证代理连接...');
  try {
    const axiosConfig = {
      proxy: {
        protocol: 'http',
        host: new URL(PROXY_CONFIG.server).hostname,
        port: parseInt(new URL(PROXY_CONFIG.server).port, 10),
      },
      timeout: 10000
    };
    if (PROXY_CONFIG.username && PROXY_CONFIG.password) {
      axiosConfig.proxy.auth = { username: PROXY_CONFIG.username, password: PROXY_CONFIG.password };
    }
    await axios.get('https://1.1.1.1', axiosConfig);
    console.log('[代理] 连接成功！');
    return true;
  } catch (error) {
    console.error(`[代理] 连接失败: ${error.message}`);
    return false;
  }
}

function checkPort(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/json/version`, (res) => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
  });
}

async function launchChrome() {
  console.log('检查 Chrome 是否已在端口 ' + DEBUG_PORT + ' 上运行...');
  if (await checkPort(DEBUG_PORT)) { console.log('Chrome 已开启。'); return; }
  console.log(`正在启动 Chrome (路径: ${CHROME_PATH})...`);
  const args = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}`,
    '--no-sandbox', '--disable-setuid-sandbox',
    '--user-data-dir=/tmp/chrome_user_data', '--disable-dev-shm-usage'
  ];
  if (PROXY_CONFIG) {
    args.push(`--proxy-server=${PROXY_CONFIG.server}`);
    args.push('--proxy-bypass-list=<-loopback>');
  }
  const chrome = spawn(CHROME_PATH, args, { detached: true, stdio: 'ignore' });
  chrome.unref();
  console.log('正在等待 Chrome 初始化...');
  for (let i = 0; i < 20; i++) {
    if (await checkPort(DEBUG_PORT)) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!await checkPort(DEBUG_PORT)) throw new Error('Chrome 启动失败');
}

async function configurePageViewport(page) {
  try {
    await page.setViewportSize({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });
  } catch (e) {
    console.log('[视口] 设置失败:', e.message);
  }
}

async function saveViewportScreenshot(page, imagePath) {
  await page.screenshot({ path: imagePath, fullPage: true });
}

function maskUsername(username) {
  const value = String(username || '').trim();
  if (!value) return '(empty)';
  const atIndex = value.indexOf('@');
  if (atIndex <= 1) return value.length <= 3 ? `${value[0]}**` : `${value[0]}***${value.slice(-1)}`;
  const name   = value.slice(0, atIndex);
  const domain = value.slice(atIndex + 1);
  const masked = name.length <= 2 ? `${name[0]}*` : `${name.slice(0, 2)}***`;
  return `${masked}@${domain}`;
}

// ==============================================================================
// 账号读取：USERS_JSON 格式含 server_id
// ==============================================================================
function getUsers() {
  try {
    if (process.env.USERS_JSON) {
      const parsed = JSON.parse(process.env.USERS_JSON);
      let rawUsers = Array.isArray(parsed) ? parsed
        : (parsed && Array.isArray(parsed.users)) ? parsed.users
        : (parsed && typeof parsed === 'object') ? [parsed] : [];

      const users = [];
      const seen  = new Set();

      for (const entry of rawUsers) {
        if (!entry || typeof entry !== 'object') continue;
        const username  = String(entry.username || entry.email || '').trim();
        const password  = String(entry.password || '').trim();
        const server_id = String(entry.server_id || '').trim();

        if (!username || !password || !server_id) {
          console.log(`[用户配置] 跳过无效条目: username/password/server_id 不完整 (${maskUsername(username)})`);
          continue;
        }
        const key = username.toLowerCase();
        if (seen.has(key)) { console.log(`[用户配置] 跳过重复账号: ${maskUsername(username)}`); continue; }
        seen.add(key);
        users.push({ username, password, server_id });
      }

      console.log(`[用户配置] 有效账号 ${users.length} 个: ${users.map(u => maskUsername(u.username)).join(', ')}`);
      return users;
    }
  } catch (e) {
    console.error('解析 USERS_JSON 错误:', e);
  }
  return [];
}

// ==============================================================================
// CDP 物理点击（Turnstile & ALTCHA 共用）
// ==============================================================================
async function dispatchCdpClick(page, x, y) {
  const client = await page.context().newCDPSession(page);
  try {
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    console.log(`>> CDP 点击 (${x.toFixed(2)}, ${y.toFixed(2)}) 已发送。`);
    return true;
  } catch (e) {
    console.log('>> CDP 点击失败:', e.message);
    return false;
  } finally {
    await client.detach().catch(() => {});
  }
}

// ==============================================================================
// Turnstile（登录页专用）
// ==============================================================================
async function attemptTurnstileCdp(page) {
  const frames = page.frames();
  for (const frame of frames) {
    try {
      const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);
      if (data) {
        console.log('>> 发现 Turnstile 数据。比例:', data);
        await frame.evaluate(() => { window.__turnstile_data = null; }).catch(() => {});
        const iframeElement = await frame.frameElement();
        if (!iframeElement) continue;
        const box = await iframeElement.boundingBox();
        if (!box) continue;
        const clickX = box.x + (box.width * data.xRatio);
        const clickY = box.y + (box.height * data.yRatio);
        return await dispatchCdpClick(page, clickX, clickY);
      }
    } catch (e) {}
  }
  return false;
}

async function checkTurnstileSuccess(page) {
  try {
    const hasToken = await page.locator('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]')
      .evaluateAll(els => els.some(el => el.value && el.value.trim().length > 0));
    if (hasToken) return true;
  } catch (e) {}
  for (const f of page.frames()) {
    if (f.url().includes('cloudflare')) {
      try { if (await f.getByText('Success!', { exact: false }).isVisible({ timeout: 500 })) return true; } catch (e) {}
    }
  }
  return false;
}

async function hasTurnstileFrame(page) {
  try {
    return await page.locator('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]').count() > 0;
  } catch (e) { return false; }
}

async function solveTurnstileIfPresent(page, stageName = '登录', maxAttempts = 10, waitAfterClick = 5000) {
  console.log(`[${stageName}] 开始检测 Cloudflare Turnstile...`);
  let sawTurnstile = false;
  for (let i = 0; i < maxAttempts; i++) {
    if (await hasTurnstileFrame(page)) sawTurnstile = true;
    if (await checkTurnstileSuccess(page)) { console.log(`[${stageName}] ✅ Turnstile 已通过。`); return true; }
    const clicked = await attemptTurnstileCdp(page);
    if (clicked) {
      sawTurnstile = true;
      console.log(`[${stageName}] 已点击 Turnstile，等待 ${waitAfterClick}ms...`);
      await page.waitForTimeout(waitAfterClick);
      if (await checkTurnstileSuccess(page)) { console.log(`[${stageName}] ✅ Turnstile 验证通过！`); return true; }
      console.log(`[${stageName}] ⚠️ 点击后未通过，继续重试...`);
    }
    if (i < maxAttempts - 1) await page.waitForTimeout(1000);
  }
  if (!sawTurnstile) { console.log(`[${stageName}] 未检测到 Turnstile。`); return true; }
  console.log(`[${stageName}] 检测到 Turnstile，但未能通过验证。`);
  return false;
}

// ==============================================================================
// ALTCHA（续期弹窗专用）
// 深度检测 Shadow DOM 状态，CDP 精确点击，等待 PoW 哈希计算
// ==============================================================================
async function getAltchaStatus(page) {
  try {
    return await page.evaluate(() => {
      const normalize = v => v == null ? '' : String(v).trim();
      const widget    = document.querySelector('altcha-widget');
      const inputs    = Array.from(document.querySelectorAll('input[name="altcha"], textarea[name="altcha"]'));
      const filled    = inputs.find(el => normalize(el.value).length > 0);
      const shadow    = widget ? widget.shadowRoot : null;
      const checkbox  = shadow ? shadow.querySelector('input[type="checkbox"], [role="checkbox"]') : null;

      const stateProp = normalize(widget ? widget.state : '');
      const stateAttr = normalize(widget ? widget.getAttribute('state') : '');
      const valueProp = normalize(widget ? widget.value : '');
      const valueAttr = normalize(widget ? widget.getAttribute('value') : '');
      const hiddenVal = normalize(filled ? filled.value : '');
      const cbChecked = checkbox && typeof checkbox.checked === 'boolean' ? checkbox.checked : null;
      const ariaChk   = normalize(checkbox ? checkbox.getAttribute('aria-checked') : '');
      const busyAttr  = normalize(widget ? widget.getAttribute('aria-busy') : '');
      const state     = stateProp || stateAttr || '';
      const isSolved  = state === 'verified' || valueProp.length > 0 || valueAttr.length > 0 || hiddenVal.length > 0;
      const isVerifying = !isSolved && (
        state === 'verifying' || state === 'processing' || state === 'working' ||
        cbChecked === true || ariaChk === 'true' || busyAttr === 'true'
      );

      return {
        exists: !!widget || inputs.length > 0,
        solved: isSolved, isVerifying,
        state: state || 'unknown',
        hasShadowRoot: !!shadow,
        checkboxChecked: cbChecked, ariaChecked: ariaChk,
        valueLength: Math.max(valueProp.length, valueAttr.length),
        hiddenInputLength: hiddenVal.length,
        busy: busyAttr === 'true'
      };
    });
  } catch (e) {
    return { exists: false, solved: false, isVerifying: false, state: 'error',
             hasShadowRoot: false, checkboxChecked: null, ariaChecked: '',
             valueLength: 0, hiddenInputLength: 0, busy: false };
  }
}

function formatAltchaStatus(s) {
  const checked = s.checkboxChecked === null ? 'unknown' : String(s.checkboxChecked);
  return `state=${s.state}, solved=${s.solved}, verifying=${s.isVerifying}, shadow=${s.hasShadowRoot}, checked=${checked}, ariaChecked=${s.ariaChecked || 'n/a'}, valueLen=${s.valueLength}, hiddenLen=${s.hiddenInputLength}, busy=${s.busy}`;
}

async function attemptAltchaClick(page, currentStatus = null) {
  try {
    const altchaWidget = page.locator('altcha-widget').first();
    if (await altchaWidget.count() > 0) {
      const status = currentStatus || await getAltchaStatus(page);
      if (status.solved) return false;
      if (status.isVerifying) { console.log(`>> ALTCHA 正在验证中，跳过重复点击。`); return false; }

      await page.waitForTimeout(500);
      await altchaWidget.scrollIntoViewIfNeeded().catch(() => {});

      const boxInfo = await page.evaluate(() => {
        const widget = document.querySelector('altcha-widget');
        if (!widget) return null;
        const pick = root => root ? root.querySelector('input[type="checkbox"], [role="checkbox"], label, button') : null;
        if (widget.shadowRoot) {
          const t = pick(widget.shadowRoot);
          if (t) { const r = t.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height, isExact: true, tagName: t.tagName }; }
        }
        const lt = pick(widget);
        if (lt) { const r = lt.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height, isExact: true, tagName: lt.tagName }; }
        const r = widget.getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height, isExact: false, tagName: widget.tagName };
      });

      if (boxInfo && boxInfo.width > 0 && boxInfo.height > 0) {
        const clickX = boxInfo.isExact ? boxInfo.x + boxInfo.width / 2 : boxInfo.x + Math.min(25, Math.max(12, boxInfo.width * 0.15));
        const clickY = boxInfo.y + boxInfo.height / 2;
        console.log(`>> ALTCHA 点击目标 <${boxInfo.tagName}> 坐标: (${clickX.toFixed(2)}, ${clickY.toFixed(2)})`);
        await dispatchCdpClick(page, clickX, clickY);
        // 同时触发 Shadow DOM 内部 checkbox
        await page.evaluate(() => {
          const w = document.querySelector('altcha-widget');
          if (w && w.shadowRoot) { const cb = w.shadowRoot.querySelector('input[type="checkbox"]'); if (cb && !cb.checked) cb.click(); }
        });
        return true;
      }
    }
  } catch (e) { console.log('>> ALTCHA 点击出错:', e.message); }
  return false;
}

async function solveAltchaIfPresent(page, stageName = 'Renew弹窗', maxAttempts = 15, waitAfterClick = 8000) {
  console.log(`[${stageName}] 开始检测 ALTCHA...`);
  let sawAltcha = false;
  const startedAt = Date.now();
  const totalBudget = Math.max(waitAfterClick * maxAttempts, waitAfterClick);
  let clickAttempts = 0;
  let lastStatusText = '';

  while (Date.now() - startedAt < totalBudget) {
    const status = await getAltchaStatus(page);
    if (status.exists) sawAltcha = true;

    const statusText = formatAltchaStatus(status);
    if (status.exists && statusText !== lastStatusText) { console.log(`[${stageName}] ALTCHA 状态: ${statusText}`); lastStatusText = statusText; }

    if (status.solved) { console.log(`[${stageName}] ✅ ALTCHA 已通过验证。`); return true; }
    if (!status.exists) { await page.waitForTimeout(1000); continue; }
    if (status.isVerifying) { await page.waitForTimeout(1000); continue; }
    if (clickAttempts >= maxAttempts) { await page.waitForTimeout(1000); continue; }

    const clicked = await attemptAltchaClick(page, status);
    if (!clicked) { await page.waitForTimeout(1000); continue; }

    clickAttempts++;
    console.log(`[${stageName}] 已点击 ALTCHA，等待 PoW 计算 (${waitAfterClick}ms)，第 ${clickAttempts}/${maxAttempts} 次...`);

    const clickStart = Date.now();
    let observedVerifying = false;
    while (Date.now() - clickStart < waitAfterClick) {
      await page.waitForTimeout(1000);
      const fs2 = await getAltchaStatus(page);
      if (fs2.exists) sawAltcha = true;
      const ft = formatAltchaStatus(fs2);
      if (fs2.exists && ft !== lastStatusText) { console.log(`[${stageName}] ALTCHA 状态: ${ft}`); lastStatusText = ft; }
      if (fs2.solved) { console.log(`[${stageName}] ✅ ALTCHA 验证通过！`); return true; }
      if (fs2.isVerifying) { observedVerifying = true; continue; }
      if (!observedVerifying && Date.now() - clickStart >= 2500) {
        console.log(`[${stageName}] ⚠️ 未进入 verifying 状态，准备重新点击...`);
        break;
      }
    }
  }

  if (!sawAltcha) { console.log(`[${stageName}] 弹窗中未检测到 ALTCHA 组件。`); return true; }
  const finalStatus = await getAltchaStatus(page);
  console.log(`[${stageName}] ALTCHA 超时。最终状态: ${formatAltchaStatus(finalStatus)}`);
  return false;
}

// ==============================================================================
// 主循环
// ==============================================================================
(async () => {
  const users = getUsers();
  if (users.length === 0) {
    console.log('❌ 未在 USERS_JSON 中找到有效账号');
    process.exit(1);
  }

  if (PROXY_CONFIG && !await checkProxy()) process.exit(1);

  await launchChrome();

  console.log('正在连接 Chrome...');
  let browser;
  for (let k = 0; k < 5; k++) {
    try {
      browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
      console.log('连接成功！');
      break;
    } catch (e) {
      console.log(`连接尝试 ${k + 1} 失败，2 秒后重试...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  if (!browser) process.exit(1);

  const context = browser.contexts()[0];
  if (!context) { console.error('无法获取浏览器上下文，退出。'); await browser.close(); process.exit(1); }

  let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
  page.setDefaultTimeout(60000);
  await configurePageViewport(page);

  // 代理认证拦截
  if (PROXY_CONFIG && PROXY_CONFIG.username) {
    await context.route('**/*', (route) => {
      route.continue({ headers: {
        ...route.request().headers(),
        'Proxy-Authorization': 'Basic ' + Buffer.from(`${PROXY_CONFIG.username}:${PROXY_CONFIG.password}`).toString('base64')
      }});
    });
  }

  await page.addInitScript(INJECTED_SCRIPT);

  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    console.log(`\n${'='.repeat(55)}`);
    console.log(`🎯 处理账号 [${i + 1}/${users.length}]: ${maskUsername(user.username)}`);
    console.log('='.repeat(55));

    const photoDir  = path.join(process.cwd(), 'screenshots');
    if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
    const safeName  = user.username.replace(/[^a-z0-9]/gi, '_');
    const targetUrl = `https://dashboard.katabump.com/servers/edit?id=${user.server_id}`;

    try {
      if (page.isClosed()) { page = await context.newPage(); await page.addInitScript(INJECTED_SCRIPT); }

      // ── 1. 登出确保干净 session ───────────────────────────────────
      console.log('[-] 确保已登出...');
      if (page.url().includes('dashboard')) {
        await page.goto('https://dashboard.katabump.com/auth/logout');
        await page.waitForTimeout(2000);
      }
      await page.goto('https://dashboard.katabump.com/auth/login');
      await page.waitForTimeout(2000);

      if (page.url().includes('dashboard') && !page.url().includes('login')) {
        await page.goto('https://dashboard.katabump.com/auth/logout');
        await page.waitForTimeout(2000);
        await page.goto('https://dashboard.katabump.com/auth/login');
        await page.waitForTimeout(2000);
      }
      await page.waitForTimeout(3000);

      // ── 2. 登录阶段：Turnstile ────────────────────────────────────
      await solveTurnstileIfPresent(page, '登录阶段', 10, 5000);

      console.log('[-] 输入账号密码...');
      try {
        const emailInput = page.getByRole('textbox', { name: 'Email' });
        await emailInput.waitFor({ state: 'visible', timeout: 5000 });
        await emailInput.fill(user.username);
        await page.getByRole('textbox', { name: 'Password' }).fill(user.password);
        await page.waitForTimeout(500);
        await page.getByRole('button', { name: 'Login', exact: true }).click();

        try {
          const errMsg = page.getByText('Incorrect password or no account');
          if (await errMsg.isVisible({ timeout: 3000 })) {
            console.error('>> ❌ 登录失败: 账号或密码错误');
            const failShot = path.join(photoDir, `${safeName}_login_fail.png`);
            try { await saveViewportScreenshot(page, failShot); } catch (e) {}
            await sendTelegramMessage(`❌ *${escapeMarkdown(maskUsername(user.username))}*\n登录失败: 账号或密码错误`, failShot);
            continue;
          }
        } catch (e) {}
      } catch (e) {
        console.log('[-] 登录操作异常:', e.message);
      }

      // ── 3. 等待登录完成 ───────────────────────────────────────────
      console.log('[-] 等待登录跳转...');
      try {
        await page.waitForURL('**/dashboard**', { timeout: 15000 });
        console.log('✅ 登录成功！');
      } catch (e) {
        console.log('❌ 登录跳转超时');
        const failShot = path.join(photoDir, `${safeName}_login_timeout.png`);
        try { await saveViewportScreenshot(page, failShot); } catch (e2) {}
        await sendTelegramMessage(`❌ *${escapeMarkdown(maskUsername(user.username))}*\n登录超时`, failShot);
        continue;
      }

      // ── 4. 直接跳转服务器页面（server_id 精确定位）───────────────
      console.log(`[-] 跳转服务器页面 (server_id: ${user.server_id})...`);
      await page.goto(targetUrl);
      await page.waitForTimeout(4000);

      if (page.url().includes('auth/login')) {
        console.log('❌ 被踢回登录页');
        const failShot = path.join(photoDir, `${safeName}_kicked.png`);
        try { await saveViewportScreenshot(page, failShot); } catch (e) {}
        await sendTelegramMessage(`❌ *${escapeMarkdown(maskUsername(user.username))}*\n跳转后被踢回登录页`, failShot);
        continue;
      }
      try { await saveViewportScreenshot(page, path.join(photoDir, `${safeName}_server_page.png`)); } catch (e) {}

      // ── 5. Renew 流程（最多 3 次）─────────────────────────────────
      let renewSuccess = false;
      let renewFailReason = `续期失败，${RENEW_MAX_ATTEMPTS} 次尝试均未成功`;

      for (let attempt = 1; attempt <= RENEW_MAX_ATTEMPTS; attempt++) {
        if (page.url().includes('login')) { console.log('[-] 被重定向到登录页，退出。'); break; }

        console.log(`\n[尝试 ${attempt}/${RENEW_MAX_ATTEMPTS}] 寻找 Renew 按钮...`);
        const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();
        try { await renewBtn.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) {}

        if (!await renewBtn.isVisible()) { console.log('[-] 未找到 Renew 按钮。'); break; }

        await renewBtn.click();
        console.log('[-] Renew 按钮已点击，等待弹窗...');

        const modal = page.locator('.modal-content, [role="dialog"]').filter({ hasText: 'Renew' }).first();
        try { await modal.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) { console.log('[-] 弹窗未出现，重试...'); continue; }

        // 晃动鼠标
        try { const box = await modal.boundingBox(); if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 }); } catch (e) {}

        const confirmBtn = modal.getByRole('button', { name: 'Renew', exact: true });
        if (!await confirmBtn.isVisible()) { console.log('[-] 未找到 Confirm 按钮，重试...'); continue; }

        // 截图
        try { await saveViewportScreenshot(page, path.join(photoDir, `${safeName}_altcha_${attempt}.png`)); } catch (e) {}

        // ── 续期弹窗：ALTCHA（CDP + Shadow DOM 深度检测）────────────
        const altchaOk = await solveAltchaIfPresent(page, 'Renew弹窗', 15, 8000);
        if (!altchaOk) {
          renewFailReason = `ALTCHA 验证未通过（已重试 ${RENEW_MAX_ATTEMPTS} 次）`;
          console.log('[-] ALTCHA 未通过，刷新重试...');
          await page.reload();
          await page.waitForTimeout(3000);
          if (page.url().includes('login')) break;
          continue;
        }

        console.log('[-] 点击 Confirm 提交续期...');
        await confirmBtn.click();

        // 检查提交后状态
        let hasCaptchaError = false;
        try {
          const startVerify = Date.now();
          while (Date.now() - startVerify < 3000) {
            if (await page.getByText('Please complete the captcha to continue').isVisible()) {
              console.log('[-] ⚠️ captcha 错误提示出现');
              hasCaptchaError = true;
              break;
            }

            const notTime = page.getByText("You can't renew your server yet");
            if (await notTime.isVisible()) {
              const text = await notTime.innerText().catch(() => '');
              const match = text.match(/as of\s+(.*?)\s+\(/);
              const dateStr = match ? match[1] : 'Unknown';
              console.log(`[-] ⏳ 暂无法续期，下次可续期: ${dateStr}`);
              renewSuccess = true;

              const skipShot = path.join(photoDir, `${safeName}_skip.png`);
              try { const closeBtn = modal.getByLabel('Close'); if (await closeBtn.isVisible()) { await closeBtn.click(); await modal.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {}); } } catch (e) {}
              try { await saveViewportScreenshot(page, skipShot); } catch (e) {}
              await sendTelegramMessage(`⏳ *${escapeMarkdown(maskUsername(user.username))}*\n暂无法续期，下次可续期: ${dateStr}`, skipShot);
              break;
            }
            await page.waitForTimeout(200);
          }
        } catch (e) {}

        if (renewSuccess) break;

        if (hasCaptchaError) {
          renewFailReason = `ALTCHA 验证未通过（已重试 ${RENEW_MAX_ATTEMPTS} 次）`;
          await page.reload();
          await page.waitForTimeout(3000);
          if (page.url().includes('login')) break;
          continue;
        }

        await page.waitForTimeout(2000);
        if (!await modal.isVisible()) {
          console.log('✅ 续期成功！');
          const successShot = path.join(photoDir, `${safeName}_success.png`);
          try { await saveViewportScreenshot(page, successShot); } catch (e) {}
          await sendTelegramMessage(`✅ *${escapeMarkdown(maskUsername(user.username))}*\n续期成功！`, successShot);
          renewSuccess = true;
          break;
        } else {
          console.log('[-] 弹窗未关闭，刷新重试...');
          await page.reload();
          await page.waitForTimeout(3000);
          if (page.url().includes('login')) break;
        }
      }

      if (!renewSuccess) {
        console.log(`❌ 全部 ${RENEW_MAX_ATTEMPTS} 次尝试失败。`);
        const failShot = path.join(photoDir, `${safeName}_renew_fail.png`);
        try { await saveViewportScreenshot(page, failShot); } catch (e) {}
        await sendTelegramMessage(`❌ *${escapeMarkdown(maskUsername(user.username))}*\n${renewFailReason}`, failShot);
      }

    } catch (err) {
      console.error(`处理账号时发生异常:`, err);
      try { await saveViewportScreenshot(page, path.join(photoDir, `${safeName}_error.png`)); } catch (e) {}
    }

    console.log(`\n账号 [${i + 1}/${users.length}] 处理完成。`);
    if (i < users.length - 1) { console.log('⏳ 等待 5 秒后处理下一个账号...'); await page.waitForTimeout(5000); }
  }

  console.log('\n===== ✅ 全部账号处理完毕 =====');
  await browser.close();
  process.exit(0);
})();
