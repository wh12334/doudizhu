/*!
 * 浏览器端验收 (tools/verify-ui.js) —— Edge（默认）/ Chrome + 手机 & 电脑双端
 *   node tools/verify-ui.js
 *   DDZ_BROWSER=chrome node tools/verify-ui.js
 *
 * 流程：
 *   1. 在 5 种视口（桌面/笔记本/平板/手机竖屏/手机横屏）打开页面并截图
 *   2. 每个视口检查布局：无横竖溢出、手牌不超屏、操作按钮可见（含 23 张手牌压测）
 *   3. 桌面视口自动替真人打完一整局，验证叫分/出牌/结算/再来一局
 *   4. 强制摆出炸弹、顺子、飞机、三带一、王炸，截图验证牌型标签与特效
 *   5. 汇总 console 报错与未捕获异常，有问题则退出码非 0
 *
 * 注意：Windows 上 process.exit() 会截断管道输出，故所有日志同时写 tools/_verify.log，
 *       并用 process.exitCode 正常退出。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var http = require('http');
var child = require('child_process');

var ROOT = path.resolve(__dirname, '..');
var SHOTS = path.join(__dirname, '_shots');
var PROFILE = path.join(__dirname, '_chrome-profile');
var LOGFILE = path.join(__dirname, '_verify.log');
var PORT = 9333;

var EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];
var CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];
var want = (process.env.DDZ_BROWSER || 'edge').toLowerCase();
var CANDIDATES = want === 'chrome' ? CHROME.concat(EDGE) : EDGE.concat(CHROME);

var DEVICES = [
  { name: '01-desktop', w: 1440, h: 900, mobile: false, scale: 1 },
  { name: '02-laptop', w: 1280, h: 720, mobile: false, scale: 1 },
  { name: '03-ipad', w: 820, h: 1180, mobile: true, scale: 2 },
  { name: '04-phone', w: 390, h: 844, mobile: true, scale: 2 },
  { name: '05-phone-landscape', w: 844, h: 390, mobile: true, scale: 2 }
];

var problems = [];
var logs = [];

/* 控制台 + 文件双写 */
function log(line) {
  var s = String(line);
  process.stdout.write(s + '\n');
  try { fs.appendFileSync(LOGFILE, s + '\n'); } catch (e) { }
}
function flushAndExit(code) {
  try { fs.appendFileSync(LOGFILE, '\n[exit ' + code + ']\n'); } catch (e) { }
  process.exitCode = code;
}
function findBrowser() {
  for (var i = 0; i < CANDIDATES.length; i++) if (fs.existsSync(CANDIDATES[i])) return CANDIDATES[i];
  throw new Error('no Edge / Chrome found');
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function httpGet(url) {
  return new Promise(function (resolve, reject) {
    var req = http.get(url, function (res) {
      var b = '';
      res.on('data', function (d) { b += d; });
      res.on('end', function () { resolve(b); });
    });
    req.on('error', reject);
    req.setTimeout(2000, function () { req.destroy(new Error('timeout')); });
  });
}
function record(kind, text) {
  logs.push(kind + ': ' + text);
  if (kind !== 'log') problems.push(kind + ': ' + text);
  try { fs.appendFileSync(LOGFILE, '[' + kind + '] ' + text + '\n'); } catch (e) { }
}

function connect(wsUrl) {
  return new Promise(function (resolve, reject) {
    var ws;
    try { ws = new WebSocket(wsUrl); } catch (e) { return reject(e); }
    var id = 0, pending = new Map(), listeners = [];
    ws.onopen = function () { resolve(api); };
    ws.onerror = function () { reject(new Error('websocket error')); };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && pending.has(msg.id)) {
        var p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(JSON.stringify(msg.error)));
        else p.res(msg.result);
      } else {
        listeners.forEach(function (fn) { fn(msg); });
      }
    };
    var api = {
      send: function (method, params) {
        return new Promise(function (res, rej) {
          var i = ++id;
          pending.set(i, { res: res, rej: rej });
          ws.send(JSON.stringify({ id: i, method: method, params: params || {} }));
        });
      },
      on: function (fn) { listeners.push(fn); },
      close: function () { try { ws.close(); } catch (e) { } }
    };
  });
}

