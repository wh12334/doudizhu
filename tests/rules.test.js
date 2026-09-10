/*!
 * 规则引擎单元测试 (tests/rules.test.js)
 *   node tests/rules.test.js
 *
 * 关键验证：把 findBeats 的结果与「枚举所有子集」的暴力结果对比，
 * 保证找牌既不漏也不错（带翅膀的牌型只校验“不漏报非法牌”，因为翅膀
 * 有多种等价选法，引擎只给出有限的几种方案）。
 */
'use strict';

var C = require('../js/cards.js');
var R = require('../js/rules.js');

var pass = 0, fail = 0, failures = [];

function ok(cond, msg) {
  if (cond) { pass++; return true; }
  fail++; failures.push(msg);
  return false;
}

function eq(a, b, msg) {
  var sa = JSON.stringify(a), sb = JSON.stringify(b);
  return ok(sa === sb, msg + '  expected=' + sb + ' got=' + sa);
}

/* ---------- 小工具：用字符串造手牌，如 "3 3 3 4" / "w W" ---------- */
var LABELS = null;
function labelToRank(lab) {
  if (!LABELS) {
    LABELS = {};
    for (var r = 3; r <= 15; r++) LABELS[C.label(r)] = r;
    LABELS['w'] = 16; LABELS['W'] = 17;
  }
  return LABELS[lab];
}
var seq = 0;
function mk(str) {
  var parts = str.trim().split(/\s+/);
  var suitIdx = {};
  return parts.map(function (p) {
    var rank = labelToRank(p);
    if (!rank) throw new Error('bad card label: ' + p);
    var suits = ['S', 'H', 'C', 'D'];
    var i = suitIdx[rank] = (suitIdx[rank] || 0);
    suitIdx[rank] = i + 1;
    return { id: 't' + (seq++), rank: rank, suit: rank >= 16 ? 'J' : suits[i % 4] };
  });
}
function T(str) { return R.analyze(mk(str)); }
function typeOf(str) { var p = T(str); return p ? p.type : null; }

/* ------------------------------------------------------------------ *
 * 1. 牌型识别
 * ------------------------------------------------------------------ */
eq(typeOf('5'), 'single', '单张');
eq(typeOf('5 5'), 'pair', '对子');
eq(typeOf('5 5 5'), 'triple', '三张');
eq(typeOf('5 5 5 5'), 'bomb', '炸弹');
eq(typeOf('w W'), 'rocket', '王炸');
eq(typeOf('w'), 'single', '小王单张');
eq(typeOf('5 5 5 3'), 'triple_single', '三带一');
eq(typeOf('5 5 5 3 3'), 'triple_pair', '三带二');
eq(typeOf('5 5 5 3 4'), null, '三带两张不同单张 = 非法');
eq(typeOf('3 4 5 6 7'), 'straight', '顺子5张');
eq(typeOf('3 4 5 6 7 8 9 10 J Q K A'), 'straight', '最长顺子12张');
eq(typeOf('3 4 5 6'), null, '顺子不足5张 = 非法');
eq(typeOf('10 J Q K A'), 'straight', '10JQKA');
eq(typeOf('J Q K A 2'), null, '顺子不可含2');
eq(typeOf('3 3 4 4 5 5'), 'straight_pair', '连对3对');
eq(typeOf('3 3 4 4'), null, '连对不足3对 = 非法');
eq(typeOf('K K A A 2 2'), null, '连对不可含2');
eq(typeOf('3 3 3 4 4 4'), 'plane', '飞机不带');
eq(typeOf('3 3 3 4 4 4 5 6'), 'plane_single', '飞机带两单');
eq(typeOf('3 3 3 4 4 4 5 5 6 6'), 'plane_pair', '飞机带两对');
eq(typeOf('3 3 3 4 4 4 5 5 5 6 7 8'), 'plane_single', '飞机3组带3单');
eq(typeOf('3 3 3 4 4 4 5 5 5'), 'plane', '飞机3组不带');
eq(typeOf('3 3 3 4 4 4 5 5 5 6 6 6'), 'plane', '飞机4组');
eq(typeOf('3 3 3 4 4 4 5'), null, '飞机翅膀数量不符 = 非法');
eq(typeOf('3 3 3 3 4 5'), 'four_two', '四带二');
eq(typeOf('3 3 3 3 4 4'), 'four_two', '四带一对(视为四带二)');
eq(typeOf('3 3 3 3 4 4 5 5'), 'four_two_pair', '四带两对');
// 33334444：按“飞机带单”(333 444 + 3 + 4)识别，这是各实现的通行判定
eq(typeOf('3 3 3 3 4 4 4 4'), 'plane_single', '两个炸弹可拆成飞机带单');
eq(typeOf('3 4'), null, '两张不同点数 = 非法');
eq(T('5 5 5 5').main, 5, '炸弹主点数');
eq(T('3 3 3 4 4 4 5 6').len, 2, '飞机长度=2组三张');
eq(T('10 J Q K A').main, 14, '顺子主点数=A');

