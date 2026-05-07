import os
import time
import subprocess
import urllib.request
import json
from seleniumbase import SB

# ==============================================================================
# 配置区：所有敏感信息从 GitHub Actions Secrets 环境变量读取
#
# KATABUMP_ACCOUNT Secret 格式（每行一个账号）：
#   email1@example.com----password1----server_id_1
#   email2@example.com----password2----server_id_2
#
# TG_BOT Secret 格式：bot_token:chat_id
# ==============================================================================
ACCOUNTS = []
for _line in os.getenv("KATABUMP_ACCOUNT", "").strip().splitlines():
    _line = _line.strip()
    if not _line:
        continue
    _parts = _line.split("----")
    if len(_parts) == 3:
        ACCOUNTS.append({
            "username":  _parts[0],
            "password":  _parts[1],
            "server_id": _parts[2],
        })

TG_BOT      = os.getenv("TG_BOT", "")
LOCAL_PROXY = "http://127.0.0.1:8080"

# ==============================================================================
# 日志掩码
# ==============================================================================
for _a in ACCOUNTS:
    for _v in _a.values():
        if _v:
            print(f"::add-mask::{_v}", flush=True)
    _url = f"https://dashboard.katabump.com/servers/edit?id={_a['server_id']}"
    print(f"::add-mask::{_url}", flush=True)

# ==============================================================================
# Telegram 通知
# ==============================================================================
def send_tg(msg: str):
    if not TG_BOT or ":" not in TG_BOT:
        return
    try:
        token, chat_id = TG_BOT.split(":", 1)
        data = json.dumps({"chat_id": chat_id, "text": f"🤖 Katabump-Renew:\n{msg}"}).encode()
        req = urllib.request.Request(
            f"https://api.telegram.org/bot{token}/sendMessage",
            data=data, headers={"Content-Type": "application/json"}
        )
        urllib.request.urlopen(req, timeout=10)
    except Exception:
        pass

# ==============================================================================
# xdotool 物理点击（Turnstile 和 ALTCHA 共用）
# ==============================================================================
def xdotool_click(x, y):
    x, y = int(x), int(y)
    try:
        result = subprocess.run(
            ["xdotool", "search", "--onlyvisible", "--class", "chrome"],
            capture_output=True, text=True, timeout=3
        )
        wids = [w for w in result.stdout.strip().split('\n') if w]
        if wids:
            subprocess.run(["xdotool", "windowactivate", wids[-1]], timeout=2, stderr=subprocess.DEVNULL)
            time.sleep(0.2)
        subprocess.run(["xdotool", "mousemove", str(x), str(y)], timeout=2, check=True)
        time.sleep(0.15)
        subprocess.run(["xdotool", "click", "1"], timeout=2, check=True)
        return True
    except Exception as e:
        print(f"  ⚠️ xdotool 点击失败: {e}")
        return False

def get_window_offset(sb):
    try:
        result = subprocess.run(
            ["xdotool", "search", "--onlyvisible", "--class", "chrome"],
            capture_output=True, text=True, timeout=3
        )
        wids = [w for w in result.stdout.strip().split('\n') if w]
        if wids:
            geo = subprocess.run(
                ["xdotool", "getwindowgeometry", "--shell", wids[-1]],
                capture_output=True, text=True, timeout=3
            ).stdout
            geo_dict = {}
            for line in geo.strip().split('\n'):
                if '=' in line:
                    k, v = line.split('=', 1)
                    geo_dict[k.strip()] = int(v.strip())
            win_x = geo_dict.get('X', 0)
            win_y = geo_dict.get('Y', 0)
            info = sb.execute_script("(function(){ return { outer: window.outerHeight, inner: window.innerHeight }; })()")
            toolbar = info['outer'] - info['inner']
            if not (30 <= toolbar <= 200):
                toolbar = 87
            return win_x, win_y, toolbar
    except Exception:
        pass
    try:
        info = sb.execute_script("""
(function(){
  return { screenX: window.screenX || 0, screenY: window.screenY || 0,
           outer: window.outerHeight, inner: window.innerHeight };
})()
""")
        toolbar = info['outer'] - info['inner']
        if not (30 <= toolbar <= 200):
            toolbar = 87
        return info['screenX'], info['screenY'], toolbar
    except Exception:
        return 0, 0, 87

