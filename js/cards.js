/*!
 * 斗地主 - 牌面基础模块 (cards.js)
 * 牌堆生成 / 拆牌排序 / 点数工具
 * 经典脚本，可直接 file:// 打开；同时兼容 Node（用于单元测试）
 */
(function (global) {
  'use strict';

  var SUITS = ['S', 'H', 'C', 'D'];              // 黑桃 红桃 梅花 方块
  var SUIT_SYMBOL = { S: '\u2660', H: '\u2665', C: '\u2663', D: '\u2666', J: '' };
  var RANK_LABEL = {
    3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
    11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: 'w', 17: 'W'
  };
  var RANK_NAME = {
    3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
    11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: '小王', 17: '大王'
  };

  // 点数：3..15 为 3..2；16 小王；17 大王
  var MIN_RANK = 3;
  var MAX_RANK = 17;
  var MAX_CHAIN_RANK = 14;   // 顺子/连对/飞机最大到 A

  function label(rank) { return RANK_LABEL[rank] || String(rank); }
  function rankName(rank) { return RANK_NAME[rank] || String(rank); }
  function suitSymbol(suit) { return SUIT_SYMBOL[suit] || ''; }
  function isJoker(card) { return card.rank >= 16; }
  function isRed(card) { return card.suit === 'H' || card.suit === 'D' || card.rank === 17; }

  /** 生成一副 54 张牌（未洗牌） */
  function makeDeck() {
    var deck = [];
    var id = 0;
    for (var s = 0; s < SUITS.length; s++) {
      for (var r = MIN_RANK; r <= 15; r++) {
        deck.push({ id: 'c' + (id++), rank: r, suit: SUITS[s] });
      }
    }
    deck.push({ id: 'c' + (id++), rank: 16, suit: 'J' });   // 小王
    deck.push({ id: 'c' + (id++), rank: 17, suit: 'J' });   // 大王
    return deck;
  }

  /** 洗牌（Fisher-Yates） */
  function shuffle(deck, rand) {
    var rnd = rand || Math.random;
    for (var i = deck.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1));
      var t = deck[i]; deck[i] = deck[j]; deck[j] = t;
    }
    return deck;
  }

  var SUIT_ORDER = { S: 0, H: 1, C: 2, D: 3, J: 4 };

  /** 从大到小排序（同点数按花色） */
  function sortDesc(cards) {
    return cards.slice().sort(function (a, b) {
      if (b.rank !== a.rank) return b.rank - a.rank;
      return SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit];
    });
  }

  /** 从小到大排序 */
  function sortAsc(cards) {
    return cards.slice().sort(function (a, b) {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit];
    });
  }

  /** 点数计数表 counts[rank] = 张数，下标 3..17 */
  function counts(cards) {
    var c = new Array(18);
    for (var i = 0; i < 18; i++) c[i] = 0;
    for (var k = 0; k < cards.length; k++) c[cards[k].rank]++;
    return c;
  }

  /** 按点数分组：rank -> card[] */
  function groupByRank(cards) {
    var map = {};
    for (var i = 0; i < cards.length; i++) {
      var r = cards[i].rank;
      if (!map[r]) map[r] = [];
      map[r].push(cards[i]);
    }
    return map;
  }

  /** 手牌总点数（用于简单的叫分评估） */
  function totalPoints(cards) {
    var sum = 0;
    for (var i = 0; i < cards.length; i++) {
      var r = cards[i].rank;
      if (r === 17) sum += 8;
      else if (r === 16) sum += 6;
      else if (r === 15) sum += 4;
      else if (r === 14) sum += 2;
      else if (r === 13) sum += 1;
    }
    return sum;
  }

  var api = {
    SUITS: SUITS,
    SUIT_ORDER: SUIT_ORDER,
    MIN_RANK: MIN_RANK,
    MAX_RANK: MAX_RANK,
    MAX_CHAIN_RANK: MAX_CHAIN_RANK,
    label: label,
    rankName: rankName,
    suitSymbol: suitSymbol,
    isJoker: isJoker,
    isRed: isRed,
    makeDeck: makeDeck,
    shuffle: shuffle,
    sortDesc: sortDesc,
    sortAsc: sortAsc,
    counts: counts,
    groupByRank: groupByRank,
    totalPoints: totalPoints
  };

  global.DDZ = global.DDZ || {};
  global.DDZ.cards = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof window !== 'undefined' ? window : globalThis);
