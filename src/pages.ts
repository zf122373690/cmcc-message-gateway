// 移动端（WAP）页面：登录页 + 后台设置台。纯内联 HTML/CSS/JS，无需构建。

export function loginPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>登录 · CMCC 短信转发</title>
<style>
  :root{ --bg:#0f1115; --card:#1a1d24; --fg:#e9edf2; --mut:#8a93a0; --acc:#3b82f6; --acc2:#2563eb; --err:#f87171; --ok:#34d399; }
  *{box-sizing:border-box; -webkit-tap-highlight-color:transparent;}
  body{margin:0; background:var(--bg); color:var(--fg); font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px;}
  .wrap{width:100%; max-width:420px;}
  .logo{text-align:center; margin-bottom:24px;}
  .logo h1{font-size:20px; margin:0 0 6px;}
  .logo p{color:var(--mut); margin:0; font-size:13px;}
  .card{background:var(--card); border-radius:16px; padding:22px; box-shadow:0 10px 30px rgba(0,0,0,.35);}
  label{display:block; font-size:13px; color:var(--mut); margin:14px 0 6px;}
  input{width:100%; padding:13px 14px; border-radius:11px; border:1px solid #2a2f3a; background:#0f1218; color:var(--fg); font-size:16px; outline:none;}
  input:focus{border-color:var(--acc);}
  button{width:100%; margin-top:20px; padding:14px; border:0; border-radius:11px; background:var(--acc); color:#fff; font-size:16px; font-weight:600;}
  button:active{background:var(--acc2);}
  .msg{margin-top:14px; font-size:13px; min-height:18px;}
  .err{color:var(--err);} .ok{color:var(--ok);}
</style>
</head>
<body>
  <div class="wrap">
    <div class="logo"><h1>CMCC 短信转发</h1><p>请登录管理后台</p></div>
    <div class="card">
      <form id="f">
        <label>账号</label>
        <input id="user" autocomplete="username" placeholder="admin" value="admin">
        <label>密码</label>
        <input id="pass" type="password" autocomplete="current-password" placeholder="请输入密码">
        <button type="submit">登 录</button>
        <div class="msg" id="msg"></div>
      </form>
    </div>
  </div>
<script>
  const msg=document.getElementById('msg');
  document.getElementById('f').addEventListener('submit', async (e)=>{
    e.preventDefault();
    const user=document.getElementById('user').value;
    const pass=document.getElementById('pass').value;
    msg.className='msg'; msg.textContent='登录中…';
    try{
      const r=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user,pass})});
      const j=await r.json();
      if(!j.ok){ msg.className='msg err'; msg.textContent=j.message||'登录失败'; return; }
      // 登录成功后再验证一次会话 Cookie 是否真正生效，避免静默弹回登录页
      try{
        const s=await fetch('/api/settings');
        if(s.status===401){
          msg.className='msg err';
          msg.textContent='登录成功，但会话 Cookie 未被浏览器接受（请关闭无痕模式/拦截插件，或改用普通浏览器后重试）。';
          return;
        }
      }catch(e){}
      location.href='/admin';
    }catch(err){ msg.className='msg err'; msg.textContent='网络错误'; }
  });
