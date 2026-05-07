const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

// ==============================================================================
// TG_BOT 格式：bot_token:chat_id（统一为单个 Secret）
// ==============================================================================
const TG_BOT       = process.env.TG_BOT || '';
const TG_BOT_TOKEN = TG_BOT.includes(':') ? TG_BOT.split(':')[0] : (process.env.TG_BOT_TOKEN || '');
const TG_CHAT_ID   = TG_BOT.includes(':') ? TG_BOT.split(':').slice(1).join(':') : (process.env.TG_CHAT_ID || '');
const GITHUB_EVENT_NAME = process.env.GITHUB_EVENT_NAME || '';

// Anti-detection: scheduled runs get 0-3h random delay; manual runs skip delay
const SINGBOX_LOCAL_PROXY = 'http://127.0.0.1:8080';

// ==============================================================================
// Telegram 通知（文字 + 图片分开发送，图片用 curl）
// ==============================================================================
async function sendTelegramMessage(message, imagePath = null) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      chat_id: TG_CHAT_ID,
      text: message,
      parse_mode: 'Markdown'
    });
    console.log('[Telegram] 消息已发送。');
  } catch (e) {
    console.error('[Telegram] 发送失败:', e.message);
  }
  if (imagePath && fs.existsSync(imagePath)) {
    const cmd = `curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}" -F photo="@${imagePath}"`;
    await new Promise(resolve => {
      exec(cmd, (err) => {
        if (err) console.error('[Telegram] 图片发送失败:', err.message);
        else console.log('[Telegram] 图片已发送。');
        resolve();
      });
    });
  }
}

chromium.use(stealth);

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT  = 9222;
process.env.NO_PROXY = 'localhost,127.0.0.1';

const PROXY_URL  = process.env.PROXY_URL;
const HTTP_PROXY = process.env.HTTP_PROXY;
let PROXY_CONFIG = null;

async function detectSingboxProxy() {
  if (!PROXY_URL) return false;
  try {
    await axios.get('http://127.0.0.1:8080', { timeout: 2000, proxy: false });
    return true;
  } catch (e) {
    return e.code !== 'ECONNREFUSED';
  }
}