(async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  try { fs.writeFileSync(LOGFILE, ''); } catch (e) { }

  var browser = findBrowser();
  var url = 'file:///' + encodeURI(path.join(ROOT, 'index.html').replace(/\\/g, '/'));
  log('browser : ' + browser);
  log('page    : ' + url);

  var proc = child.spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--disable-breakpad', '--disable-crash-reporter', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--mute-audio',
    '--autoplay-policy=no-user-gesture-required', '--allow-file-access-from-files',
    '--window-size=1440,900', '--user-data-dir=' + PROFILE,
    '--remote-debugging-port=' + PORT, 'about:blank'
  ], { detached: true, stdio: 'ignore' });
  proc.unref();

  var target = null;
  for (var i = 0; i < 80; i++) {
    await sleep(350);
    try {
      var list = JSON.parse(await httpGet('http://127.0.0.1:' + PORT + '/json/list'));
      var pages = list.filter(function (t) { return t.type === 'page' && t.webSocketDebuggerUrl; });
      if (pages.length) { target = pages[0]; break; }
    } catch (e) {
      if (i % 12 === 11) log('  waiting for debug port... ' + (i + 1) + ' (' + e.message + ')');
    }
  }
  if (!target) throw new Error('cannot connect to debug port ' + PORT);
  log('connected to tab: ' + target.title);

  var cdp = await connect(target.webSocketDebuggerUrl);
  cdp.on(function (msg) {
    if (msg.method === 'Runtime.consoleAPICalled') {
      var txt = (msg.params.args || []).map(function (a) {
        return a.value !== undefined ? String(a.value) : (a.description || a.type);
      }).join(' ');
      record(msg.params.type === 'error' ? 'error' : 'log', txt);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      var d = msg.params.exceptionDetails;
      record('exception', (d.exception && d.exception.description) || d.text);
    } else if (msg.method === 'Log.entryAdded') {
      var e = msg.params.entry;
      if (e.level === 'error') record('error', '[' + e.source + '] ' + e.text);
    }
  });

  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Log.enable');

  async function evalJS(expr) {
    var r = await cdp.send('Runtime.evaluate', {
      expression: '(function(){' + expr + '})()', awaitPromise: true, returnByValue: true
    });
    if (r.exceptionDetails) {
      var d = r.exceptionDetails;
      throw new Error('eval error: ' + ((d.exception && d.exception.description) || d.text));
    }
    return r.result.value;
  }
  async function shot(name) {
    var r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.data, 'base64'));
    log('    shot -> tools/_shots/' + name + '.png');
  }
  async function loadPage(dev) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: dev.w, height: dev.h, deviceScaleFactor: dev.scale, mobile: !!dev.mobile
    });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: !!dev.mobile, maxTouchPoints: 5 });
    var loaded = new Promise(function (resolve) {
      var t = setTimeout(resolve, 9000);
      cdp.on(function (m) { if (m.method === 'Page.loadEventFired') { clearTimeout(t); resolve(); } });
    });
    await cdp.send('Page.navigate', { url: url });
    await loaded;
    await sleep(600);
  }
  async function layoutCheck(label) {
    var bad = await evalJS(
      'var bad=[];var vw=window.innerWidth,vh=window.innerHeight;var de=document.documentElement;' +
      'if(de.scrollWidth>vw+1)bad.push("horizontal overflow "+de.scrollWidth+">"+vw);' +
      'if(de.scrollHeight>vh+1)bad.push("vertical overflow "+de.scrollHeight+">"+vh);' +
      'var groups=[].slice.call(document.querySelectorAll(".act-group")).filter(function(g){return !g.classList.contains("hide");});' +
      'if(groups[0]){var r=groups[0].getBoundingClientRect();' +
      'if(r.bottom>vh+1||r.top<-1)bad.push("action bar offscreen top="+Math.round(r.top)+" bottom="+Math.round(r.bottom)+" vh="+vh);' +
      'var bs=groups[0].querySelectorAll("button");' +
      'for(var i=0;i<bs.length;i++){var br=bs[i].getBoundingClientRect();' +
      'if(br.right>vw+1||br.left<-1)bad.push("button out of width: "+bs[i].textContent);}}' +
      'var hand=document.getElementById("myHand").getBoundingClientRect();' +
      'if(hand.right>vw+1||hand.left<-1)bad.push("hand zone out "+Math.round(hand.left)+"~"+Math.round(hand.right));' +
      'var cs=document.querySelectorAll("#myHand .card");' +
      'if(cs.length){var f=cs[0].getBoundingClientRect(),l=cs[cs.length-1].getBoundingClientRect();' +
      'if(f.left<-1)bad.push("first card clipped left");' +
      'if(l.right>vw+1)bad.push("last card clipped right by "+(Math.round(l.right)-vw)+"px");' +
      'if(f.top<0)bad.push("cards clipped top");}' +
      'var seats=["seat0","seat1","seat2"];' +
      'for(var s=0;s<3;s++){var sr=document.getElementById(seats[s]).getBoundingClientRect();' +
      'if(sr.left<-2||sr.right>vw+2)bad.push(seats[s]+" out of left/right");' +
      'if(sr.top<-40)bad.push(seats[s]+" out of top");}' +
      'var tb=document.querySelector(".topbar").getBoundingClientRect();' +
      'if(tb.right>vw+1)bad.push("topbar overflow");' +
      'return bad;'
    );
    if (bad && bad.length) bad.forEach(function (b) { record('layout', '[' + label + '] ' + b); });
    else log('    layout OK (' + label + ')');
    return !bad || !bad.length;
  }
  async function handStress(label) {
    var n = await evalJS(
      'var g=DDZDebug.game();if(!g)return 0;var add=[];var suits=["S","H","C","D"];' +
      'for(var i=0;i<6;i++)add.push({id:"stress"+i+"_"+(g.roundNo||0),rank:3+(i%9),suit:suits[i%4]});' +
      'g.players[0].hand=g.players[0].hand.concat(add);window.DDZUIRefresh();return g.players[0].hand.length;'
    );
    await sleep(180);
    return { n: n, ok: await layoutCheck(label + ' with ' + n + ' cards') };
  }
  async function clickStart() {
    await evalJS('document.getElementById("btnStart").click();return 1;');
    await sleep(1300);
  }

  /* ---------- 1. 多端布局 ---------- */
  log('\n=== 1. multi-device layout ===');
  for (var d = 0; d < DEVICES.length; d++) {
    var dev = DEVICES[d];
    log('  . ' + dev.name + '  ' + dev.w + 'x' + dev.h + (dev.mobile ? ' (touch)' : ''));
    await loadPage(dev);
    await shot(dev.name + '-start');
    await clickStart();
    await shot(dev.name + '-table');
    await layoutCheck(dev.name + ' 17 cards');
    var st = await handStress(dev.name);
    if (dev.mobile) await shot(dev.name + '-hand' + st.n);
  }

  /* ---------- 2. 桌面完整对局 ---------- */
  log('\n=== 2. full round (desktop) ===');
  await loadPage(DEVICES[0]);
  await clickStart();

  var snap = await evalJS('return window.DDZDebug ? DDZDebug.snapshot() : null;');
  if (!snap) throw new Error('game not initialised');
  log('    deal: phase=' + snap.phase + ' myCards=' + snap.myHand.length + ' bottom=' + snap.bottom.join(','));
  if (snap.myHand.length !== 17) record('error', 'dealt ' + snap.myHand.length + ' cards, expected 17');
  if (snap.bottom.length !== 3) record('error', 'bottom cards != 3');

  var guard = 0, shotMid = false, turns = 0;
  while (guard++ < 300) {
    var st2 = await evalJS('return window.DDZDebug.snapshot();');
    if (!st2 || st2.phase === 'over') break;
    if (st2.phase === 'bid' && st2.current === 0) {
      await evalJS(
        'var b=document.querySelector("#actBid:not(.hide) [data-bid=\\"3\\"]");' +
        'if(b&&!b.disabled){b.click();return "bid3";}' +
        'var z=document.querySelector("#actBid:not(.hide) [data-bid=\\"0\\"]");' +
        'if(z){z.click();return "bid0";}return "none";'
      );
      await sleep(420);
      continue;
    }
    if (st2.phase === 'play' && st2.current === 0) {
      var acted = await evalJS(
        'var pass=document.getElementById("btnPass"),play=document.getElementById("btnPlay"),hint=document.getElementById("btnHint");' +
        'if(pass.classList.contains("hide"))return "hidden";' +
        'if(pass.disabled){if(play.disabled){hint.click();}if(!play.disabled){play.click();return "lead";}return "stuck";}' +
        'hint.click();if(!play.disabled){play.click();return "follow";}pass.click();return "pass";'
      );
      if (acted === 'stuck') { record('error', 'human cannot play nor pass'); break; }
      turns++;
      await sleep(430);
      if (!shotMid) {
        var c = await evalJS('return DDZDebug.snapshot().counts;');
        if (c[0] <= 15) { await shot('06-desktop-playing'); shotMid = true; await layoutCheck('mid-round'); }
      }
      continue;
    }
    await sleep(300);
  }
  log('    human turns played: ' + turns);

  snap = await evalJS('return window.DDZDebug.snapshot();');
  log('    end: phase=' + snap.phase + ' multiplier=' + snap.multiplier + ' myRole=' + snap.myRole +
    ' result=' + JSON.stringify(snap.result && {
      landlordWon: snap.result.landlordWon, spring: snap.result.spring,
      antiSpring: snap.result.antiSpring, delta: snap.result.delta
    }));
  if (snap.phase !== 'over') record('error', 'round did not finish within ' + guard + ' steps');
  await sleep(1500);
  await shot('07-desktop-result');
  if (await evalJS('return document.getElementById("result").classList.contains("hide");')) {
    record('error', 'result panel not shown');
  }
  await layoutCheck('result panel');

  /* ---------- 3. 牌型特效 ---------- */
  log('\n=== 3. card patterns ===');
  await evalJS('document.getElementById("btnResultAgain").click();return 1;');
  await sleep(1500);
  var cases = [
    { labels: ['5', '5', '5', '5'], tag: 'bomb', shot: '08-bomb' },
    { labels: ['3', '4', '5', '6', '7', '8'], tag: 'straight', shot: '09-straight' },
    { labels: ['9', '9', '9', '8', '8', '8', '3', '4'], tag: 'plane_single', shot: '10-plane' },
    { labels: ['Q', 'Q', 'Q', '7'], tag: 'triple_single', shot: '11-triple' },
    { labels: ['w', 'W'], tag: 'rocket', shot: '12-rocket' }
  ];
  for (var ci = 0; ci < cases.length; ci++) {
    var cse = cases[ci];
    var out = await evalJS('return DDZDebug.force(' + JSON.stringify(cse.labels) + ',' + JSON.stringify(cse.tag) + ');');
    log('    ' + cse.tag + ' -> ' + out);
    if (String(out).indexOf('played') !== 0) record('error', 'pattern ' + cse.tag + ' failed: ' + out);
    await sleep(380);
    await shot(cse.shot);
    await sleep(600);
  }

  /* ---------- 4. 音频 / 弹窗 ---------- */
  log('\n=== 4. audio & modal ===');
  var audio = await evalJS('return DDZDebug.audio();');
  log('    ' + JSON.stringify(audio));
  if (!audio || !audio.ready) record('error', 'DDZAudio.ready is false after start');
  await evalJS('document.getElementById("btnHelp").click();return 1;');
  await sleep(400);
  await shot('13-help');
  await evalJS('document.getElementById("modalClose").click();return 1;');
  await sleep(200);

  /* ---------- 5. 手机端二次进入 ---------- */
  log('\n=== 5. phone second pass ===');
  await loadPage(DEVICES[3]);
  await clickStart();
  await sleep(600);
  await shot('14-phone-table2');
  await layoutCheck('phone second pass');

  await cdp.send('Browser.close').catch(function () { });
  cdp.close();
  try { process.kill(proc.pid); } catch (e) { }

  log('\n---- last console lines ----');
  logs.slice(-15).forEach(function (l) { log('  ' + l); });
  if (problems.length) {
    log('\nFOUND ' + problems.length + ' problem(s):');
    problems.forEach(function (p) { log('  x ' + p); });
    flushAndExit(1);
    return;
  }
  log('\nAll good: Edge + mobile/desktop check passed');
  flushAndExit(0);
})().catch(function (e) {
  try { fs.appendFileSync(LOGFILE, '\nFATAL: ' + (e && e.stack || e) + '\n'); } catch (x) { }
  process.stderr.write('\nverify script failed: ' + (e && e.stack || e) + '\n');
  flushAndExit(2);
});