/* ------------------------------------------------------------------ *
 * 2. 大小比较
 * ------------------------------------------------------------------ */
ok(R.canBeat(T('6'), T('5')), '大单张压小单张');
ok(!R.canBeat(T('5'), T('6')), '小单张不能压大单张');
ok(!R.canBeat(T('6'), T('5 5')), '单张不能压对子');
ok(R.canBeat(T('4 4 4 4'), T('A A A K K')), '炸弹压三带二');
ok(R.canBeat(T('w W'), T('2 2 2 2')), '王炸压炸弹');
ok(!R.canBeat(T('2 2 2 2'), T('w W')), '炸弹压不了王炸');
ok(R.canBeat(T('5 5 5 5'), T('4 4 4 4')), '大炸弹压小炸弹');
ok(!R.canBeat(T('3 3 3 3'), T('4 4 4 4')), '小炸弹压不了大炸弹');
ok(!R.canBeat(T('4 4 4 4 5 5'), T('A A A K K')), '四带二压不了三带二(类型不同)');
ok(R.canBeat(T('4 5 6 7 8'), T('3 4 5 6 7')), '顺子比大小');
ok(!R.canBeat(T('4 5 6 7 8 9'), T('3 4 5 6 7')), '不同长度顺子不可比');
ok(R.canBeat(T('4 4 4 5 5'), T('3 3 3 6 6')), '三带二比三张点数');
ok(R.canBeat(T('4 4 4 4 5 5'), T('3 3 3 3 6 6')), '四带二比四张点数');

/* ------------------------------------------------------------------ *
 * 3. 找牌：与暴力枚举对比
 * ------------------------------------------------------------------ */
function subsets(cards) {
  var out = [];
  var n = cards.length;
  for (var mask = 1; mask < (1 << n); mask++) {
    var pick = [];
    for (var i = 0; i < n; i++) if (mask & (1 << i)) pick.push(cards[i]);
    out.push(pick);
  }
  return out;
}
function key(cards) {
  return cards.map(function (c) { return c.rank; }).sort(function (a, b) { return a - b; }).join(',');
}

var WING_TYPES = { triple_single: 1, triple_pair: 1, plane_single: 1, plane_pair: 1, four_two: 1, four_two_pair: 1 };

function bruteBeats(hand, pat) {
  var all = subsets(hand);
  var out = {};
  for (var i = 0; i < all.length; i++) {
    var p = R.analyze(all[i]);
    if (!p) continue;
    if (R.canBeat(p, pat)) out[key(all[i])] = all[i];
  }
  return out;
}

