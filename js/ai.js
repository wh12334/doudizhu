/*!
 * 斗地主 - 电脑 AI (ai.js)
 *   叫分评估 / 出牌决策 / 农民配合
 * 经典脚本，可直接 file:// 打开；同时兼容 Node（用于单元测试）
 */
(function (global) {
  'use strict';

  var isNode = typeof module !== 'undefined' && module.exports;
  var C = isNode ? require('./cards.js') : global.DDZ.cards;
  var R = isNode ? require('./rules.js') : global.DDZ.rules;

  /** 座位顺序：0 自己(下) -> 1 右 -> 2 左 -> 0 */
  function nextSeat(i) { return (i + 1) % 3; }
  function prevSeat(i) { return (i + 2) % 3; }

  /* ------------------------------------------------------------------ *
   *  叫分
   * ------------------------------------------------------------------ */
  function decideBid(hand, currentBid, rnd) {
    var rand = rnd || Math.random;
    var s = R.handStrength(hand) + (rand() * 3 - 1.5);
    var want = s >= 19 ? 3 : s >= 13 ? 2 : s >= 8.5 ? 1 : 0;
    if (want <= (currentBid || 0)) return 0;
    return want;
  }

  /* ------------------------------------------------------------------ *
   *  出牌决策
   * ------------------------------------------------------------------ */
  function idsOf(cards) {
    var m = {};
    for (var i = 0; i < cards.length; i++) m[cards[i].id] = 1;
    return m;
  }

  function removeCards(hand, play) {
    var used = idsOf(play);
    var out = [];
    for (var i = 0; i < hand.length; i++) if (!used[hand[i].id]) out.push(hand[i]);
    return out;
  }

  /** 出这手牌的“代价”：剩余手数越多越差，用大牌越差 */
  function moveCost(hand, play) {
    var rest = removeCards(hand, play);
    var units = R.decompose(rest).length;
    var pat = R.analyze(play);
    var cost = units * 1000 + pat.main * 12 + play.length * 2;
    if (R.isBombType(pat)) cost += 9000;
    return cost;
  }

  /** 该不该动炸弹 */
  function bombWorthIt(state, threat) {
    var enemy = state.enemy;
    var enemyCards = enemy >= 0 ? state.counts[enemy] : 99;
    if (enemyCards <= 2) return true;
    if (threat) return true;
    if (state.hand.length <= 4) return true;
    return false;
  }

  function chooseLead(state) {
    var hand = state.hand;
    var units = R.decompose(hand);

    // 能一把走完就直接赢
    if (units.length === 1) return units[0].cards;

    var isLandlord = state.me === state.landlord;
    var partner = isLandlord ? -1 : otherFarmer(state);
    var partnerNext = partner >= 0 && nextSeat(state.me) === partner;

    // 队友只剩 1 张且接着我出：出最小单张送牌
    if (partnerNext && state.counts[partner] === 1) {
      var singles = units.filter(function (u) { return u.kind === 'single'; });
      if (singles.length) {
        singles.sort(function (a, b) { return a.cards[0].rank - b.cards[0].rank; });
        return singles[0].cards;
      }
    }

    // 地主只剩 1 张：不要出单张（否则被一把走完），尽量出对子/连牌
    if (!isLandlord && state.counts[state.landlord] === 1) {
      var multi = units.filter(function (u) {
        return u.kind !== 'single' && u.kind !== 'bomb' && u.kind !== 'rocket' &&
          u.cards.length > 1;
      });
      if (multi.length) {
        multi.sort(function (a, b) {
          return R.analyze(a.cards).size - R.analyze(b.cards).size;
        });
        return multi[0].cards;
      }
    }

    var ordered = units.slice().sort(function (a, b) {
      var pa = R.analyze(a.cards), pb = R.analyze(b.cards);
      var ba = R.isBombType(pa) ? 1 : 0, bb = R.isBombType(pb) ? 1 : 0;
      if (ba !== bb) return ba - bb;                    // 炸弹/王炸留到最后
      if (pa.main !== pb.main) return pa.main - pb.main; // 先小后大
      return pb.size - pa.size;                          // 同点数优先多出牌
    });
    return ordered[0].cards;
  }

  function otherFarmer(state) {
    for (var i = 0; i < 3; i++) {
      if (i !== state.landlord && i !== state.me) return i;
    }
    return -1;
  }

  function chooseFollow(state) {
    var hand = state.hand;
    var last = state.lastPlay;
    var pat = last.pattern;
    var beats = R.findBeats(hand, pat);
    if (!beats.length) return null;

    // 能一把打完就打完
    for (var i = 0; i < beats.length; i++) {
      if (beats[i].length === hand.length) return beats[i];
    }

    var isLandlord = state.me === state.landlord;
    var lastIsPartner = !isLandlord && last.player >= 0 && last.player !== state.landlord;

    // 队友出的牌不压（除非能直接赢，上面已处理）
    if (lastIsPartner) {
      // 队友出的是炸弹/王炸 → 更不压
      return null;
    }

    var normal = [], bombs = [];
    for (i = 0; i < beats.length; i++) {
      var p = R.analyze(beats[i]);
      if (R.isBombType(p)) bombs.push(beats[i]);
      else normal.push(beats[i]);
    }

    if (normal.length) {
      normal.sort(function (a, b) { return moveCost(hand, a) - moveCost(hand, b); });
      var best = normal[0];
      var bp = R.analyze(best);
      var enemyCards = state.enemy >= 0 ? state.counts[state.enemy] : 99;

      // 用 2/王 去压小牌、双方都还有很多牌时，先忍一手
      if (bp.main >= 15 && pat.main <= 11 && enemyCards > 4 && hand.length > 9 &&
        state.counts[state.landlord] > 5) {
        var cheap = normal.filter(function (c) { return R.analyze(c).main < 15; });
        if (!cheap.length) return null;
        return cheap[0];
      }
      return best;
    }

    // 只有炸弹能压
    if (bombs.length) {
      var threat = false;
      // 对手(地主视角:任一农民 / 农民视角:地主)快走完了，必须炸
      if (state.enemy >= 0 && state.counts[state.enemy] <= 2) threat = true;
      if (!isLandlord && state.counts[state.landlord] <= 3) threat = true;
      // 自己炸完能直接赢
      for (i = 0; i < bombs.length; i++) if (bombs[i].length === hand.length) threat = true;
      if (threat && bombWorthIt(state, true)) {
        bombs.sort(function (a, b) { return moveCost(hand, a) - moveCost(hand, b); });
        return bombs[0];
      }
      // 农民炸地主的牌要谨慎，但地主快赢了就炸
      if (!isLandlord && state.counts[state.landlord] <= 5 && R.isBombType(pat)) {
        bombs.sort(function (a, b) { return moveCost(hand, a) - moveCost(hand, b); });
        return bombs[0];
      }
      return null;
    }
    return null;
  }

  /**
   * 决策入口
   * @param {Object} state {
   *   hand, me, landlord, counts:[3], lastPlay:{cards,pattern,player}|null, enemy
   * }
   * @returns {Array|null} 要出的牌；null = 不出
   */
  function choosePlay(state) {
    if (!state.lastPlay) return chooseLead(state);
    return chooseFollow(state);
  }

  /** 提示：可行出牌列表（供人类玩家“提示”按钮使用） */
  function hints(hand, lastPattern) {
    return R.findBeats(hand, lastPattern);
  }

  var api = {
    nextSeat: nextSeat,
    prevSeat: prevSeat,
    decideBid: decideBid,
    choosePlay: choosePlay,
    chooseLead: chooseLead,
    chooseFollow: chooseFollow,
    hints: hints,
    moveCost: moveCost,
    otherFarmer: otherFarmer
  };

  global.DDZ = global.DDZ || {};
  global.DDZ.ai = api;
  if (isNode) module.exports = api;

})(typeof window !== 'undefined' ? window : globalThis);
