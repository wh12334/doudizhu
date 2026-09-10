/*!
 * 斗地主 - 对局状态机 (game.js)  纯逻辑，无 DOM，可在 Node 中跑自对弈测试
 *   发牌 -> 叫分 -> 出牌 -> 结算(炸弹/春天/反春天倍数)
 */
(function (global) {
  'use strict';

  var isNode = typeof module !== 'undefined' && module.exports;
  var C = isNode ? require('./cards.js') : global.DDZ.cards;
  var R = isNode ? require('./rules.js') : global.DDZ.rules;
  var AI = isNode ? require('./ai.js') : global.DDZ.ai;

  var SEAT_NAMES = ['你', '电脑·小明', '电脑·老王'];

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function Game(opts) {
    opts = opts || {};
    this.rng = opts.seed != null ? mulberry32(opts.seed) : Math.random;
    this.handlers = {};
    this.roundNo = 0;
    this.scores = [0, 0, 0];
    this.players = [0, 1, 2].map(function (i) {
      return {
        id: i,
        name: opts.names ? opts.names[i] : SEAT_NAMES[i],
        isHuman: i === 0,
        hand: [],
        role: null,
        lastAction: null,
        score: 0
      };
    });
    this.autoBid = opts.autoBid !== false;   // 无人叫分时自动重发
    this.newRound();
  }

  Game.prototype.on = function (evt, fn) {
    (this.handlers[evt] = this.handlers[evt] || []).push(fn);
    return this;
  };
  Game.prototype.emit = function (evt) {
    var args = Array.prototype.slice.call(arguments, 1);
    var list = this.handlers[evt] || [];
    for (var i = 0; i < list.length; i++) list[i].apply(null, args);
  };

  /* ------------------------------------------------------------------ *
   *  发牌 / 叫分
   * ------------------------------------------------------------------ */
  Game.prototype.newRound = function () {
    this.roundNo++;
    var deck = C.shuffle(C.makeDeck(), this.rng);
    var p = this.players;
    p[0].hand = C.sortDesc(deck.slice(0, 17));
    p[1].hand = C.sortDesc(deck.slice(17, 34));
    p[2].hand = C.sortDesc(deck.slice(34, 51));
    this.bottom = C.sortDesc(deck.slice(51, 54));
    p.forEach(function (pl) { pl.role = null; pl.lastAction = null; });

    this.phase = 'bid';
    this.landlord = null;
    this.current = Math.floor(this.rng() * 3);
    this.bidStart = this.current;
    this.bidTurn = 0;
    this.bids = [null, null, null];
    this.currentBid = 0;
    this.currentBidder = -1;
    this.baseScore = 1;
    this.multiplier = 1;
    this.bombCount = 0;
    this.lastPlay = null;
    this.plays = [];
    this.farmerPlayCount = 0;      // 农民出牌次数（春天判定）
    this.landlordPlayCount = 0;    // 地主出牌次数（反春天判定）
    this.bottomRevealed = false;
    this.result = null;
    this.turnNo = 0;
    this.emit('deal');
    this.emit('update');
  };

  /** 某人叫分，score: 0=不叫, 1/2/3 */
  Game.prototype.bid = function (player, score) {
    if (this.phase !== 'bid') return false;
    var seat = (this.bidStart + this.bidTurn) % 3;
    if (player !== seat) return false;
    score = Math.max(0, Math.min(3, score | 0));

    this.players[player].lastAction = { type: score > 0 ? 'bid' : 'nobid', score: score };
    this.bids[player] = score;
    if (score > this.currentBid) {
      this.currentBid = score;
      this.currentBidder = player;
    }
    this.emit('bid', player, score);
    this.emit('update');

    if (score === 3) { this.assignLandlord(player); return true; }

    this.bidTurn++;
    if (this.bidTurn >= 3) {
      if (this.currentBidder >= 0) this.assignLandlord(this.currentBidder);
      else if (this.autoBid) {
        this.emit('redeal');
        this.newRound();
      }
      return true;
    }
    this.current = (this.bidStart + this.bidTurn) % 3;
    this.emit('update');
    return true;
  };

  Game.prototype.assignLandlord = function (player) {
    this.landlord = player;
    this.baseScore = Math.max(1, this.currentBid);
    var p = this.players;
    p[player].role = 'landlord';
    p[(player + 1) % 3].role = 'farmer';
    p[(player + 2) % 3].role = 'farmer';
    p[player].hand = C.sortDesc(p[player].hand.concat(this.bottom));
    this.bottomRevealed = true;
    this.phase = 'play';
    this.current = player;
    this.lastPlay = null;
    this.passCount = 0;
    p.forEach(function (pl) { pl.lastAction = null; });
    this.emit('landlord', player);
    this.emit('update');
  };

  /* ------------------------------------------------------------------ *
   *  出牌
   * ------------------------------------------------------------------ */
  Game.prototype._hasCards = function (player, cards) {
    var own = {}, i;
    for (i = 0; i < this.players[player].hand.length; i++) own[this.players[player].hand[i].id] = 1;
    for (i = 0; i < cards.length; i++) if (!own[cards[i].id]) return false;
    return true;
  };

  /** 校验出牌是否合法 */
  Game.prototype.validate = function (player, cards) {
    if (this.phase !== 'play') return { ok: false, reason: '现在不能出牌' };
    if (player !== this.current) return { ok: false, reason: '还没轮到你' };
    if (!cards || !cards.length) return { ok: false, reason: '请选择要出的牌' };
    if (!this._hasCards(player, cards)) return { ok: false, reason: '你没有这些牌' };
    var pat = R.analyze(cards);
    if (!pat) return { ok: false, reason: '牌型不合法' };
    if (this.lastPlay && this.lastPlay.player !== player) {
      if (!R.canBeat(pat, this.lastPlay.pattern)) {
        return { ok: false, reason: '管不上上家的牌' };
      }
    }
    return { ok: true, pattern: pat };
  };

  Game.prototype.play = function (player, cards) {
    var v = this.validate(player, cards);
    if (!v.ok) { this.emit('invalid', player, v.reason); return false; }
    var pl = this.players[player];
    var used = {};
    cards.forEach(function (c) { used[c.id] = 1; });
    pl.hand = pl.hand.filter(function (c) { return !used[c.id]; });

    this.plays.push({ player: player, cards: cards.slice(), pattern: v.pattern });
    pl.lastAction = { type: 'play', cards: cards.slice(), pattern: v.pattern };
    this.lastPlay = { player: player, cards: cards.slice(), pattern: v.pattern };
    this.passCount = 0;
    this.turnNo++;

    if (player === this.landlord) this.landlordPlayCount++;
    else this.farmerPlayCount++;

    var mult = this.multiplier;
    if (v.pattern.type === 'bomb') { this.multiplier *= 2; this.bombCount++; }
    if (v.pattern.type === 'rocket') { this.multiplier *= 2; this.bombCount++; }

    this.emit('play', player, cards.slice(), v.pattern, this.multiplier !== mult);
    this.emit('update');

    if (pl.hand.length === 0) { this.finish(player); return true; }

    // 其他两人都不要 -> 自己重新自由出牌
    this.current = AI.nextSeat(player);
    this.emit('update');
    return true;
  };

  Game.prototype.pass = function (player) {
    if (this.phase !== 'play' || player !== this.current || !this.lastPlay ||
      this.lastPlay.player === player) {
      this.emit('invalid', player, '现在必须出牌');
      return false;
    }
    this.players[player].lastAction = { type: 'pass' };
    this.passCount++;
    this.emit('pass', player);
    if (this.passCount >= 2) {
      // 转回上一手出牌者，自由出牌
      this.current = this.lastPlay.player;
      this.lastPlay = null;
      this.passCount = 0;
      this.turnNo++;
      this.emit('free', this.current);
    } else {
      this.current = AI.nextSeat(player);
    }
    this.emit('update');
    return true;
  };

  /* ------------------------------------------------------------------ *
   *  结算
   * ------------------------------------------------------------------ */
  Game.prototype.finish = function (winner) {
    this.phase = 'over';
    var landlordWon = winner === this.landlord;
    var mult = this.multiplier;
    var spring = false, antiSpring = false;

    if (landlordWon && this.farmerPlayCount === 0) { spring = true; mult *= 2; }
    if (!landlordWon && this.landlordPlayCount <= 1) { antiSpring = true; mult *= 2; }
    this.multiplier = mult;

    var base = this.baseScore * mult;
    var delta = [0, 0, 0];
    if (landlordWon) {
      delta[this.landlord] = 2 * base;
      for (var i = 0; i < 3; i++) if (i !== this.landlord) delta[i] = -base;
    } else {
      delta[this.landlord] = -2 * base;
      for (var j = 0; j < 3; j++) if (j !== this.landlord) delta[j] = base;
    }
    for (var k = 0; k < 3; k++) {
      this.scores[k] += delta[k];
      this.players[k].score = this.scores[k];
    }

    this.result = {
      winner: winner,
      landlordWon: landlordWon,
      spring: spring,
      antiSpring: antiSpring,
      multiplier: mult,
      baseScore: this.baseScore,
      delta: delta,
      myWin: (this.players[0].role === 'landlord') === landlordWon
    };
    this.emit('over', this.result);
    this.emit('update');
  };

  /* ------------------------------------------------------------------ *
   *  AI 驱动
   * ------------------------------------------------------------------ */
  /** 当前是否轮到电脑 */
  Game.prototype.isAiTurn = function () {
    return this.phase !== 'over' && !this.players[this.current].isHuman;
  };

  /** 供 AI 使用的局面信息 */
  Game.prototype.aiState = function (player) {
    var isLandlord = player === this.landlord;
    var enemy = isLandlord ? this.fewestFarmer() : this.landlord;
    return {
      hand: this.players[player].hand,
      me: player,
      landlord: this.landlord,
      counts: [this.players[0].hand.length, this.players[1].hand.length, this.players[2].hand.length],
      lastPlay: this.lastPlay,
      enemy: enemy,
      multiplier: this.multiplier
    };
  };

  Game.prototype.fewestFarmer = function () {
    var best = -1, bestN = 99;
    for (var i = 0; i < 3; i++) {
      if (i === this.landlord) continue;
      var n = this.players[i].hand.length;
      if (n < bestN) { bestN = n; best = i; }
    }
    return best;
  };

  /** 让当前电脑行动一手；返回是否真的行动了 */
  Game.prototype.step = function () {
    if (this.phase === 'over') return false;
    var p = this.current;
    if (this.players[p].isHuman) return false;

    if (this.phase === 'bid') {
      var score = AI.decideBid(this.players[p].hand, this.currentBid, this.rng);
      this.bid(p, score);
      return true;
    }
    if (this.phase === 'play') {
      var cards = AI.choosePlay(this.aiState(p));
      if (cards && cards.length) this.play(p, cards);
      else this.pass(p);
      return true;
    }
    return false;
  };

  /** 当前电脑的思考“力度”（用于播放不同的语音/音效） */
  Game.prototype.aiStateFor = function (player) { return this.aiState(player); };

  var api = { Game: Game, mulberry32: mulberry32, SEAT_NAMES: SEAT_NAMES };
  global.DDZ = global.DDZ || {};
  global.DDZ.Game = Game;
  global.DDZ.mulberry32 = mulberry32;
  if (isNode) module.exports = api;

})(typeof window !== 'undefined' ? window : globalThis);