# ==============================================================================
# Turnstile 工具函数（用于登录页）
# ==============================================================================
EXPAND_POPUP_JS = r"""
(function() {
  var turnstileInput = document.querySelector('input[name="cf-turnstile-response"]');
  if (!turnstileInput) return;
  var el = turnstileInput;
  for (var i = 0; i < 20; i++) {
    el = el.parentElement;
    if (!el) break;
    var style = window.getComputedStyle(el);
    if (style.overflow === 'hidden' || style.overflowX === 'hidden' || style.overflowY === 'hidden') {
      el.style.overflow = 'visible';
    }
    el.style.minWidth = 'max-content';
  }
  var iframes = document.querySelectorAll('iframe');
  iframes.forEach(function(iframe) {
    if (iframe.src && iframe.src.includes('challenges.cloudflare.com')) {
      iframe.style.width = '300px';
      iframe.style.height = '65px';
      iframe.style.minWidth = '300px';
      iframe.style.visibility = 'visible';
      iframe.style.opacity = '1';
    }
  });
})();
"""

def get_turnstile_coords(sb):
    try:
        return sb.execute_script("""
(function(){
  var iframes = document.querySelectorAll('iframe');
  for (var i = 0; i < iframes.length; i++) {
    var src = iframes[i].src || '';
    if (src.includes('cloudflare') || src.includes('turnstile')) {
      var rect = iframes[i].getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        return { click_x: Math.round(rect.x + 30), click_y: Math.round(rect.y + rect.height / 2) };
      }
    }
  }
  var input = document.querySelector('input[name="cf-turnstile-response"]');
  if (input) {
    var container = input.parentElement;
    for (var j = 0; j < 5; j++) {
      if (!container) break;
      var rect = container.getBoundingClientRect();
      if (rect.width > 100 && rect.height > 30) {
        return { click_x: Math.round(rect.x + 30), click_y: Math.round(rect.y + rect.height / 2) };
      }
      container = container.parentElement;
    }
  }
  return null;
})()
""")
    except Exception:
        return None

def check_turnstile_token(sb) -> bool:
    try:
        return sb.execute_script("""
(function(){
  var input = document.querySelector('input[name="cf-turnstile-response"]');
  return input && input.value && input.value.length > 20;
})()
""")
    except Exception:
        return False

def turnstile_exists(sb) -> bool:
    try:
        found = sb.execute_script(
            '(function(){ return document.querySelector(\'input[name="cf-turnstile-response"]\') !== null; })()'
        )
        if found:
            return True
        found = sb.execute_script("""
(function(){
  var iframes = document.querySelectorAll('iframe');
  for (var i = 0; i < iframes.length; i++) {
    try {
      var doc = iframes[i].contentDocument || iframes[i].contentWindow.document;
      if (doc && doc.querySelector('input[name="cf-turnstile-response"]')) return true;
    } catch(e) {}
    var src = iframes[i].src || '';
    if (src.includes('challenges.cloudflare.com') || src.includes('turnstile')) return true;
  }
  return false;
})()
""")
        return bool(found)
    except Exception:
        return False

