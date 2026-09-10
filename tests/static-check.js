/*!
 * 静态一致性检查 (tests/static-check.js)
 *   node tests/static-check.js
 *
 * 不依赖浏览器，检查最容易出错、又最致命的接线问题：
 *   1. ui.js 里引用的每个元素 id 都必须在 index.html 中存在
 *   2. index.html 引用的 css/js/图片资源都必须存在
 *   3. 每种牌型都必须有独立音效（玩家要求：打出核心牌型要发出对应声音）
 *   4. 三个角色头像文件必须存在
 *   5. 所有 js 文件语法可解析
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var child = require('child_process');

var ROOT = path.resolve(__dirname, '..');
var pass = 0, fail = 0, failures = [];
function ok(cond, msg) {
  if (cond) { pass++; return true; }
  fail++; failures.push(msg); console.log('  x ' + msg); return false;
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
function section(t) { console.log('\n== ' + t + ' =='); }

var html = read('index.html');
var ui = read('js/ui.js');
var audio = read('js/audio.js');
var rules = read('js/rules.js');

/* ---------- 1. 元素 id 接线 ---------- */
section('DOM id wiring (ui.js -> index.html)');
var htmlIds = {};
(html.match(/\bid="([^"]+)"/g) || []).forEach(function (m) {
  htmlIds[m.replace(/id="|"/g, '')] = 1;
});
console.log('  index.html 里的 id 共 ' + Object.keys(htmlIds).length + ' 个');

var wanted = [];
var idsMatch = ui.match(/var IDS = \[([\s\S]*?)\];/);
ok(!!idsMatch, 'ui.js 中找不到 IDS 列表');
if (idsMatch) {
  (idsMatch[1].match(/'([^']+)'/g) || []).forEach(function (s) { wanted.push(s.replace(/'/g, '')); });
}
var seatMatch = ui.match(/var SEAT = \{[\s\S]*?\n  \};/);
ok(!!seatMatch, 'ui.js 中找不到 SEAT 映射');
if (seatMatch) {
  (seatMatch[0].match(/(seat|av|tag|role|bubble|play|cnt):\s*'([^']+)'/g) || []).forEach(function (s) {
    wanted.push(s.replace(/\w+:\s*'|'/g, ''));
  });
}
// 动态拼接的 id
[0, 1, 2].forEach(function (i) { wanted.push('seat' + i); wanted.push('timer' + i); });

wanted = wanted.filter(function (v, i, a) { return v && a.indexOf(v) === i; });
var missing = wanted.filter(function (id) { return !htmlIds[id]; });
ok(missing.length === 0, 'ui.js 引用了 index.html 中不存在的 id: ' + missing.join(', '));
console.log('  ui.js 需要 ' + wanted.length + ' 个 id，全部存在: ' + (missing.length === 0));

/* ---------- 2. 资源存在性 ---------- */
section('asset references');
var refs = [];
(html.match(/(?:src|href)="([^"]+)"/g) || []).forEach(function (m) {
  var v = m.replace(/(?:src|href)="|"/g, '');
  if (v && !/^(https?:|#|data:)/.test(v)) refs.push(v);
});
(ui.match(/'(assets\/[^']+)'/g) || []).forEach(function (m) { refs.push(m.replace(/'/g, '')); });
refs = refs.filter(function (v, i, a) { return a.indexOf(v) === i; });
var missingFiles = refs.filter(function (r) { return !fs.existsSync(path.join(ROOT, r)); });
ok(missingFiles.length === 0, '以下被引用的文件不存在: ' + missingFiles.join(', '));
console.log('  资源引用 ' + refs.length + ' 个，缺失 ' + missingFiles.length + ' 个');
refs.forEach(function (r) { console.log('    - ' + r); });

/* ---------- 3. 角色头像 ---------- */
section('avatars');
['assets/avatars/landlord.png', 'assets/avatars/farmer1.png', 'assets/avatars/farmer2.png'].forEach(function (a) {
  var p = path.join(ROOT, a);
  var exists = fs.existsSync(p);
  ok(exists, '缺少头像 ' + a);
  if (exists) {
    var buf = fs.readFileSync(p);
    var isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
    var w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    ok(isPng && w === 512 && h === 512, a + ' 不是 512x512 PNG (' + w + 'x' + h + ')');
    console.log('    ' + a + '  ' + w + 'x' + h + '  ' + (buf.length / 1024).toFixed(0) + 'KB');
  }
});
ok(/AVA_LANDLORD\s*=\s*'assets\/avatars\/landlord\.png'/.test(ui), 'ui.js 未使用地主头像');
ok(/AVA_FARMERS\s*=\s*\[\s*'assets\/avatars\/farmer1\.png'\s*,\s*'assets\/avatars\/farmer2\.png'\s*\]/.test(ui),
  'ui.js 未使用两个农民头像');
ok(/function assignAvatars\(\)/.test(ui), 'ui.js 缺少 assignAvatars（按身份分配形象）');
ok(/img\.src = AVA_LANDLORD/.test(ui) && /img\.src = AVA_FARMERS/.test(ui),
  'ui.js 未按身份分配角色形象（地主要用地主形象，农民用两个农民形象）');

/* ---------- 4. 牌型 -> 音效 覆盖 ---------- */
section('pattern -> sfx coverage');
// rules.js 的全部牌型
var typeNames = {};
var tn = rules.match(/var TYPE_NAMES = \{([\s\S]*?)\n  \};/);
ok(!!tn, 'rules.js 找不到 TYPE_NAMES');
if (tn) {
  (tn[1].match(/^\s*(\w+):/gm) || []).forEach(function (m) {
    typeNames[m.replace(/[:\s]/g, '')] = 1;
  });
}
var patternTypes = Object.keys(typeNames);
console.log('  牌型 ' + patternTypes.length + ' 种: ' + patternTypes.join(' '));