async function resolveProxyConfig() {
  if (PROXY_URL) {
    const isSingboxUp = await detectSingboxProxy();
    if (isSingboxUp) {
      PROXY_CONFIG = { server: SINGBOX_LOCAL_PROXY };
      console.log(`[Proxy] sing-box 已检测到: ${SINGBOX_LOCAL_PROXY}`);
      return;
    }
    console.log('[Proxy] PROXY_URL 已设置但 sing-box 未响应，回退到 HTTP_PROXY');
  }
  if (HTTP_PROXY) {
    try {
      const proxyUrl = new URL(HTTP_PROXY);
      PROXY_CONFIG = {
        server:   `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
        username: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
        password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined
      };
      console.log(`[Proxy] HTTP_PROXY: server=${PROXY_CONFIG.server}`);
    } catch (e) {
      console.error('[Proxy] HTTP_PROXY 格式无效');
      process.exit(1);
    }
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
// 代理检测
// ==============================================================================
async function checkProxy() {
  if (!PROXY_CONFIG) return true;
  console.log('[Proxy] 正在验证代理连接...');
  try {
    const axiosConfig = { proxy: false, timeout: 10000 };
    if (PROXY_CONFIG.server === SINGBOX_LOCAL_PROXY) {
      axiosConfig.proxy = { protocol: 'http', host: '127.0.0.1', port: 8080 };
    } else {
      axiosConfig.proxy = {
        protocol: 'http',
        host: new URL(PROXY_CONFIG.server).hostname,
        port: new URL(PROXY_CONFIG.server).port,
      };
      if (PROXY_CONFIG.username && PROXY_CONFIG.password) {
        axiosConfig.proxy.auth = { username: PROXY_CONFIG.username, password: PROXY_CONFIG.password };
      }
    }
    const res = await axios.get('https://api.ipify.org', axiosConfig);
    console.log(`[Proxy] 连接成功！出口 IP: ${res.data}`);
    return true;
  } catch (error) {
    console.error(`[Proxy] 连接失败: ${error.message}`);
    return false;
  }
}

function checkPort(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/json/version`, (res) => { resolve(true); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

async function launchChrome() {
  console.log('检查 Chrome 是否已在端口 ' + DEBUG_PORT + ' 上运行...');
  if (await checkPort(DEBUG_PORT)) { console.log('Chrome 已开启。'); return; }
  console.log(`正在启动 Chrome (路径: ${CHROME_PATH})...`);
  const args = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--window-size=1280,720',
    '--no-sandbox', '--disable-setuid-sandbox',
    '--user-data-dir=/tmp/chrome_user_data',
    '--disable-dev-shm-usage'
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

// ==============================================================================
// 账号读取（支持含 server_id 或不含 server_id 两种格式）
// ==============================================================================
function maskUsername(username) {
  const v = String(username || '').trim();
  if (!v) return '(empty)';
  const at = v.indexOf('@');
  if (at <= 1) return v.length <= 3 ? `${v[0]}**` : `${v[0]}***${v.slice(-1)}`;
  const name = v.slice(0, at), domain = v.slice(at + 1);
  return `${name.length <= 2 ? name[0] + '*' : name.slice(0,2) + '***'}@${domain}`;
}

function getUsers() {
  try {
    if (process.env.USERS_JSON) {
      const parsed = JSON.parse(process.env.USERS_JSON);
      const raw = Array.isArray(parsed) ? parsed : (parsed.users || [parsed]);
      const users = [], seen = new Set();
      for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;
        const username = String(entry.username || entry.email || '').trim();
        const password = String(entry.password || '').trim();
        if (!username || !password) continue;
        const key = username.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        users.push({ username, password, server_id: String(entry.server_id || '').trim() });
      }
      console.log(`[用户配置] 有效账号 ${users.length} 个`);
      return users;
    }
  } catch (e) {
    console.error('解析 USERS_JSON 错误:', e);
  }
  return [];
}

// ==============================================================================
// CDP 点击（Turnstile & ALTCHA 共用）
// ==============================================================================
async function attemptTurnstileCdp(page) {
  const frames = page.frames();
  for (const frame of frames) {
    try {
      const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);
      if (data) {
        console.log('>> 在 frame 中发现 Turnstile。比例:', data);
        const iframeElement = await frame.frameElement();
        if (!iframeElement) continue;
        const box = await iframeElement.boundingBox();
        if (!box) continue;
        const clickX = box.x + (box.width * data.xRatio);
        const clickY = box.y + (box.height * data.yRatio);
        console.log(`>> 计算点击坐标: (${clickX.toFixed(2)}, ${clickY.toFixed(2)})`);
        const client = await page.context().newCDPSession(page);
        await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1 });
        await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
        await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1 });
        console.log('>> CDP 点击已发送。');
        await client.detach();
        return true;
      }
    } catch (e) {}
  }
  return false;
}

async function dispatchCdpClick(page, x, y) {
  const client = await page.context().newCDPSession(page);
  try {
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    console.log(`>> CDP 坐标 (${x.toFixed(2)}, ${y.toFixed(2)}) 点击已发送。`);
    return true;
  } catch (e) {
    console.log('>> CDP 点击失败:', e.message);
    return false;
  } finally {
    await client.detach().catch(() => {});
  }
}

// ==============================================================================
// ALTCHA（续期弹窗专用）
// ==============================================================================
async function getAltchaStatus(page) {
  try {
    return await page.evaluate(() => {
      const normalize = v => v == null ? '' : String(v).trim();
      const widget   = document.querySelector('altcha-widget');
      const inputs   = Array.from(document.querySelectorAll('input[name="altcha"], textarea[name="altcha"], input[name*="altcha" i], textarea[name*="altcha" i]'));
      const filled   = inputs.find(el => normalize(el.value).length > 0);
      const shadow   = widget ? widget.shadowRoot : null;
      const checkbox = shadow ? shadow.querySelector('input[type="checkbox"], [role="checkbox"]') : null;
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
        exists: !!widget || inputs.length > 0, solved: isSolved, isVerifying,
        state: state || 'unknown', hasShadowRoot: !!shadow,
        checkboxChecked: cbChecked, ariaChecked: ariaChk,
        valueLength: Math.max(valueProp.length, valueAttr.length),
        hiddenInputLength: hiddenVal.length, busy: busyAttr === 'true'
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
        console.log(`>> 发现 ALTCHA 内部点击目标 <${boxInfo.tagName}>，坐标: (${clickX.toFixed(2)}, ${clickY.toFixed(2)})`);
        await dispatchCdpClick(page, clickX, clickY);
        await page.evaluate(() => {
          const w = document.querySelector('altcha-widget');
          if (w && w.shadowRoot) { const cb = w.shadowRoot.querySelector('input[type="checkbox"]'); if (cb && !cb.checked) cb.click(); }
        });
        return true;
      } else {
        console.log('>> 找到了 ALTCHA 元素，但获取不到有效大小，跳过点击。');
      }
    }
  } catch (e) { console.log('>> 尝试查找 ALTCHA 时出错:', e.message); }
  return false;
}