def solve_turnstile(sb) -> bool:
    for _ in range(3):
        sb.execute_script(EXPAND_POPUP_JS)
        time.sleep(0.5)
    if check_turnstile_token(sb):
        print("✅ Turnstile 已通过（无需点击）")
        return True
    coords = get_turnstile_coords(sb)
    if not coords:
        print("❌ 无法获取 Turnstile 坐标")
        return False
    win_x, win_y, toolbar = get_window_offset(sb)
    abs_x = coords['click_x'] + win_x
    abs_y = coords['click_y'] + win_y + toolbar
    print("  🖱️ 点击 Turnstile（坐标已掩码）")
    xdotool_click(abs_x, abs_y)
    for _ in range(30):
        time.sleep(0.5)
        if check_turnstile_token(sb):
            print("✅ Turnstile 验证通过")
            return True
    print("❌ Turnstile 验证超时")
    sb.save_screenshot("turnstile_fail.png")
    return False

# ==============================================================================
# ALTCHA 工具函数（用于续期弹窗）
# 流程：点击 checkbox → 触发后台 PoW 计算 → 等待自动完成
# ==============================================================================
def altcha_exists(sb) -> bool:
    """检测页面或弹窗内是否有 ALTCHA 组件"""
    try:
        return sb.execute_script("""
(function(){
  if (document.querySelector('altcha-widget')) return true;
  if (document.querySelector('input[name="altcha"]')) return true;
  if (document.querySelector('[data-altcha]')) return true;
  var modal = document.querySelector('#renew-modal');
  if (modal) {
    if (modal.querySelector('altcha-widget')) return true;
    if (modal.querySelector('input[name="altcha"]')) return true;
  }
  return false;
})()
""")
    except Exception:
        return False

def click_altcha(sb) -> bool:
    """物理点击 ALTCHA checkbox，触发后台 PoW 计算"""
    try:
        coords = sb.execute_script("""
(function(){
  var widget = document.querySelector('altcha-widget');
  if (widget) {
    var r = widget.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      return { click_x: Math.round(r.x + 30), click_y: Math.round(r.y + r.height / 2) };
    }
  }
  return null;
})()
""")
        if not coords:
            print("❌ 无法获取 ALTCHA 坐标")
            return False
        win_x, win_y, toolbar = get_window_offset(sb)
        abs_x = coords['click_x'] + win_x
        abs_y = coords['click_y'] + win_y + toolbar
        print("  🖱️ 点击 ALTCHA checkbox（坐标已掩码）")
        xdotool_click(abs_x, abs_y)
        return True
    except Exception as e:
        print(f"❌ ALTCHA 点击异常: {e}")
        return False

def wait_for_altcha(sb, timeout=30) -> bool:
    """等待 ALTCHA 后台 PoW 计算完成"""
    print(f"  ⏳ 等待 ALTCHA 验证完成（最多 {timeout} 秒）...")
    for _ in range(timeout * 2):
        try:
            done = sb.execute_script("""
(function(){
  var input = document.querySelector('input[name="altcha"]');
  if (input && input.value && input.value.length > 10) return true;
  var modal = document.querySelector('#renew-modal');
  if (modal) {
    var modalInput = modal.querySelector('input[name="altcha"]');
    if (modalInput && modalInput.value && modalInput.value.length > 10) return true;
  }
  var widget = document.querySelector('altcha-widget');
  if (widget) {
    if (widget.getAttribute('verified') === 'true') return true;
    if (widget.classList.contains('verified')) return true;
    try {
      var shadow = widget.shadowRoot;
      if (shadow && shadow.querySelector('.verified')) return true;
    } catch(e) {}
  }
  return false;
})()
""")
            if done:
                print("✅ ALTCHA 验证完成")
                return True
        except Exception:
            pass
        time.sleep(0.5)
    print(f"❌ ALTCHA 验证超时（{timeout} 秒内未完成）")
    sb.save_screenshot("altcha_timeout.png")
    return False

