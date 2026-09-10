/*!
 * 斗地主 - 规则引擎 (rules.js)
 *   牌型识别 / 大小比较 / 找牌（压牌与出牌候选）/ 手牌拆分
 * 覆盖：单张 对子 三张 三带一 三带二 顺子 连对 飞机(带单/带对)
 *       四带二 四带两对 炸弹 王炸
 * 经典脚本，可直接 file:// 打开；同时兼容 Node（用于单元测试）
 */
(function (global) {
  'use strict';

  var isNode = typeof module !== 'undefined' && module.exports;
  var C = isNode ? require('./cards.js') : global.DDZ.cards;

  var MAX_CHAIN = C.MAX_CHAIN_RANK;   // 14 = A，顺子/连对/飞机不可含 2 和王

  var TYPE_NAMES = {
    single: '单张',
    pair: '对子',
    triple: '三张',
    triple_single: '三带一',
    triple_pair: '三带二',
    straight: '顺子',
    straight_pair: '连对',
    plane: '飞机',
    plane_single: '飞机带单',
    plane_pair: '飞机带对',
    four_two: '四带二',
    four_two_pair: '四带两对',
    bomb: '炸弹',
    rocket: '王炸'
  };

  function mk(type, main, size, len) {
    return { type: type, main: main, size: size, len: len || 0, name: TYPE_NAMES[type] || type };
  }

  function isBombType(pat) {
    return !!pat && (pat.type === 'bomb' || pat.type === 'rocket');
  }

  /* ------------------------------------------------------------------ *
   *  牌型识别
   * ------------------------------------------------------------------ */

  function rankWithCount(cnt, n) {
    for (var r = 3; r <= 17; r++) if (cnt[r] === n) return r;
    return 0;
  }

  function isRun(ranks) {
    for (var i = 1; i < ranks.length; i++) if (ranks[i] !== ranks[i - 1] + 1) return false;
    return true;
  }

  /** 飞机识别：返回 plane / plane_single / plane_pair */
  function analyzePlane(cnt, total, present) {
    var runs = [], run = [], r, i;
    for (r = 3; r <= MAX_CHAIN; r++) {
      if (cnt[r] >= 3) run.push(r);
      else if (run.length) { runs.push(run); run = []; }
    }
    if (run.length) runs.push(run);

    for (i = 0; i < runs.length; i++) {
      var rn = runs[i];
      for (var len = rn.length; len >= 2; len--) {
        for (var s = 0; s + len <= rn.length; s++) {
          var chain = rn.slice(s, s + len);
          var rem = cnt.slice();
          for (var k = 0; k < chain.length; k++) rem[chain[k]] -= 3;
          var remTotal = 0, remRanks = [], allPairs = true;
          for (var rr = 3; rr <= 17; rr++) {
            if (rem[rr] > 0) {
              remTotal += rem[rr];
              remRanks.push(rr);
              if (rem[rr] !== 2) allPairs = false;
            }
          }
          var main = chain[chain.length - 1];
          if (total === 3 * len && remTotal === 0) return mk('plane', main, total, len);
          if (total === 4 * len && remTotal === len) return mk('plane_single', main, total, len);
          if (total === 5 * len && remTotal === 2 * len && allPairs && remRanks.length === len) {
            return mk('plane_pair', main, total, len);
          }
        }
      }
    }
    return null;
  }

  /** 识别牌型；非法返回 null */
  function analyze(cs) {
    var n = cs.length;
    if (!n) return null;
    var cnt = C.counts(cs);
    var present = [], r, maxC = 0;
    for (r = 3; r <= 17; r++) {
      if (cnt[r] > 0) { present.push(r); if (cnt[r] > maxC) maxC = cnt[r]; }
    }
    var distinct = present.length;
    var top = present[distinct - 1];

    if (n === 2 && cnt[16] === 1 && cnt[17] === 1) return mk('rocket', 17, 2);
    if (n === 4 && distinct === 1 && maxC === 4) return mk('bomb', present[0], 4);
    if (n === 1) return mk('single', present[0], 1);
    if (n === 2 && distinct === 1) return mk('pair', present[0], 2);
    if (n === 3 && distinct === 1) return mk('triple', present[0], 3);
    if (n === 4 && maxC === 3 && distinct === 2) return mk('triple_single', rankWithCount(cnt, 3), 4);
    if (n === 5 && maxC === 3 && distinct === 2 && rankWithCount(cnt, 2)) {
      return mk('triple_pair', rankWithCount(cnt, 3), 5);
    }
    if (n === 6 && maxC === 4 && distinct >= 2) return mk('four_two', rankWithCount(cnt, 4), 6);
    if (n === 8 && maxC === 4) {
      var q = rankWithCount(cnt, 4);
      var rem = cnt.slice(); rem[q] = 0;
      var pr = 0, ok = true;
      for (r = 3; r <= 17; r++) {
        if (rem[r] === 0) continue;
        if (rem[r] === 2) pr++;
        else { ok = false; break; }
      }
      if (ok && pr === 2) return mk('four_two_pair', q, 8);
    }
    if (n >= 5 && distinct === n && top <= MAX_CHAIN && isRun(present)) {
      return mk('straight', top, n, distinct);
    }
    if (n >= 6 && n % 2 === 0 && distinct === n / 2 && distinct >= 3 && top <= MAX_CHAIN && isRun(present)) {
      var allTwo = true;
      for (r = 3; r <= 17; r++) if (cnt[r] && cnt[r] !== 2) { allTwo = false; break; }
      if (allTwo) return mk('straight_pair', top, n, distinct);
    }
    return analyzePlane(cnt, n, present);
  }

  /** a 能否压过 b（b 为 null 表示自由出牌） */
  function canBeat(a, b) {
    if (!a) return false;
    if (!b) return true;
    if (a.type === 'rocket') return b.type !== 'rocket';
    if (b.type === 'rocket') return false;
    if (a.type === 'bomb' && b.type !== 'bomb') return true;
    if (b.type === 'bomb' && a.type !== 'bomb') return false;
    if (a.type !== b.type) return false;
    if (a.size !== b.size) return false;
    return a.main > b.main;
  }

  /* ------------------------------------------------------------------ *
   *  出牌候选生成
   * ------------------------------------------------------------------ */

  function makeCtx(hand) {
    var cnt = C.counts(hand);
    var ranks = [];
    for (var r = 3; r <= 17; r++) if (cnt[r] > 0) ranks.push(r);
    return { hand: hand, cnt: cnt, ranks: ranks, buckets: C.groupByRank(hand) };
  }

  function group(ctx, rank, n) { return ctx.buckets[rank].slice(0, n); }

  function genSingles(ctx, min) {
    var out = [];
    for (var i = 0; i < ctx.ranks.length; i++) {
      var r = ctx.ranks[i];
      if (r > min) out.push(group(ctx, r, 1));
    }
    return out;
  }

  function genPairs(ctx, min, excludeRank) {
    var out = [];
    for (var i = 0; i < ctx.ranks.length; i++) {
      var r = ctx.ranks[i];
      if (r > min && r !== excludeRank && ctx.cnt[r] >= 2) out.push(group(ctx, r, 2));
    }
    return out;
  }

  function genTriples(ctx, min) {
    var out = [];
    for (var i = 0; i < ctx.ranks.length; i++) {
      var r = ctx.ranks[i];
      if (r > min && ctx.cnt[r] >= 3) out.push(group(ctx, r, 3));
    }
    return out;
  }

  function genTripleSingles(ctx, min) {
    var out = [];
    for (var i = 0; i < ctx.ranks.length; i++) {
      var rt = ctx.ranks[i];
      if (rt <= min || ctx.cnt[rt] < 3) continue;
      var base = group(ctx, rt, 3);
      for (var j = 0; j < ctx.ranks.length; j++) {
        var rs = ctx.ranks[j];
        if (rs === rt) continue;
        out.push(base.concat(group(ctx, rs, 1)));
      }
    }
    return out;
  }

  function genTriplePairs(ctx, min) {
    var out = [];
    for (var i = 0; i < ctx.ranks.length; i++) {
      var rt = ctx.ranks[i];
      if (rt <= min || ctx.cnt[rt] < 3) continue;
      var base = group(ctx, rt, 3);
      var wings = genPairs(ctx, 0, rt);
      for (var j = 0; j < wings.length; j++) out.push(base.concat(wings[j]));
    }
    return out;
  }

  function genStraights(ctx, minMain, exactSize) {
    var out = [];
    var lens = exactSize ? [exactSize] : [5, 6, 7, 8, 9, 10, 11, 12];
    for (var li = 0; li < lens.length; li++) {
      var len = lens[li];
      if (len < 5 || len > 12) continue;
      for (var start = 3; start + len - 1 <= MAX_CHAIN; start++) {
        var top = start + len - 1;
        if (exactSize && top <= minMain) continue;
        var ok = true, cards = [];
        for (var r = start; r <= top; r++) {
          if (ctx.cnt[r] < 1) { ok = false; break; }
          cards.push(ctx.buckets[r][0]);
        }
        if (ok) out.push(cards);
      }
    }
    return out;
  }

  function genStraightPairs(ctx, minMain, exactPairs) {
    var out = [];
    var lens = exactPairs ? [exactPairs] : [3, 4, 5, 6, 7, 8, 9, 10];
    for (var li = 0; li < lens.length; li++) {
      var len = lens[li];
      if (len < 3 || len > 10) continue;
      for (var start = 3; start + len - 1 <= MAX_CHAIN; start++) {
        var top = start + len - 1;
        if (exactPairs && top <= minMain) continue;
        var ok = true, cards = [];
        for (var r = start; r <= top; r++) {
          if (ctx.cnt[r] < 2) { ok = false; break; }
          cards.push(ctx.buckets[r][0], ctx.buckets[r][1]);
        }
        if (ok) out.push(cards);
      }
    }
    return out;
  }

  /**
   * 挑选翅膀（飞机带单/带对）
   * @returns 卡牌数组的数组（最多 3 种方案），每种长度 = need * size
   */
  function pickWings(ctx, reserved, need, size) {
    var cands = [], i;
    for (i = 0; i < ctx.ranks.length; i++) {
      var r = ctx.ranks[i];
      var off = reserved[r] || 0;
      var avail = ctx.cnt[r] - off;
      if (avail < size) continue;
      var units = Math.floor(avail / size);
      var cost;
      if (size === 1) cost = r + (r >= 16 ? 80 : 0) + (avail === 1 ? 0 : avail === 2 ? 45 : avail === 3 ? 130 : 520);
      else cost = r + (r >= 16 ? 80 : 0) + (avail === 2 ? 0 : avail >= 3 ? 90 : 0) + (avail === 4 ? 500 : 0);
      cands.push({ rank: r, avail: avail, cost: cost, units: units, off: off });
    }
    if (!cands.length) return [];

    cands.sort(function (a, b) { return a.cost - b.cost; });

    var variants = [];
    var offsets = [0, 1, 2];
    for (var oi = 0; oi < offsets.length; oi++) {
      var list = cands.slice(offsets[oi]).concat(cands.slice(0, offsets[oi]));
      var picked = [], count = 0, okList = true;
      for (i = 0; i < list.length && count < need; i++) {
        var c = list[i];
        var takeUnits = Math.min(c.units, need - count);
        for (var u = 0; u < takeUnits; u++) {
          picked.push(ctx.buckets[c.rank].slice(c.off + u * size, c.off + (u + 1) * size));
        }
        count += takeUnits;
      }
      if (count < need) okList = false;
      if (!okList) continue;
      var flat = [];
      for (i = 0; i < picked.length; i++) flat = flat.concat(picked[i]);
      variants.push(flat);
      if (variants.length >= 3) break;
    }
    return variants;
  }

  /** 飞机（可带翅膀） */
  function genPlanes(ctx, minMain, exactLen, wing) {
    var out = [], i;
    var runs = [], run = [];
    for (var r = 3; r <= MAX_CHAIN; r++) {
      if (ctx.cnt[r] >= 3) run.push(r);
      else if (run.length) { runs.push(run); run = []; }
    }
    if (run.length) runs.push(run);

    for (i = 0; i < runs.length; i++) {
      var rn = runs[i];
      var maxLen = rn.length;
      var lens = [];
      if (exactLen) { if (exactLen <= maxLen) lens.push(exactLen); }
      else { for (var L = maxLen; L >= 2; L--) lens.push(L); }

      for (var li = 0; li < lens.length; li++) {
        var len = lens[li];
        if (len < 2) continue;
        for (var s = 0; s + len <= rn.length; s++) {
          var chain = rn.slice(s, s + len);
          var top = chain[chain.length - 1];
          if (exactLen && top <= minMain) continue;
          var base = [], reserved = {};
          for (var k = 0; k < chain.length; k++) {
            base = base.concat(group(ctx, chain[k], 3));
            reserved[chain[k]] = (reserved[chain[k]] || 0) + 3;
          }
          if (!wing) { out.push(base); continue; }
          var size = wing === 'pair' ? 2 : 1;
          var wings = pickWings(ctx, reserved, len, size);
          for (var wi = 0; wi < wings.length; wi++) out.push(base.concat(wings[wi]));
        }
      }
    }
    return out;
  }

  function genBombs(ctx, min) {
    var out = [];
    for (var i = 0; i < ctx.ranks.length; i++) {
      var r = ctx.ranks[i];
      if (r > min && ctx.cnt[r] === 4) out.push(group(ctx, r, 4));
    }
    return out;
  }

  function genRocket(ctx) {
    if (ctx.cnt[16] >= 1 && ctx.cnt[17] >= 1) {
      return [ctx.buckets[16].slice(0, 1).concat(ctx.buckets[17].slice(0, 1))];
    }
    return [];
  }

  function genFourTwo(ctx, min, wing) {
    var out = [];
    for (var i = 0; i < ctx.ranks.length; i++) {
      var r = ctx.ranks[i];
      if (ctx.cnt[r] !== 4 || r <= min) continue;
      var base = group(ctx, r, 4);
      var reserved = {};
      reserved[r] = 4;
      if (wing === 'pair') {
        var w2 = pickWings(ctx, reserved, 2, 2);
        for (var a = 0; a < w2.length; a++) out.push(base.concat(w2[a]));
      } else {
        var w1 = pickWings(ctx, reserved, 2, 1);
        for (var b = 0; b < w1.length; b++) out.push(base.concat(w1[b]));
      }
    }
    return out;
  }

  function sig(cards) {
    var ids = cards.map(function (c) { return c.id; }).sort();
    return ids.join('|');
  }

  function dedupe(plays) {
    var seen = {}, out = [];
    for (var i = 0; i < plays.length; i++) {
      var s = sig(plays[i]);
      if (seen[s]) continue;
      seen[s] = 1;
      out.push(plays[i]);
    }
    return out;
  }

  /** 给一组出牌排序：普通牌型在前、点数小的在前、同点数张数少的在前 */
  function sortPlays(plays) {
    return plays.slice().sort(function (a, b) {
      var pa = analyze(a), pb = analyze(b);
      var ba = isBombType(pa) ? 1 : 0, bb = isBombType(pb) ? 1 : 0;
      if (ba !== bb) return ba - bb;
      if (pa.main !== pb.main) return pa.main - pb.main;
      if (pa.size !== pb.size) return pa.size - pb.size;
      return b.length - a.length;
    });
  }

  /**
   * 找出所有能压过 pat 的出牌
   * @param {Array} hand 手牌
   * @param {Object|null} pat 上一手牌型（null = 自由出牌）
   */
  function findBeats(hand, pat, opts) {
    opts = opts || {};
    var ctx = makeCtx(hand);
    var out = [];
    var withBombs = opts.includeBombs !== false;

    if (!pat) return sortPlays(dedupe(leadOptions(hand)));

    switch (pat.type) {
      case 'single': out = genSingles(ctx, pat.main); break;
      case 'pair': out = genPairs(ctx, pat.main); break;
      case 'triple': out = genTriples(ctx, pat.main); break;
      case 'triple_single': out = genTripleSingles(ctx, pat.main); break;
      case 'triple_pair': out = genTriplePairs(ctx, pat.main); break;
      case 'straight': out = genStraights(ctx, pat.main, pat.size); break;
      case 'straight_pair': out = genStraightPairs(ctx, pat.main, pat.size / 2); break;
      case 'plane': out = genPlanes(ctx, pat.main, pat.len, null); break;
      case 'plane_single': out = genPlanes(ctx, pat.main, pat.len, 'single'); break;
      case 'plane_pair': out = genPlanes(ctx, pat.main, pat.len, 'pair'); break;
      case 'four_two': out = genFourTwo(ctx, pat.main, 'single'); break;
      case 'four_two_pair': out = genFourTwo(ctx, pat.main, 'pair'); break;
      case 'bomb':
        out = genBombs(ctx, pat.main);
        if (withBombs) out = out.concat(genRocket(ctx));
        break;
      case 'rocket':
        out = [];
        break;
      default:
        out = [];
    }

    if (withBombs && pat.type !== 'bomb' && pat.type !== 'rocket') {
      out = out.concat(genBombs(ctx, 0));
      out = out.concat(genRocket(ctx));
    }
    return sortPlays(dedupe(out));
  }

  /* ------------------------------------------------------------------ *
   *  手牌拆分（拆成尽可能少的“手”）
   * ------------------------------------------------------------------ */

  function consecutiveRuns(avail, minCount, lo, hi) {
    var runs = [], run = [];
    for (var r = lo; r <= hi; r++) {
      if (avail(r) >= minCount) run.push(r);
      else if (run.length) { runs.push(run); run = []; }
    }
    if (run.length) runs.push(run);
    return runs;
  }

  /**
   * 把手牌拆成“手”的列表，用于 AI 评估
   * @returns {Array<{kind:string, cards:Array}>}
   */
  function decompose(hand) {
    var ctx = makeCtx(hand);
    var used = {};
    var units = [];

    function avail(r) { return ctx.cnt[r] - (used[r] || 0); }
    function take(r, n) {
      var out = ctx.buckets[r].slice(used[r] || 0, (used[r] || 0) + n);
      used[r] = (used[r] || 0) + n;
      return out;
    }

    // 王炸
    if (avail(16) >= 1 && avail(17) >= 1) {
      units.push({ kind: 'rocket', cards: take(16, 1).concat(take(17, 1)) });
    }
    // 炸弹
    for (var r = 3; r <= 15; r++) {
      if (avail(r) === 4) units.push({ kind: 'bomb', cards: take(r, 4) });
    }
    // 飞机（连续三张，长度 >= 2）
    var runs = consecutiveRuns(avail, 3, 3, MAX_CHAIN);
    for (var i = 0; i < runs.length; i++) {
      if (runs[i].length < 2) continue;
      var cards = [];
      for (var k = 0; k < runs[i].length; k++) cards = cards.concat(take(runs[i][k], 3));
      units.push({ kind: 'plane', cards: cards });
    }
    // 顺子（尽量长，尽量不拆对子/三张）
    for (var iter = 0; iter < 8; iter++) {
      var best = null;
      var sruns = consecutiveRuns(avail, 1, 3, MAX_CHAIN);
      for (var si = 0; si < sruns.length; si++) {
        var rn = sruns[si];
        if (rn.length < 5) continue;
        var len = Math.min(rn.length, 12);
        for (var st = 0; st + len <= rn.length; st++) {
          var block = rn.slice(st, st + len);
          var damage = 0;
          for (var bi = 0; bi < block.length; bi++) if (avail(block[bi]) >= 2) damage++;
          if (!best || damage < best.damage || (damage === best.damage && block[0] < best.block[0])) {
            best = { block: block, damage: damage };
          }
        }
      }
      if (!best) break;
      var scards = [];
      for (var ci = 0; ci < best.block.length; ci++) scards = scards.concat(take(best.block[ci], 1));
      units.push({ kind: 'straight', cards: scards });
    }
    // 连对
    var pruns = consecutiveRuns(avail, 2, 3, MAX_CHAIN);
    for (var pi = 0; pi < pruns.length; pi++) {
      if (pruns[pi].length < 3) continue;
      var pcards = [];
      for (var pk = 0; pk < pruns[pi].length; pk++) pcards = pcards.concat(take(pruns[pi][pk], 2));
      units.push({ kind: 'straight_pair', cards: pcards });
    }
    // 三张 / 对子 / 单张
    for (r = 3; r <= 17; r++) {
      var a3 = avail(r);
      if (a3 >= 3) units.push({ kind: 'triple', cards: take(r, 3) });
    }
    for (r = 3; r <= 17; r++) {
      if (avail(r) >= 2) units.push({ kind: 'pair', cards: take(r, 2) });
    }
    for (r = 3; r <= 17; r++) {
      while (avail(r) >= 1) units.push({ kind: 'single', cards: take(r, 1) });
    }

    // 组牌：三张 / 飞机 带小牌，减少总手数
    function junkSingles(maxRank) {
      var list = [];
      for (var u = 0; u < units.length; u++) {
        if (units[u].kind === 'single' && units[u].cards[0].rank <= maxRank) list.push(u);
      }
      list.sort(function (x, y) { return units[x].cards[0].rank - units[y].cards[0].rank; });
      return list;
    }
    function junkPairs(maxRank) {
      var list = [];
      for (var u = 0; u < units.length; u++) {
        if (units[u].kind === 'pair' && units[u].cards[0].rank <= maxRank) list.push(u);
      }
      list.sort(function (x, y) { return units[x].cards[0].rank - units[y].cards[0].rank; });
      return list;
    }

    var consumed = {};
    for (var ui = 0; ui < units.length; ui++) {
      var u = units[ui];
      if (u.kind !== 'triple' && u.kind !== 'plane') continue;
      var need = u.kind === 'triple' ? 1 : u.cards.length / 3;
      // 只带单张 或 只带对子，二者不可混用
      var js = junkSingles(13).filter(function (i) { return !consumed[i]; });
      if (js.length >= need) {
        for (var a = 0; a < need; a++) {
          consumed[js[a]] = true;
          u.cards = u.cards.concat(units[js[a]].cards);
        }
        continue;
      }
      var jp = junkPairs(13).filter(function (i) { return !consumed[i]; });
      if (jp.length >= need) {
        for (var b = 0; b < need; b++) {
          consumed[jp[b]] = true;
          u.cards = u.cards.concat(units[jp[b]].cards);
        }
      }
    }
    var out = [];
    for (var oi = 0; oi < units.length; oi++) if (!consumed[oi]) out.push(units[oi]);
    return out;
  }

  /** 手牌强度分（叫分用） */
  function handStrength(hand) {
    var cnt = C.counts(hand);
    var score = 0;
    score += cnt[17] * 9 + cnt[16] * 7;
    score += cnt[15] * 3.5 + cnt[14] * 2 + cnt[13] * 1.1;
    for (var r = 3; r <= 15; r++) if (cnt[r] === 4) score += 8;
    if (cnt[17] && cnt[16]) score += 6;
    var units = decompose(hand);
    score += Math.max(0, 10 - units.length) * 1.2;
    return score;
  }

  /** 自由出牌时的候选（按“先小后大、炸弹靠后”） */
  function leadOptions(hand) {
    var units = decompose(hand);
    var plays = [];
    for (var i = 0; i < units.length; i++) plays.push(units[i].cards);
    return sortPlays(dedupe(plays));
  }

  var api = {
    TYPE_NAMES: TYPE_NAMES,
    MAX_CHAIN: MAX_CHAIN,
    analyze: analyze,
    canBeat: canBeat,
    isBombType: isBombType,
    findBeats: findBeats,
    decompose: decompose,
    leadOptions: leadOptions,
    handStrength: handStrength,
    sortPlays: sortPlays,
    dedupe: dedupe,
    sig: sig,
    makeCtx: makeCtx
  };

  global.DDZ = global.DDZ || {};
  global.DDZ.rules = api;
  if (isNode) module.exports = api;

})(typeof window !== 'undefined' ? window : globalThis);