function checkFindBeats(handStr, patStr, label) {
  var hand = mk(handStr);
  var pat = patStr ? T(patStr) : null;
  var found = R.findBeats(hand, pat);
  var foundMap = {};
  var soundness = true, badMsg = '';
  for (var i = 0; i < found.length; i++) {
    var play = found[i];
    var p = R.analyze(play);
    // 必须是手牌子集
    var handIds = {};
    hand.forEach(function (c) { handIds[c.id] = (handIds[c.id] || 0) + 1; });
    var usedIds = {};
    play.forEach(function (c) { usedIds[c.id] = (usedIds[c.id] || 0) + 1; });
    var subset = Object.keys(usedIds).every(function (id) { return (handIds[id] || 0) >= usedIds[id]; });
    if (!p || !subset || !R.canBeat(p, pat)) {
      soundness = false;
      badMsg = '非法候选 ' + JSON.stringify(play.map(function (c) { return C.label(c.rank); }));
      break;
    }
    if (foundMap[key(play)]) { soundness = false; badMsg = '重复候选'; break; }
    foundMap[key(play)] = play;
  }
  ok(soundness, '[' + label + '] 找牌结果必须全部合法且能压过: ' + badMsg);

  // 自由出牌时 findBeats 返回的是“拆牌候选”而非全部子集，故只校验合法性
  if (pat && !WING_TYPES[pat.type]) {
    var brute = bruteBeats(hand, pat);
    var missing = [];
    Object.keys(brute).forEach(function (k) { if (!foundMap[k]) missing.push(k); });
    ok(missing.length === 0, '[' + label + '] 找牌必须不漏 (缺 ' + missing.length + ' 种: ' + missing.slice(0, 3).join(' / ') + ')');
    var extra = Object.keys(foundMap).filter(function (k) { return !brute[k]; });
    ok(extra.length === 0, '[' + label + '] 找牌不可多报 (' + extra.slice(0, 3).join(' / ') + ')');
  }
}

checkFindBeats('3 4 5 6 7 8 9 10 J Q K A 2 2 w W', '5', '压单张');
checkFindBeats('3 4 5 6 7 8 9 10 J Q K A 2 2 w W', '8 8', '压对子');
checkFindBeats('3 4 5 6 7 8 9 10 J Q K A 2 2 w W', '8 8 8', '压三张');
checkFindBeats('3 4 5 6 7 8 9 10 J Q K A 2 2 w W', '6 7 8 9 10', '压顺子');
checkFindBeats('3 3 4 4 5 5 6 6 7 7 8 8', '3 3 4 4 5 5', '压连对');
checkFindBeats('3 3 3 4 4 4 5 5 5 6 6 6 7 7 7', '3 3 3 4 4 4', '压飞机');
checkFindBeats('3 3 3 3 4 4 4 4 5 5 5 5 6 6 6 6 w W', '3 3 3 3', '压炸弹');
checkFindBeats('w W', '2 2 2 2', '王炸压炸弹');
checkFindBeats('w', 'W', 'findBeats 压不了大王');
checkFindBeats('4 5 6 7 8 9 10 J Q K A 2 2 2 w W', '3 4 5 6 7', '压顺子-长');
checkFindBeats('3 3 3 4 4 4 5 5 5', null, '自由出牌');
checkFindBeats('3 3 3 4 5 6 7 8 9 10', null, '自由出牌2');

/* 随机对局：暴力校验（限小牌堆保证 2^n 可枚举） */
function randHand(n, rand) {
  var deck = C.makeDeck();
  // 只用 3..A + 少量 2/王，避免子集过大时的组合爆炸
  for (var i = deck.length - 1; i > 0; i--) {
    var j = Math.floor(rand() * (i + 1));
    var t = deck[i]; deck[i] = deck[j]; deck[j] = t;
  }
  return deck.slice(0, n);
}
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    var t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
var rand = mulberry32(20240501);
var patterns = ['5', '9 9', '7 7 7', '6 7 8 9 10', '3 3 4 4 5 5', 'J J J 4', 'Q Q Q 5 5', '4 4 4 4', null];
for (var ri = 0; ri < 40; ri++) {
  var hand = randHand(13, rand);
  var patStr = patterns[Math.floor(rand() * patterns.length)];
  var pat = patStr ? R.analyze(mk(patStr)) : null;
  var found = R.findBeats(hand, pat);
  var sound = true, msg = '';
  for (var fi = 0; fi < found.length; fi++) {
    var p2 = R.analyze(found[fi]);
    if (!p2 || !R.canBeat(p2, pat)) { sound = false; msg = '非法'; break; }
  }
  if (!ok(sound, '随机#' + ri + ' 找牌合法性 ' + msg)) break;
  if (pat && !WING_TYPES[pat.type]) {
    var brute = bruteBeats(hand, pat);
    var fm = {};
    found.forEach(function (c) { fm[key(c)] = 1; });
    var miss = Object.keys(brute).filter(function (k) { return !fm[k]; });
    if (!ok(miss.length === 0, '随机#' + ri + ' 找牌漏报 ' + miss.slice(0, 3).join('/') + ' pat=' + patStr + ' hand=' + hand.map(function (c) { return C.label(c.rank); }).join(' '))) break;
  }
}