# ==============================================================================
# 单账号续期流程
# ==============================================================================
def renew_account(idx: int, total: int, username: str, password: str, server_id: str):
    target_url = f"https://dashboard.katabump.com/servers/edit?id={server_id}"
    tag = f"[{idx}/{total}]"

    with SB(uc=True, test=True, proxy=LOCAL_PROXY) as sb:
        # IP 验证
        try:
            sb.open("https://api.ipify.org/?format=json")
            print(f"✅ {tag} 出口 IP: {sb.get_text('body')}")
        except Exception:
            print(f"⚠️ {tag} IP 验证超时，跳过")

        # ── 登录（Turnstile）──────────────────────────────────────────
        print(f"[-] {tag} 访问登录页...")
        sb.uc_open_with_reconnect("https://dashboard.katabump.com/auth/login", reconnect_time=4)
        time.sleep(3)

        print(f"[-] {tag} 输入账号密码...")
        try:
            sb.wait_for_element_visible('input[name="email"]', timeout=20)
            sb.type('input[name="email"]', username)
            sb.type('input[name="password"]', password)
        except Exception:
            print(f"❌ {tag} 无法加载登录框")
            sb.save_screenshot(f"login_fail_{idx}.png")
            send_tg(f"❌ 账号 {tag} 续期失败：无法加载登录框")
            return

        for _ in range(10):
            time.sleep(0.5)
            if turnstile_exists(sb):
                break

        if turnstile_exists(sb):
            print(f"[-] {tag} 检测到 Turnstile，开始解决...")
            if not solve_turnstile(sb):
                sb.save_screenshot(f"login_turnstile_fail_{idx}.png")
                send_tg(f"❌ 账号 {tag} 续期失败：登录 Turnstile 未通过")
                return
        else:
            print(f"[-] {tag} 无 Turnstile，直接提交...")

        try:
            sb.click('button[type="submit"]')
        except Exception:
            print(f"❌ {tag} 无法点击登录按钮")
            sb.save_screenshot(f"login_submit_fail_{idx}.png")
            send_tg(f"❌ 账号 {tag} 续期失败：无法点击登录按钮")
            return

        print(f"[-] {tag} 等待登录跳转...")
        for _ in range(80):
            try:
                if "/dashboard" in sb.get_current_url():
                    print(f"✅ {tag} 登录成功！")
                    break
            except Exception:
                pass
            time.sleep(0.5)
        else:
            print(f"❌ {tag} 登录超时")
            sb.save_screenshot(f"login_timeout_{idx}.png")
            send_tg(f"❌ 账号 {tag} 续期失败：登录超时")
            return

        # ── 跳转服务器页面 ────────────────────────────────────────────
        print(f"[-] {tag} 跳转服务器页面...")
        sb.execute_script(f"window.location.href = '{target_url}';")
        time.sleep(4)

        if "auth/login" in sb.get_current_url():
            print(f"❌ {tag} 被踢回登录页")
            sb.save_screenshot(f"server_page_{idx}.png")
            send_tg(f"❌ 账号 {tag} 续期失败：跳转后被踢回登录页")
            return

        sb.save_screenshot(f"server_page_{idx}.png")

        # ── 寻找 Renew 按钮 ───────────────────────────────────────────
        print(f"[-] {tag} 寻找 Renew 按钮...")
        renew_btn = None
        for sel in [
            'button[data-bs-target="#renew-modal"]',
            'button[data-target="#renew-modal"]',
            'a[data-bs-target="#renew-modal"]',
            '//button[contains(translate(text(),"renew","RENEW"),"RENEW")]',
        ]:
            try:
                if sb.is_element_visible(sel):
                    renew_btn = sel
                    print(f"✅ {tag} 找到 Renew 按钮")
                    break
            except Exception:
                continue

        if not renew_btn:
            print(f"❌ {tag} 找不到 Renew 按钮")
            sb.save_screenshot(f"no_renew_btn_{idx}.png")
            send_tg(f"❌ 账号 {tag} 续期失败：找不到 Renew 按钮")
            return

        try:
            sb.click(renew_btn)
            print(f"✅ {tag} 已点击 Renew 按钮，等待弹窗...")
            time.sleep(2)

            # ── 续期弹窗：ALTCHA 点击 + 等待 PoW 完成 ────────────────
            print(f"[-] {tag} 检测续期弹窗验证方式...")
            if altcha_exists(sb):
                print(f"[-] {tag} 检测到 ALTCHA，点击 checkbox...")
                if not click_altcha(sb):
                    sb.save_screenshot(f"altcha_click_fail_{idx}.png")
                    send_tg(f"❌ 账号 {tag} 续期失败：ALTCHA 点击失败")
                    return
                # 点击后等待后台 PoW 计算完成
                if not wait_for_altcha(sb, timeout=30):
                    sb.save_screenshot(f"altcha_fail_{idx}.png")
                    send_tg(f"❌ 账号 {tag} 续期失败：ALTCHA 验证超时")
                    return
            else:
                print(f"[-] {tag} 未检测到 ALTCHA，直接提交")

            # ── 提交续期 ──────────────────────────────────────────────
            print(f"🎯 {tag} 提交续期...")
            confirm_btn = '#renew-modal button[type="submit"]'
            if not sb.is_element_visible(confirm_btn):
                print(f"❌ {tag} 找不到 Confirm 按钮")
                sb.save_screenshot(f"no_confirm_btn_{idx}.png")
                send_tg(f"❌ 账号 {tag} 续期失败：找不到 Confirm 按钮")
                return

            sb.click(confirm_btn)
            print(f"[-] {tag} 已点击 Confirm...")
            time.sleep(5)

            if sb.is_element_visible('.alert-danger'):
                alert_text = sb.get_text('.alert-danger')
                if "can't renew" in alert_text or "in 3 day" in alert_text:
                    print(f"✅ {tag} 未到期，无需续期")
                    sb.save_screenshot(f"renew_too_early_{idx}.png")
                    send_tg(f"ℹ️ 账号 {tag} 服务器未到续期时间，跳过。")
                else:
                    print(f"⚠️ {tag} 错误提示（已掩码）")
                    sb.save_screenshot(f"renew_error_{idx}.png")
                    send_tg(f"⚠️ 账号 {tag} 续期错误，请查阅截图。")
            elif sb.is_element_visible('.alert-success'):
                print(f"🎉 {tag} 续期成功！")
                sb.save_screenshot(f"renew_success_{idx}.png")
                send_tg(f"✅ 账号 {tag} Katabump 服务器续期成功！")
            else:
                print(f"ℹ️ {tag} 提交完成（无明确状态）")
                sb.save_screenshot(f"unknown_result_{idx}.png")
                send_tg(f"ℹ️ 账号 {tag} 续期已提交，状态不明确，请查阅截图。")

        except Exception as e:
            print(f"❌ {tag} 操作异常: {e}")
            sb.save_screenshot(f"error_renew_{idx}.png")
            send_tg(f"❌ 账号 {tag} 续期崩溃: {e}")

# ==============================================================================
# 主入口
# ==============================================================================
if __name__ == "__main__":
    if not ACCOUNTS:
        print("❌ 未配置账号，请检查 KATABUMP_ACCOUNT Secret")
        print("   格式（每行一个）：email----password----server_id")
        send_tg("❌ 续期失败：未配置账号，请检查 KATABUMP_ACCOUNT Secret")
        raise SystemExit(1)

    total = len(ACCOUNTS)
    print(f"\n===== 🚀 Katabump 多账号续期 (共 {total} 个账号) =====")

    for i, account in enumerate(ACCOUNTS, 1):
        print(f"\n{'='*55}")
        print(f"🎯 处理账号 [{i}/{total}]")
        print(f"{'='*55}")
        renew_account(i, total, account["username"], account["password"], account["server_id"])
        if i < total:
            print("⏳ 等待 5 秒后处理下一个账号...")
            time.sleep(5)

    print(f"\n===== ✅ 全部账号处理完毕 =====")
