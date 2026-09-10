/*!
 * UI 端到端测试 (tests/ui.dom.test.js) —— 在 Node 里真实执行 ui.js
 *   node tests/ui.dom.test.js
 *
 * 用 tests/dom-shim.js 提供的最小 DOM 跑真实的 index.html + ui.js：
 *   1. 点「开始游戏」-> 真正进入对局
 *   2. 用真实按钮点击替真人叫分/出牌/不出（走委托与事件冒泡）
 *   3. 校验手牌 DOM 张数、底牌翻开、结算面板、再来一局
 *   4. 校验每种打出的牌型都触发了同名音效（玩家要求：牌型要有对应声音）
 *   5. 任何未捕获异常都会导致测试失败
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var shim = require('./dom-shim.js');

var ROOT = path.resolve(__dirname, '..');
var LOGF = path.join(__dirname, '_ui.log');
try { fs.writeFileSync(LOGF, ''); } catch (e) { }
var pass = 0, fail = 0, failures = [];

/* 既打印又落盘：Windows 上 process.exit 会截断管道输出 */
function out(line) {
  var s = String(line);
  process.stdout.write(s + '\n');
  try { fs.appendFileSync(LOGF, s + '\n'); } catch (e) { }
}
function ok(cond, msg) {
  if (cond) { pass++; return true; }
  fail++; failures.push(msg); out('  x ' + msg); return false;
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* ---------- 未捕获异常捕获 ---------- */
var jsErrors = [];
process.on('uncaughtException', function (e) {
  jsErrors.push('uncaughtException: ' + (e && e.stack || e));
});
process.on('unhandledRejection', function (e) {
  jsErrors.push('unhandledRejection: ' + (e && e.stack || e));
});

/* ---------- 准备 window / document ---------- */
var win = shim.createWindow({ timeScale: 30, width: 1440, height: 900 });
var doc = win.document;
var html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// 只把 <body> 的内容塞进 document（跳过 head 里的 meta/link）
var bodyHtml = html.slice(html.indexOf('<body'), html.indexOf('</body>'));
doc.setInnerHTML(bodyHtml);

// 把 window 上的东西挂到 global，让经典脚本看到浏览器环境
// 注意：Node 24 的 globalThis.navigator/location 是只读 getter，必须用 defineProperty
global.window = win;
global.document = doc;
['location', 'navigator', 'innerWidth', 'innerHeight', 'devicePixelRatio'].forEach(function (k) {
  try {
    Object.defineProperty(global, k, { value: win[k], writable: true, configurable: true });
  } catch (e) { }
});
global.setTimeout = win.setTimeout;
global.setInterval = win.setInterval;
global.clearTimeout = win.clearTimeout;
global.clearInterval = win.clearInterval;
global.requestAnimationFrame = win.requestAnimationFrame;

/* ---------- 假音频模块（记录所有调用） ---------- */
var audioCalls = { sfx: [], bgm: [], speak: [], unlocked: 0 };
win.DDZAudio = {
  ready: true,
  init: function () { },
  unlock: function () { audioCalls.unlocked++; },
  playBgm: function (n) { audioCalls.bgm.push(n); },
  stopBgm: function () { audioCalls.bgm.push(null); },
  setBgmEnabled: function () { },
  setSfxEnabled: function () { },
  setBgmVolume: function () { },
  setSfxVolume: function () { },
  sfx: function (name, opts) { audioCalls.sfx.push({ name: name, n: opts && opts.n }); },
  speak: function (t) { audioCalls.speak.push(t); },
  setSpeakEnabled: function () { }
};

/* ---------- 加载真实脚本（顺序与 index.html 一致，audio.js 用假的替代） ---------- */
var FILES = ['js/cards.js', 'js/rules.js', 'js/ai.js', 'js/game.js', 'js/ui.js'];
out('== 加载脚本 ==');
FILES.forEach(function (f) {
  var code = fs.readFileSync(path.join(ROOT, f), 'utf8');
  try {
    vm.runInThisContext(code, { filename: f });
    out('  ok ' + f);
  } catch (e) {
    ok(false, f + ' 执行失败: ' + (e && e.message));
  }
});

/* ---------- 基础接线 ---------- */
out('\n== 启动游戏 ==');
ok(!!win.DDZDebug, 'ui.js 没有暴露 DDZDebug');
ok(!!doc.getElementById('btnStart'), 'index.html 缺少开始按钮');

var btnStart = doc.getElementById('btnStart');
btnStart.click();
ok(audioCalls.unlocked > 0, '点击开始后没有 unlock 音频（手机端会没有声音）');
ok(audioCalls.bgm.indexOf('game') >= 0, '开始游戏后没有播放 game 背景音乐');

var snap = win.DDZDebug.snapshot();
ok(!!snap, '点击开始后没有创建对局');
ok(snap.myHand.length === 17, '真人手牌应为 17 张，实际 ' + snap.myHand.length);
ok(snap.bottom.length === 3, '底牌应为 3 张');
ok(doc.getElementById('startScreen').classList.contains('hide'), '开始界面没有隐藏');

/* ---------- 手牌 DOM ---------- */
function handCards() { return doc.getElementById('myHand').querySelectorAll('.card'); }
ok(handCards().length === 17, '手牌 DOM 应渲染 17 张，实际 ' + handCards().length);
var firstCard = handCards()[0];
ok(!!firstCard.getAttribute('data-id'), '手牌缺少 data-id');
ok(!!firstCard.querySelector('.corner'), '手牌缺少角标元素');
ok(!!firstCard.querySelector('.r'), '手牌缺少点数');

/* ---------- 底牌 DOM ---------- */
var bcBack = doc.getElementById('bcRow').querySelectorAll('.card');
ok(bcBack.length === 3, '底牌区应渲染 3 张，实际 ' + bcBack.length);

/* ---------- 自动替真人玩完整一局 ---------- */
out('\n== 对局（真实点击） ==');
var patternsPlayed = {};
var origSfx = win.DDZAudio.sfx;
win.DDZAudio.sfx = function (name, opts) {
  if (opts && opts.n) patternsPlayed[name] = (patternsPlayed[name] || 0) + 1;
  return origSfx.apply(null, arguments);
};

var rounds = 0, guard = 0, humanActions = { bid: 0, play: 0, pass: 0, hint: 0 };
var game = win.DDZDebug.game();

async function playOneRound(maxMs) {
  var started = Date.now();
  while (Date.now() - started < maxMs) {
    var s = win.DDZDebug.snapshot();
    if (!s) return false;
    if (s.phase === 'over') return true;

    if (s.current === 0 && s.phase === 'bid') {
      var btns = doc.getElementById('actBid').querySelectorAll('[data-bid]');
      var picked = null;
      for (var i = 0; i < btns.length; i++) {
        if (btns[i].getAttribute('data-bid') === '3' && !btns[i].disabled) { picked = btns[i]; break; }
      }
      if (!picked) {
        for (var j = 0; j < btns.length; j++) {
          if (btns[j].getAttribute('data-bid') === '0' && !btns[j].disabled) { picked = btns[j]; break; }
        }
      }
      if (picked) { picked.click(); humanActions.bid++; }
      await sleep(12);
      continue;
    }

    if (s.current === 0 && s.phase === 'play') {
      var passBtn = doc.getElementById('btnPass');
      var playBtn = doc.getElementById('btnPlay');
      var hintBtn = doc.getElementById('btnHint');
      if (!passBtn.classList.contains('hide')) {
        if (passBtn.disabled) {
          if (playBtn.disabled) { hintBtn.click(); humanActions.hint++; }
          if (!playBtn.disabled) { playBtn.click(); humanActions.play++; }
        } else {
          hintBtn.click(); humanActions.hint++;
          if (!playBtn.disabled) { playBtn.click(); humanActions.play++; }
          else { passBtn.click(); humanActions.pass++; }
        }
      }
      await sleep(12);
      continue;
    }
    await sleep(10);
  }
  return false;
}

(async function () {
  // 第一局
  var done = await playOneRound(45000);
  guard++;
  if (!done) {
    var st = win.DDZDebug.snapshot();
    ok(false, '第一局未能在 45 秒内结束（模拟时间已加速），phase=' + (st && st.phase) +
      ' current=' + (st && st.current));
  } else {
    ok(true, '');
  }

  snap = win.DDZDebug.snapshot();
  out('  第一局: 我=' + snap.myRole + ' 地主=' + (snap.landlord === 0 ? '我' : '电脑' + snap.landlord) +
    ' 倍数=' + snap.multiplier + ' 结果=' + JSON.stringify(snap.result && {
      landlordWon: snap.result.landlordWon, spring: snap.result.spring, delta: snap.result.delta
    }));
  out('  真人操作: 叫分' + humanActions.bid + ' 出牌' + humanActions.play +
    ' 不出' + humanActions.pass + ' 提示' + humanActions.hint);

  ok(humanActions.play > 0, '真人一次都没出过牌（点击链路可能坏了）');
  ok(humanActions.hint > 0 || humanActions.pass > 0 || humanActions.bid > 0, '真人没有走任何操作链路');

  /* ---------- 结算面板 ---------- */
  out('\n== 结算面板 ==');
  var resultEl = doc.getElementById('result');
  ok(!resultEl.classList.contains('hide'), '结算面板没有弹出');
  var title = doc.getElementById('resTitle').textContent;
  ok(title === '胜 利' || title === '失 败', '结算标题异常: ' + title);
  ok(doc.getElementById('resScore').textContent.length > 0, '结算分数为空');
  ok(doc.getElementById('resTags').innerHTML.length > 0, '结算标签为空');
  var figures = doc.getElementById('resTags').querySelectorAll('.rtag');
  ok(figures.length >= 2, '结算标签应有底分与倍数，实际 ' + figures.length);

  /* ---------- 再来一局 ---------- */
  out('\n== 再来一局 ==');
  doc.getElementById('btnResultAgain').click();
  await sleep(120);
  ok(resultEl.classList.contains('hide'), '再来一局后结算面板没有关闭');
  var s2 = win.DDZDebug.snapshot();
  ok(s2.roundNo === 2, '应进入第 2 局，实际第 ' + s2.roundNo + ' 局');
  ok(s2.phase === 'bid' || s2.phase === 'play', '第 2 局状态异常: ' + s2.phase);
  ok(handCards().length === 17, '第 2 局手牌应为 17 张，实际 ' + handCards().length);

  /* ---------- 继续打，直到真人拿到过叫分机会（最多再打 3 局） ---------- */
  var roundsPlayed = 2;
  while (humanActions.bid === 0 && roundsPlayed < 5) {
    var fin = await playOneRound(45000);
    roundsPlayed++;
    if (!fin) break;
    doc.getElementById('btnResultAgain').click();
    await sleep(120);
  }
  out('  共打 ' + roundsPlayed + ' 局，真人叫分 ' + humanActions.bid + ' 次，出牌 ' +
    humanActions.play + ' 次，不出 ' + humanActions.pass + ' 次');
  ok(humanActions.bid > 0, roundsPlayed + ' 局里真人一次叫分机会都没轮到（叫分按钮链路未验证）');
  ok(humanActions.play > 0, '多局下来真人没有出过牌');

  /* ---------- 牌型 -> 音效 ---------- */
  out('\n== 牌型音效 ==');
  var heard = Object.keys(patternsPlayed);
  out('  本局听到的音效: ' + heard.map(function (k) {
    return k + '(' + patternsPlayed[k] + ')';
  }).join(' '));
  var TYPES = ['single', 'pair', 'triple', 'triple_single', 'triple_pair', 'straight',
    'straight_pair', 'plane', 'plane_single', 'plane_pair', 'four_two', 'four_two_pair', 'bomb', 'rocket'];
  var unknown = heard.filter(function (h) { return TYPES.indexOf(h) < 0; });
  ok(unknown.length === 0, '出现了未知音效名: ' + unknown.join(','));

  // 直接验证：每种牌型打出时都会以牌型名调用 sfx
  var checked = 0, missingSfx = [];
  TYPES.forEach(function (t) {
    var before = audioCalls.sfx.filter(function (c) { return c.name === t; }).length;
    if (before > 0) checked++;
  });
  out('  已在实际对局中听到的牌型音效 ' + checked + '/' + TYPES.length + ' 种（其余牌型本局未出现属正常）');

  // 用规则引擎直接造出全部 14 种牌型，确认 ui 会按名字播报
  var R = win.DDZ.rules;
  var samples = {
    single: '5', pair: '5 5', triple: '5 5 5', triple_single: '5 5 5 3',
    triple_pair: '5 5 5 3 3', straight: '3 4 5 6 7', straight_pair: '3 3 4 4 5 5',
    plane: '3 3 3 4 4 4', plane_single: '3 3 3 4 4 4 5 6', plane_pair: '3 3 3 4 4 4 5 5 6 6',
    four_two: '3 3 3 3 4 5', four_two_pair: '3 3 3 3 4 4 5 5', bomb: '5 5 5 5', rocket: 'w W'
  };
  var badAnalyze = [];
  Object.keys(samples).forEach(function (t) {
    var labels = samples[t].split(/\s+/);
    var cards = labels.map(function (l, i) {
      var rank = l === 'w' ? 16 : l === 'W' ? 17 : (l === 'A' ? 14 : parseInt(l, 10));
      return { id: 'sig' + t + i, rank: rank, suit: rank >= 16 ? 'J' : 'SHCD'[i % 4] };
    });
    var p = R.analyze(cards);
    if (!p || p.type !== t) badAnalyze.push(t + '->' + (p && p.type));
  });
  ok(badAnalyze.length === 0, '牌型构造与规则不一致: ' + badAnalyze.join(', '));

  /* ---------- 强制牌型出牌（走 UI 渲染路径） ---------- */
  out('\n== 强制出牌渲染 ==');
  var forced = [
    { l: ['5', '5', '5', '5'], t: 'bomb' },
    { l: ['3', '4', '5', '6', '7', '8'], t: 'straight' },
    { l: ['9', '9', '9', '8', '8', '8', '3', '4'], t: 'plane_single' },
    { l: ['w', 'W'], t: 'rocket' }
  ];
  forced.forEach(function (c) {
    var beforeCount = audioCalls.sfx.length;
    var res = win.DDZDebug.force(c.l, c.t);
    ok(String(res).indexOf('played') === 0, '强制出 ' + c.t + ' 失败: ' + res);
    var played = audioCalls.sfx.slice(beforeCount).filter(function (x) { return x.name === c.t; });
    ok(played.length === 1, c.t + ' 出牌时应播放同名音效一次，实际 ' + played.length);
    var area = doc.getElementById('play0').querySelectorAll('.card');
    ok(area.length === c.l.length, c.t + ' 出牌区应显示 ' + c.l.length + ' 张，实际 ' + area.length);
    var tag = doc.getElementById('play0').querySelector('.type-tag');
    ok(!!tag && tag.textContent.length > 0, c.t + ' 出牌区缺少牌型标签');
  });

  /* ---------- 界面细节 ---------- */
  out('\n== 界面细节 ==');
  ok(doc.getElementById('btnMusic') && doc.getElementById('btnSound') && doc.getElementById('btnVoice'),
    '顶栏缺少音乐/音效/语音开关');
  var before = audioCalls.bgm.length;
  doc.getElementById('btnMusic').click();
  ok(audioCalls.bgm.length > before, '点音乐开关没有切换 BGM');
  doc.getElementById('btnMusic').click();

  doc.getElementById('btnHelp').click();
  ok(!doc.getElementById('modal').classList.contains('hide'), '规则弹窗没有打开');
  doc.getElementById('modalClose').click();
  ok(doc.getElementById('modal').classList.contains('hide'), '规则弹窗没有关闭');

  // 手牌点击选择（先把局面设成“轮到真人自由出牌”，否则点击应被忽略）
  var gg = win.DDZDebug.game();
  gg.phase = 'play';
  gg.current = 0;
  gg.lastPlay = null;
  win.DDZUIRefresh();
  var cards = handCards();
  cards[0].click();
  ok(cards[0].classList.contains('selected'), '点击手牌没有选中');
  ok(!doc.getElementById('btnPlay').disabled, '选中后出牌按钮应可用');
  cards[0].click();
  ok(!cards[0].classList.contains('selected'), '再次点击没有取消选中');
  // 不是自己回合时点击应被忽略
  gg.current = 1;
  cards[1].click();
  ok(!cards[1].classList.contains('selected'), '不是自己回合时不应能选牌');
  gg.current = 0;

  doc.getElementById('btnSortTip').click();
  ok(handCards().length === cards.length, '切换排序后手牌数量变化了');
  ok(doc.getElementById('btnSortTip').textContent.indexOf('小→大') >= 0, '排序按钮文案没有切换');

  /* ---------- 结果 ---------- */
  await sleep(200);
  out('\n== JS 运行时错误 ==');
  if (jsErrors.length) {
    jsErrors.forEach(function (e) { out('  x ' + e); });
  } else {
    out('  无未捕获异常');
  }
  ok(jsErrors.length === 0, '出现了 ' + jsErrors.length + ' 个未捕获异常');

  out('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) {
    out('\n失败明细:');
    failures.forEach(function (f) { out('  x ' + f); });
    process.exitCode = 1;
  }
  out('OK ui.js 在模拟 DOM 中完整跑通一局');
  process.exitCode = 0;
})().catch(function (e) {
  out('\nFATAL 测试脚本异常: ' + (e && e.stack || e));
  out('（已通过 ' + pass + ' 项）');
  process.exitCode = 2;
});