/* ------------------------------------------------------------------ *
 * 4. 手牌拆分：单位是合法牌型，且恰好用完所有牌
 * ------------------------------------------------------------------ */
function checkDecompose(hand, label) {
  var units = R.decompose(hand);
  var idCount = {};
  hand.forEach(function (c) { idCount[c.id] = (idCount[c.id] || 0) + 1; });
  var seen = {};
  var legal = true, msg = '';
  units.forEach(function (u) {
    if (!R.analyze(u.cards)) { legal = false; msg = '非法单位 ' + u.kind + ' ' + u.cards.map(function (c) { return C.label(c.rank); }).join(' '); }
    u.cards.forEach(function (c) { seen[c.id] = (seen[c.id] || 0) + 1; });
  });
  ok(legal, '[' + label + '] 拆牌单位必须合法: ' + msg);
  var usedAll = Object.keys(seen).length === Object.keys(idCount).length &&
    Object.keys(seen).every(function (id) { return seen[id] === idCount[id]; });
  ok(usedAll, '[' + label + '] 拆牌必须不重不漏');
}

checkDecompose(mk('3 3 3 4 4 4 5 5 5 6 7 8 9 10 J Q K A 2 w W'), '大牌手');
checkDecompose(mk('3 4 5 6 7 8 9 10 J Q K A 2 2 w W 3 3 3'), '含顺子');
checkDecompose(randHand(17, rand), '随机17张');
checkDecompose(randHand(20, rand), '随机20张');
for (var di = 0; di < 30; di++) checkDecompose(randHand(17, rand), 'rand#' + di);

/* leadOptions 必须全部合法 */
for (var lo = 0; lo < 20; lo++) {
  var h = randHand(17, rand);
  var leads = R.leadOptions(h);
  var good = leads.every(function (l) { return !!R.analyze(l); });
  if (!ok(good, 'leadOptions#' + lo + ' 必须全为合法牌型')) break;
  var union = {};
  leads.forEach(function (l) { l.forEach(function (c) { union[c.id] = 1; }); });
  if (!ok(Object.keys(union).length === h.length, 'leadOptions#' + lo + ' 应覆盖全部手牌')) break;
}

/* ------------------------------------------------------------------ *
 * 5. 一副牌 / 洗牌
 * ------------------------------------------------------------------ */
var deck = C.makeDeck();
eq(deck.length, 54, '一副牌54张');
eq(C.counts(deck)[17], 1, '一个大王');
eq(C.counts(deck)[16], 1, '一个小王');
eq(C.counts(deck)[15], 4, '四个2');
var ids = {};
deck.forEach(function (c) { ids[c.id] = 1; });
eq(Object.keys(ids).length, 54, '牌 id 唯一');
var sh = C.shuffle(C.makeDeck());
eq(sh.length, 54, '洗牌后仍是54张');

/* ------------------------------------------------------------------ *
 * 结果
 * ------------------------------------------------------------------ */
console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) {
  console.log('\n失败明细:');
  failures.forEach(function (f) { console.log('  ✗ ' + f); });
  process.exit(1);
}
console.log('✓ rules.js 全部测试通过');