// audio.js 实现的音效名
var sfxNames = [];
var sfxBlock = audio.match(/var SFX = \{([\s\S]*?)\n  \};/);
if (!sfxBlock) sfxBlock = audio.match(/SFX\s*=\s*\{([\s\S]*?)\n  \};/);
ok(!!sfxBlock, 'audio.js 找不到 SFX 表');
if (sfxBlock) {
  (sfxBlock[1].match(/^\s{4}([a-z_0-9]+):\s*function/gm) || []).forEach(function (m) {
    sfxNames.push(m.trim().replace(/:\s*function/, ''));
  });
}
console.log('  音效 ' + sfxNames.length + ' 种: ' + sfxNames.join(' '));

var noSound = patternTypes.filter(function (t) { return sfxNames.indexOf(t) < 0; });
ok(noSound.length === 0, '以下牌型没有对应音效: ' + noSound.join(', '));

// ui.js 是否真的把牌型传给了音效
ok(/sound\(pattern\.type,/.test(ui), 'ui.js 出牌时没有按牌型播放音效');
['spring', 'anti_spring', 'win', 'lose', 'deal', 'bid', 'nobid', 'pass', 'tick', 'warn', 'landlord', 'hint', 'select', 'click']
  .forEach(function (n) {
    ok(sfxNames.indexOf(n) >= 0, 'audio.js 缺少音效 ' + n);
    ok(ui.indexOf("'" + n + "'") >= 0 || ui.indexOf('sound(' + n) >= 0, 'ui.js 没有用到音效 ' + n);
  });

/* ---------- 5. 背景音乐 ---------- */
section('bgm');
['lobby', 'game', 'tense'].forEach(function (t) {
  ok(audio.indexOf("'" + t + "'") >= 0, 'audio.js 缺少 BGM 轨道 ' + t);
});
ok(/Au\.playBgm\('game'\)/.test(ui) || /playBgm\('game'\)/.test(ui), 'ui.js 开始游戏时没有播放 BGM');
ok(/playBgm/.test(read('js/ui.js')), 'ui.js 未调用 playBgm');
ok(/Au\.unlock\(\)/.test(ui), 'ui.js 没有在用户手势里 unlock 音频（手机端会没有声音）');
ok(/btnMusic/.test(ui) && /btnSound/.test(ui), 'ui.js 缺少音乐/音效开关');

/* ---------- 6. 三端适配要点 ---------- */
section('responsive / touch');
ok(/100dvh/.test(read('css/style.css')), 'CSS 未使用 100dvh（手机上会被地址栏挤压）');
ok(/touch-action: manipulation/.test(read('css/style.css')), 'CSS 缺少 touch-action（手机点按会有延迟/双击缩放）');
ok(/max-width: 560px/.test(read('css/style.css')), 'CSS 缺少手机竖屏断点');
ok(/max-height: 620px/.test(read('css/style.css')), 'CSS 缺少矮屏断点');
ok(/env\(safe-area-inset-bottom/.test(read('css/style.css')), 'CSS 未处理 iPhone 安全区');
ok(/viewport/.test(html) && /width=device-width/.test(html), 'index.html 缺少 viewport meta');
ok(/user-scalable=no/.test(html), 'index.html 未禁止缩放（手机上容易误缩放）');
ok(!/<script[^>]+type="module"/.test(html), '使用了 ES module（file:// 直接打开会失败）');
ok(!/\bfetch\s*\(/.test(ui + audio + read('js/game.js')), '代码里用了 fetch（file:// 直接打开会失败）');

/* ---------- 7. 语法 ---------- */
section('syntax');
['js/cards.js', 'js/rules.js', 'js/ai.js', 'js/game.js', 'js/audio.js', 'js/ui.js'].forEach(function (f) {
  var r = child.spawnSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'ignore' });
  ok(r.status === 0, f + ' 语法错误');
});
console.log('  6 个 js 文件语法检查完成');

/* ---------- 8. 浏览器端模块自检 ---------- */
section('module load order & globals');
var order = ['js/cards.js', 'js/rules.js', 'js/audio.js', 'js/ai.js', 'js/game.js', 'js/ui.js'];
var last = -1, orderOk = true;
order.forEach(function (f) {
  var i = html.indexOf(f);
  if (i < 0 || i < last) orderOk = false;
  last = i;
});
ok(orderOk, 'index.html 中脚本加载顺序不对（cards -> rules -> audio -> ai -> game -> ui）');
ok(/global\.DDZ\.cards\s*=/.test(read('js/cards.js')), 'cards.js 未挂到 window.DDZ');
ok(/global\.DDZ\.rules\s*=/.test(rules), 'rules.js 未挂到 window.DDZ');
ok(/global\.DDZ\.ai\s*=/.test(read('js/ai.js')), 'ai.js 未挂到 window.DDZ');
ok(/global\.DDZ\.Game\s*=/.test(read('js/game.js')), 'game.js 未挂到 window.DDZ');
ok(/window\.DDZAudio/.test(audio) || /global\.DDZAudio/.test(audio), 'audio.js 未挂到 window.DDZAudio');

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) {
  console.log('\n失败明细:');
  failures.forEach(function (f) { console.log('  x ' + f); });
  process.exit(1);
}
console.log('OK 静态接线检查全部通过');
