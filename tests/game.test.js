/*!
 * 对局状态机测试 (tests/game.test.js)  —— 三台电脑全自动对弈
 *   node tests/game.test.js [局数]
 * 验证：出牌合法、牌数守恒、对局必然结束、结算倍数与分数守恒
 */
'use strict';

var C = require('../js/cards.js');
var R = require('../js/rules.js');
var AI = require('../js/ai.js');
var G = require('../js/game.js');

var ROUNDS = parseInt(process.argv[2] || '200', 10);

var pass = 0, fail = 0, failures = [];
function ok(cond, msg) {
  if (cond) { pass++; return true; }
  fail++; failures.push(msg); return false;
}

var stats = {
  landlordWins: 0, farmerWins: 0, springs: 0, antiSprings: 0,
  bombs: 0, rockets: 0, maxTurns: 0, redeals: 0, avgBid: 0, bidRounds: 0
};
var typeCount = {};

for (var round = 0; round < ROUNDS; round++) {
  var g = new G.Game({ seed: 1000 + round * 7919 });
  // 三台电脑对打（含 0 号座位，用于压力测试整条流程）
  g.players.forEach(function (p) { p.isHuman = false; });
  g.on('redeal', function () { stats.redeals++; });
  g.on('play', function (player, cards, pattern) {
    typeCount[pattern.type] = (typeCount[pattern.type] || 0) + 1;
    if (pattern.type === 'bomb') stats.bombs++;
    if (pattern.type === 'rocket') stats.rockets++;
  });

  var guard = 0;
  var before = g.players.reduce(function (s, p) { return s + p.hand.length; }, 0) + 3;
  if (before !== 54) { ok(false, '第' + round + '局 发牌总数=' + before); break; }

  while (g.phase !== 'over' && guard++ < 600) {
    var seat = g.current;
    var handBefore = g.players[seat].hand.slice();

    // 记录 AI 决定，随后用 validate 再校验一遍，确保 AI 不会出非法牌
    var decided = null;
    if (g.phase === 'bid') {
      decided = { kind: 'bid', score: AI.decideBid(handBefore, g.currentBid, g.rng) };
    } else {
      var st = g.aiState(seat);
      var cards = AI.choosePlay(st);
      decided = { kind: cards ? 'play' : 'pass', cards: cards };
    }

    if (decided.kind === 'play') {
      var v = g.validate(seat, decided.cards);
      if (!ok(v.ok, '第' + round + '局 AI出牌非法: ' + (v.reason || '') + ' cards=' +
        decided.cards.map(function (c) { return C.label(c.rank); }).join(' ') +
        ' last=' + (g.lastPlay ? g.lastPlay.pattern.name : '无'))) break;
      var p = R.analyze(decided.cards);
      if (!ok(R.canBeat(p, g.lastPlay ? g.lastPlay.pattern : null),
        '第' + round + '局 AI出的牌管不上上家')) break;
    }

    var acted = g.step();
    if (!ok(acted, '第' + round + '局 step() 未行动 (phase=' + g.phase + ')')) break;

    // 牌数守恒
    var inHands = g.players.reduce(function (s, p) { return s + p.hand.length; }, 0);
    var playedCards = g.plays.reduce(function (s, pl) { return s + pl.cards.length; }, 0);
    var bottom = g.bottomRevealed ? 0 : 3;
    if (!ok(inHands + playedCards + bottom === 54,
      '第' + round + '局 牌数不守恒: 手牌' + inHands + ' 已出' + playedCards + ' 底牌' + bottom)) break;

    if (g.phase === 'bid') stats.bidRounds++;
  }

  if (g.phase !== 'over') { ok(false, '第' + round + '局 超时未结束 (guard=' + guard + ')'); break; }
  ok(true, '');
  if (guard > stats.maxTurns) stats.maxTurns = guard;

  var res = g.result;
  if (res.landlordWon) stats.landlordWins++; else stats.farmerWins++;
  if (res.spring) stats.springs++;
  if (res.antiSpring) stats.antiSprings++;
  stats.avgBid += g.baseScore;

  ok(res.delta[0] + res.delta[1] + res.delta[2] === 0, '第' + round + '局 分数不守恒');
  ok(g.players[res.winner].hand.length === 0, '第' + round + '局 赢家手牌不为空');
  ok(g.scores[0] === g.players[0].score, '第' + round + '局 累计分未同步');
  if (res.spring) ok(res.delta[g.landlord] > 0, '第' + round + '局 春天必然地主赢');
  if (res.antiSpring) ok(!res.landlordWon, '第' + round + '局 反春天必然农民赢');
}

console.log('\n' + ROUNDS + ' 局自对弈完成');
console.log('  地主胜/农民胜: ' + stats.landlordWins + ' / ' + stats.farmerWins +
  '  (地主胜率 ' + (100 * stats.landlordWins / ROUNDS).toFixed(1) + '%)');
console.log('  春天 ' + stats.springs + ' 次，反春天 ' + stats.antiSprings + ' 次，重发牌 ' + stats.redeals + ' 次');
console.log('  炸弹 ' + stats.bombs + ' 次，王炸 ' + stats.rockets + ' 次，最长回合步数 ' + stats.maxTurns);
console.log('  平均底分 ' + (stats.avgBid / ROUNDS).toFixed(2) + '，叫分步数 ' + stats.bidRounds);
console.log('  牌型出现次数: ' + Object.keys(typeCount).sort(function (a, b) {
  return typeCount[b] - typeCount[a];
}).map(function (k) { return (R.TYPE_NAMES[k] || k) + '=' + typeCount[k]; }).join(' '));

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) {
  console.log('\n失败明细:');
  failures.slice(0, 12).forEach(function (f) { if (f) console.log('  ✗ ' + f); });
  process.exit(1);
}
console.log('✓ game.js / ai.js 全自动对弈测试通过');