</script>
</body></html>`;
}

export function adminPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>控制台 · CMCC 短信转发</title>
<style>
  :root{ --bg:#0f1115; --card:#1a1d24; --fg:#e9edf2; --mut:#8a93a0; --acc:#3b82f6; --acc2:#2563eb; --err:#f87171; --ok:#34d399; --line:#262b35; }
  *{box-sizing:border-box; -webkit-tap-highlight-color:transparent;}
  body{margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif; padding:16px; padding-bottom:48px;}
  .top{display:flex; align-items:center; justify-content:space-between; margin-bottom:16px;}
  .top h1{font-size:18px; margin:0;}
  .top button{width:auto; margin:0; padding:8px 14px; font-size:13px; background:#2a2f3a;}
  .card{background:var(--card); border-radius:14px; padding:16px; margin-bottom:14px; box-shadow:0 6px 20px rgba(0,0,0,.3);}
  .card h2{font-size:15px; margin:0 0 12px; color:#cdd5df;}
  .status{display:flex; flex-wrap:wrap; gap:10px;}
  .pill{flex:1 1 40%; background:#0f1218; border:1px solid var(--line); border-radius:10px; padding:10px 12px;}
  .pill .k{font-size:12px; color:var(--mut);}
  .pill .v{font-size:15px; font-weight:600; margin-top:2px;}
  .v.ok{color:var(--ok);} .v.err{color:var(--err);} .v.mut{color:var(--mut);}
  label{display:block; font-size:13px; color:var(--mut); margin:14px 0 6px;}
  input,select,textarea{width:100%; padding:12px 13px; border-radius:10px; border:1px solid var(--line); background:#0f1218; color:var(--fg); font-size:15px; outline:none;}
  textarea{resize:vertical; font-family:inherit;}
  input:focus{border-color:var(--acc);}
  .hint{font-size:12px; color:var(--mut); margin-top:5px;}
  .row{display:flex; gap:10px;}
  .row button{flex:1;}
  button{padding:13px; border:0; border-radius:10px; background:var(--acc); color:#fff; font-size:15px; font-weight:600; margin-top:14px;}
  button.ghost{background:#2a2f3a;} button:active{filter:brightness(.92);}
  .msg{font-size:13px; min-height:18px; margin-top:10px; white-space:pre-wrap;}
  .err{color:var(--err);} .ok{color:var(--ok);}
  .banner{background:#3a2a12; border:1px solid #6b4a18; color:#f6c768; padding:10px 12px; border-radius:10px; font-size:13px; margin-bottom:14px;}
  code{background:#0f1218; padding:2px 5px; border-radius:5px; font-size:12px;}
  .sec{font-size:13px; color:var(--mut); margin:6px 0;}
</style>
</head>
<body>
  <div class="top"><h1>控制台</h1><button class="ghost" id="logout">退出</button></div>
  <div id="banner" class="banner" style="display:none"></div>

  <div class="card">
    <h2>运行状态</h2>
    <div class="status">
      <div class="pill"><div class="k">WebSocket 连接</div><div class="v mut" id="st_conn">—</div></div>
      <div class="pill"><div class="k">中国移动认证</div><div class="v mut" id="st_auth">—</div></div>
      <div class="pill"><div class="k">默认接收人</div><div class="v mut" id="st_rec">—</div></div>
      <div class="pill"><div class="k">上次连接</div><div class="v mut" id="st_last">—</div></div>
    </div>
    <div class="row">
      <button id="refresh">刷新状态</button>
      <button id="connect">一键对接</button>
    </div>
    <div class="msg" id="msg_status"></div>
    <div class="msg" id="msg_notice" style="display:none"></div>
  </div>

  <div class="card">
    <h2>测试发送（验证对接）</h2>
    <label>接收手机号 / 接收人</label>
    <input id="testTo" placeholder="例如 13800138000（ClawBot 要发往的号码）">
    <label>测试内容</label>
    <textarea id="testContent" rows="3" placeholder="留空发送默认测试文案">【测试】CMCC 短信转发对接测试，收到请忽略。</textarea>
    <button id="testSend">发送测试消息</button>
    <div class="msg" id="msg_test"></div>
    <div class="hint" id="hint_test">发送后会等待约 4 秒采集平台回执：若显示“设备暂未在线”等平台通知，说明对接通道已通但目标设备未上线；若显示“已发送，请查收”，则通道与设备均正常。</div>
  </div>

  <div class="card">
    <h2>渠道配置</h2>
    <label>中国移动 API Key（K）</label>
    <input id="cmccApiKey" placeholder="ak_ 开头，留空表示不修改">
    <div class="hint" id="hint_k">当前：未设置</div>

    <label>设备接入令牌（API Token / T3 的 key1）</label>
    <input id="apiToken" placeholder="留空表示不修改；T3 自定义通道的密钥1需与此一致">
    <div class="hint" id="hint_t">当前：未设置</div>

    <label>默认接收人（可选）</label>
    <input id="defaultRecipient" placeholder="手机号；留空则用“手机给 ClawBot 发消息”自动记录">
    <div class="hint" id="hint_r">当前：未设置</div>

    <button id="save">保存配置</button>
    <div class="msg" id="msg_save"></div>
  </div>

  <div class="card">
    <h2>修改密码</h2>
    <label>当前密码</label>
    <input id="oldpass" type="password" placeholder="当前密码">
    <label>新密码</label>
    <input id="newpass" type="password" placeholder="至少 6 位">
    <button id="chpw" class="ghost">更新密码</button>
    <div class="msg" id="msg_pw"></div>
  </div>

  <div class="card">
    <h2>T3 设备对接说明</h2>
    <div class="sec">在 T3「推送设置 → 自定义」通道填写：</div>
    <div class="sec">• URL：<code id="url_push">/push</code></div>
    <div class="sec">• 密钥1（key1）：上面的“设备接入令牌”</div>
    <div class="sec">• 自定义消息体（纯文本，无需 JSON）：</div>
    <div class="sec"><code>{{短信内容}}</code></div>
    <div class="sec" style="margin-top:8px">首次需先在手机「新消息 ClawBot」发一条消息以记录默认接收人。</div>
  </div>

<script>
  const $=(id)=>document.getElementById(id);
  function show(el,text,cls){ el.className='msg '+(cls||''); el.textContent=text; }
  function mask(v){ if(!v) return '未设置'; return v.length>10? v.slice(0,6)+'••••••': '••••'; }

  async function load(){
    try{
      const r=await fetch('/api/settings'); const j=await r.json();
      if(!j.ok){ if(r.status===401){ location.href='/login'; return; } return; }
      $('hint_k').textContent='当前：'+mask(j.cmccApiKeySet?j.cmccApiKey:'');
      $('hint_t').textContent='当前：'+mask(j.apiTokenSet?j.apiToken:'');
      $('hint_r').textContent='当前：'+(j.defaultRecipient||'未设置');
      if(j.forceReset) $('banner').style.display='block', $('banner').textContent='⚠ 当前为默认密码 admin/admin123，请先在下方修改密码。';
      $('url_push').textContent=location.origin+'/push';
    }catch(e){}
  }

  async function status(){
    show($('msg_status'),'查询中…');
    try{
      const r=await fetch('/api/status'); const j=await r.json();
      setPill('st_conn', j.connected?'已连接':'未连接', j.connected?'ok':'err');
      setPill('st_auth', j.authenticated?'已认证':'未认证', j.authenticated?'ok':'err');
      setPill('st_rec', j.hasRecipient?'已设置':'未设置', j.hasRecipient?'ok':'mut');
      setPill('st_last', j.lastConnectAt?new Date(j.lastConnectAt).toLocaleString('zh-CN'):'—','mut');
      const noticeEl=$('msg_notice');
      if(j.lastNotice && j.lastNotice.text){ noticeEl.style.display='block'; noticeEl.textContent='平台最近通知：'+j.lastNotice.text; }
      else { noticeEl.style.display='none'; }
      show($('msg_status'), j.lastError? ('最近错误：'+j.lastError):'状态已刷新', j.lastError?'err':'ok');
    }catch(e){ show($('msg_status'),'查询失败','err'); }
  }
  function setPill(id,text,cls){ const el=$(id); el.textContent=text; el.className='v '+cls; }

  $('refresh').onclick=status;
  $('connect').onclick=async()=>{
    show($('msg_status'),'对接中（建立/重连中国移动 WebSocket）…');
    try{
      const r=await fetch('/api/connect',{method:'POST'}); const j=await r.json();
      if(j.ok) show($('msg_status'),'对接成功：connected='+j.connected+' authenticated='+j.authenticated,'ok');
      else show($('msg_status'), j.message||'对接失败','err');
      setTimeout(status,1500);
    }catch(e){ show($('msg_status'),'对接失败：网络错误','err'); }
  };

  $('save').onclick=async()=>{
    const body={ cmccApiKey:$('cmccApiKey').value.trim(), apiToken:$('apiToken').value.trim(), defaultRecipient:$('defaultRecipient').value.trim() };
    show($('msg_save'),'保存中（保存后会立即重连，最多约 10 秒）…');
    try{
      const r=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const j=await r.json();
      if(j.ok){
        $('cmccApiKey').value=''; $('apiToken').value=''; $('defaultRecipient').value='';
        if(j.connectError){
          show($('msg_save'),'已保存 ✅\\n⚠ 但重新对接失败：'+j.connectError+'\\n（配置已生效，连接会自动重试；也可点上方“一键对接”手动重试）','ok');
        }else{
          show($('msg_save'),'已保存并重新对接 ✅','ok');
        }
        load(); setTimeout(status,1500);
      }
      else show($('msg_save'), j.message||'保存失败','err');
    }catch(e){ show($('msg_save'),'保存失败：网络错误','err'); }
  };

  $('chpw').onclick=async()=>{
    const body={ oldpass:$('oldpass').value, newpass:$('newpass').value };
    show($('msg_pw'),'更新中…');
    try{
      const r=await fetch('/api/password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const j=await r.json();
      if(j.ok){ show($('msg_pw'),'密码已更新，请重新登录','ok'); setTimeout(()=>location.href='/login',1200); }
      else show($('msg_pw'), j.message||'更新失败','err');
    }catch(e){ show($('msg_pw'),'更新失败：网络错误','err'); }
  };

  $('testSend').onclick=async()=>{
    const to=$('testTo').value.trim();
    if(!to){ show($('msg_test'),'请先填写接收手机号/接收人','err'); return; }
    show($('msg_test'),'发送中（等待平台回执约 4 秒）…');
    try{
      const r=await fetch('/api/test-send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({to, content:$('testContent').value})});
      const j=await r.json();
      if(j.ok){
        if(j.notice) show($('msg_test'),'✅ 已发送，平台回执：\\n'+j.notice,'ok');
        else show($('msg_test'),'✅ 已发送（已写入通道，未实时收到平台回执，请查收手机）：messageId='+(j.messageId||''),'ok');
      } else show($('msg_test'),'❌ 发送失败：'+(j.message||'未知错误')+'\\n连接:'+(j.connected?'已连':'未连')+' 认证:'+(j.authenticated?'已认证':'未认证'),'err');
    }catch(e){ show($('msg_test'),'发送失败：网络错误','err'); }
  };

  $('logout').onclick=async()=>{ await fetch('/logout',{method:'POST'}); location.href='/login'; };

  load(); status();
</script>
</body></html>`;
}