async function solveAltchaIfPresent(page, stageName = 'Renew阶段', maxAttempts = 15, waitAfterClick = 8000) {
  console.log(`[${stageName}] 开始检测 ALTCHA...`);
  let sawAltcha = false;
  const startedAt = Date.now();
  const totalBudget = Math.max(waitAfterClick * maxAttempts, waitAfterClick);
  let clickAttempts = 0, lastStatusText = '';

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
  console.log(`[${stageName}] ❌ ALTCHA 超时。最终状态: ${formatAltchaStatus(finalStatus)}`);
  return false;
}

// ==============================================================================
// 主循环
// ==============================================================================
(async () => {
  // Random delay for scheduled runs (anti-detection)
  if (GITHUB_EVENT_NAME === 'schedule') {
    const delaySec = Math.floor(Math.random() * 3 * 60 * 60);
    const h = Math.floor(delaySec / 3600), m = Math.floor((delaySec % 3600) / 60), s = delaySec % 60;
    console.log(`[Anti-Detection] 定时触发，随机延迟 ${h}h ${m}m ${s}s...`);
    await new Promise(r => setTimeout(r, delaySec * 1000));
  } else {
    console.log(`[Anti-Detection] 手动触发，跳过随机延迟。`);
  }

  const users = getUsers();
  if (users.length === 0) { console.log('❌ 未在 USERS_JSON 中找到有效账号'); process.exit(1); }

  // ── 日志掩码：屏蔽所有敏感信息 ──────────────────────────────────
  for (const user of users) {
    if (user.username)  console.log(`::add-mask::${user.username}`);
    if (user.password)  console.log(`::add-mask::${user.password}`);
    if (user.server_id) console.log(`::add-mask::${user.server_id}`);
  }
  if (TG_BOT_TOKEN) console.log(`::add-mask::${TG_BOT_TOKEN}`);
  if (TG_CHAT_ID)   console.log(`::add-mask::${TG_CHAT_ID}`);
  if (TG_BOT)       console.log(`::add-mask::${TG_BOT}`);

  await resolveProxyConfig();
  if (PROXY_CONFIG) {
    const isValid = await checkProxy();
    if (!isValid) { console.error('[Proxy] 代理无效，终止运行。'); process.exit(1); }
  }

  await launchChrome();

  console.log('正在连接 Chrome...');
  let browser;
  for (let k = 0; k < 5; k++) {
    try { browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`); console.log('连接成功！'); break; }
    catch (e) { console.log(`连接尝试 ${k + 1} 失败，2秒后重试...`); await new Promise(r => setTimeout(r, 2000)); }
  }
  if (!browser) { console.error('连接失败，退出。'); process.exit(1); }

  const context = browser.contexts()[0];
  if (!context) { console.error('无法获取浏览器上下文，退出。'); await browser.close(); process.exit(1); }

  let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
  page.setDefaultTimeout(60000);

  if (PROXY_CONFIG && PROXY_CONFIG.username) {
    await context.setHTTPCredentials({ username: PROXY_CONFIG.username, password: PROXY_CONFIG.password });
  } else {
    await context.setHTTPCredentials(null);
  }

  await page.addInitScript(INJECTED_SCRIPT);
  console.log('注入脚本已添加。');

  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    console.log(`\n${'='.repeat(55)}`);
    console.log(`🎯 正在处理账号 [${i + 1}/${users.length}]`);
    console.log('='.repeat(55));

    const photoDir = path.join(process.cwd(), 'screenshots');
    if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
    const safeName = user.username.replace(/[^a-z0-9]/gi, '_');

    try {
      if (page.isClosed()) { page = await context.newPage(); await page.addInitScript(INJECTED_SCRIPT); }

      // ── 登出，确保干净 session ────────────────────────────────────
      if (page.url().includes('dashboard')) {
        await page.goto('https://dashboard.katabump.com/auth/logout');
        await page.waitForTimeout(2000);
      }
      await page.goto('https://dashboard.katabump.com/auth/login');
      await page.waitForTimeout(2000);
      if (page.url().includes('dashboard')) {
        await page.goto('https://dashboard.katabump.com/auth/logout');
        await page.waitForTimeout(2000);
        await page.goto('https://dashboard.katabump.com/auth/login');
      }
      await page.waitForTimeout(3000);

      // ── 登录：Turnstile → 填写账密 ───────────────────────────────
      console.log('[-] 正在登录前检查 Turnstile (CDP 绕过)...');
      let cdpClickResult = false;
      for (let fa = 0; fa < 15; fa++) {
        cdpClickResult = await attemptTurnstileCdp(page);
        if (cdpClickResult) break;
        await page.waitForTimeout(1000);
      }
      if (cdpClickResult) {
        console.log('[-] CDP 点击生效，等待最多 10s Cloudflare 成功标志...');
        for (let ws = 0; ws < 10; ws++) {
          let isSuccess = false;
          for (const f of page.frames()) {
            if (f.url().includes('cloudflare')) {
              try { if (await f.getByText('Success!', { exact: false }).isVisible({ timeout: 500 })) { isSuccess = true; break; } } catch (e) {}
            }
          }
          if (isSuccess) { console.log('[-] ✅ 登录前 Turnstile 验证成功。'); break; }
          await page.waitForTimeout(1000);
        }
      } else {
        console.log('[-] 未检测到 Turnstile，继续操作...');
      }

      console.log('[-] 正在输入凭据...');
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
            try { await page.screenshot({ path: failShot, fullPage: true }); } catch (e) {}
            await sendTelegramMessage(`❌ 账号 [${i + 1}/${users.length}]\n登录失败: 账号或密码错误`, failShot);
            continue;
          }
        } catch (e) {}
      } catch (e) { console.log('[-] 登录操作异常:', e.message); }

      // ── 等待跳转 & 找服务器 ──────────────────────────────────────
      let onServerPage = false;
      if (user.server_id) {
        // 有 server_id：等登录成功后直接跳转
        console.log(`[-] 等待登录跳转...`);
        try {
          await page.waitForURL('**/dashboard**', { timeout: 15000 });
          console.log('✅ 登录成功！跳转服务器页面...');
          await page.goto(`https://dashboard.katabump.com/servers/edit?id=${user.server_id}`);
          await page.waitForTimeout(4000);
          onServerPage = !page.url().includes('login');
        } catch (e) {
          console.log('❌ 登录跳转超时');
          const failShot = path.join(photoDir, `${safeName}_login_timeout.png`);
          try { await page.screenshot({ path: failShot, fullPage: true }); } catch (e2) {}
          await sendTelegramMessage(`❌ 账号 [${i + 1}/${users.length}]\n登录超时`, failShot);
          continue;
        }
      } else {
        // 无 server_id：点击 See 按钮（原逻辑）
        console.log('[-] 正在寻找 "See" 链接...');
        try {
          await page.getByRole('link', { name: 'See' }).first().waitFor({ timeout: 15000 });
          await page.waitForTimeout(1000);
          await page.getByRole('link', { name: 'See' }).first().click();
          onServerPage = true;
        } catch (e) {
          console.log('[-] 未找到 "See" 按钮。');
          if (page.url().includes('login')) { console.error('[-] 登录失败，跳过该账号。'); continue; }
        }
      }

      if (!onServerPage && user.server_id) {
        console.log('❌ 无法进入服务器页面，跳过该账号。');
        continue;
      }

      // ── Renew 流程（最多 20 次）──────────────────────────────────
      let renewSuccess = false;
      for (let attempt = 1; attempt <= 20; attempt++) {
        let hasCaptchaError = false;
        console.log(`\n[尝试 ${attempt}/20] 正在寻找 Renew 按钮...`);

        const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();
        try { await renewBtn.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) {}

        if (!await renewBtn.isVisible()) { console.log('[-] 未找到 Renew 按钮。'); break; }

        await renewBtn.click();
        console.log('[-] Renew 按钮已点击，等待弹窗...');

        const modal = page.locator('#renew-modal');
        try { await modal.waitFor({ state: 'visible', timeout: 5000 }); }
        catch (e) { console.log('[-] 弹窗未出现，重试...'); continue; }

        try { const box = await modal.boundingBox(); if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 }); } catch (e) {}

        // Turnstile（弹窗内）
        console.log('[-] 正在检查弹窗内 Turnstile...');
        let cdpOk = false;
        for (let fa = 0; fa < 30; fa++) {
          cdpOk = await attemptTurnstileCdp(page);
          if (cdpOk) break;
          console.log(` >> [寻找尝试 ${fa + 1}/30] 尚未找到 Turnstile...`);
          await page.waitForTimeout(1000);
        }
        if (cdpOk) {
          console.log('[-] CDP 点击生效，等待 8s...');
          await page.waitForTimeout(8000);
        } else {
          console.log('[-] 重试后仍未找到 Turnstile。');
        }
        // 检查 Turnstile Success
        for (const f of page.frames()) {
          if (f.url().includes('cloudflare')) {
            try { if (await f.getByText('Success!', { exact: false }).isVisible({ timeout: 500 })) console.log('[-] Turnstile Success 已确认。'); } catch (e) {}
          }
        }

        // ALTCHA
        const altchaOk = await solveAltchaIfPresent(page, 'Renew弹窗', 15, 8000);
        if (!altchaOk) {
          console.log('[-] ALTCHA 未通过，刷新重试...');
          await page.reload(); await page.waitForTimeout(3000);
          if (page.url().includes('login')) break;
          continue;
        }

        // 截图
        try { await page.screenshot({ path: path.join(photoDir, `${safeName}_before_confirm_${attempt}.png`), fullPage: true }); } catch (e) {}

        const confirmBtn = modal.getByRole('button', { name: 'Renew' });
        if (!await confirmBtn.isVisible()) {
          console.log('[-] 未找到 Confirm 按钮，刷新重试...');
          await page.reload(); await page.waitForTimeout(3000); continue;
        }

        console.log('[-] 点击 Confirm 提交续期...');
        await confirmBtn.click();

        try {
          const start = Date.now();
          while (Date.now() - start < 3000) {
            if (await page.getByText('Please complete the captcha to continue').isVisible()) {
              console.log('[-] ⚠️ captcha 错误提示出现');
              hasCaptchaError = true; break;
            }
            const notTime = page.getByText("You can't renew your server yet");
            if (await notTime.isVisible()) {
              const text = await notTime.innerText().catch(() => '');
              const match = text.match(/as of\s+(.*?)\s+\(/);
              const dateStr = match ? match[1] : 'Unknown';
              console.log(`[-] ⏳ 暂无法续期，下次可续期: ${dateStr}`);
              renewSuccess = true;
              const skipShot = path.join(photoDir, `${safeName}_skip.png`);
              try { await page.screenshot({ path: skipShot, fullPage: true }); } catch (e) {}
              try { const closeBtn = modal.getByLabel('Close'); if (await closeBtn.isVisible()) await closeBtn.click(); } catch (e) {}
              await sendTelegramMessage(`⏳ 账号 [${i + 1}/${users.length}]\n暂无法续期，下次可续期: ${dateStr}`, skipShot);
              break;
            }
            await page.waitForTimeout(200);
          }
        } catch (e) {}

        if (renewSuccess) break;
        if (hasCaptchaError) { await page.reload(); await page.waitForTimeout(3000); continue; }

        await page.waitForTimeout(2000);
        if (!await modal.isVisible()) {
          console.log('[-] ✅ 弹窗已关闭，续期成功！');
          const successShot = path.join(photoDir, `${safeName}_success.png`);
          try { await page.screenshot({ path: successShot, fullPage: true }); } catch (e) {}
          await sendTelegramMessage(`✅ 账号 [${i + 1}/${users.length}]\n续期成功！`, successShot);
          renewSuccess = true; break;
        } else {
          console.log('[-] 弹窗未关闭，刷新重试...');
          await page.reload(); await page.waitForTimeout(3000);
          if (page.url().includes('login')) break;
        }
      }

      if (!renewSuccess) {
        const failShot = path.join(photoDir, `${safeName}_renew_fail.png`);
        try { await page.screenshot({ path: failShot, fullPage: true }); } catch (e) {}
        await sendTelegramMessage(`❌ 账号 [${i + 1}/${users.length}]\n续期失败，20 次尝试均未成功`, failShot);
      }

    } catch (err) {
      console.error('处理账号时发生异常:', err);
      try { await page.screenshot({ path: path.join(photoDir, `${safeName}_error.png`), fullPage: true }); } catch (e) {}
    }

    console.log(`\n账号 [${i + 1}/${users.length}] 处理完成。`);
    if (i < users.length - 1) { console.log('⏳ 等待 5 秒...'); await page.waitForTimeout(5000); }
  }

  console.log('\n===== ✅ 全部账号处理完毕 =====');
  await browser.close();
  process.exit(0);
})();
