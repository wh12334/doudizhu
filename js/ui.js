/*!
 * 斗地主 · 单机版  (js/ui.js)
 * 负责：渲染、交互、倒计时、音效/语音、动画
 * 规则与状态机在 rules.js / game.js 中，本文件不实现游戏规则
 */
(function () {
  'use strict';

  var C = window.DDZ.cards;
  var R = window.DDZ.rules;
  var AI = window.DDZ.ai;
  var Game = window.DDZ.Game;

  /* 音频模块可能尚未就绪（例如单独打开时），统一做空实现保护 */
  var Au = window.DDZAudio || {};
  var noop = function () { };
  Au.init = Au.init || noop;
  Au.unlock = Au.unlock || noop;
  Au.sfx = Au.sfx || noop;
  Au.playBgm = Au.playBgm || noop;
  Au.stopBgm = Au.stopBgm || noop;
  Au.speak = Au.speak || noop;
  Au.setBgmEnabled = Au.setBgmEnabled || noop;
  Au.setSfxEnabled = Au.setSfxEnabled || noop;
  Au.setBgmVolume = Au.setBgmVolume || noop;
  Au.setSfxVolume = Au.setSfxVolume || noop;

  /* ================= DOM ================= */
  var E = {};
  var IDS = ['table', 'seat0', 'seat1', 'seat2', 'av0', 'av1', 'av2', 'cnt1', 'cnt2',
    'tag0', 'tag1', 'tag2', 'role0', 'role1', 'role2', 'timer0', 'timer1', 'timer2',
    'bubble0', 'bubble1', 'bubble2', 'play0', 'play1', 'play2', 'myHand', 'bcRow',
    'statBase', 'statMult', 'statScore', 'centerHint', 'banner', 'flash', 'toast',
    'actPlay', 'actBid', 'actOver', 'btnPass', 'btnHint', 'btnPlay', 'btnAgain',
    'startScreen', 'btnStart', 'modal', 'btnHelp', 'modalClose', 'result', 'resTitle',
    'resSub', 'resTags', 'resScore', 'btnResultAgain', 'btnMusic', 'btnSound',
    'btnVoice', 'btnClear', 'btnSortTip', 'cardProbe'];
  IDS.forEach(function (id) { E[id] = document.getElementById(id); });

  var SEAT = {
    0: { seat: 'seat0', av: 'av0', tag: 'tag0', role: 'role0', bubble: 'bubble0', play: 'play0', cnt: null },
    1: { seat: 'seat1', av: 'av1', tag: 'tag1', role: 'role1', bubble: 'bubble1', play: 'play1', cnt: 'cnt1' },
    2: { seat: 'seat2', av: 'av2', tag: 'tag2', role: 'role2', bubble: 'bubble2', play: 'play2', cnt: 'cnt2' }
  };
  var AVA_LANDLORD = 'assets/avatars/landlord.png';
  var AVA_FARMERS = ['assets/avatars/farmer1.png', 'assets/avatars/farmer2.png'];

  /* ================= 状态 ================= */
  var g = null;
  var selected = {};             // id -> card
  var handSig = '';
  var sortDesc = true;
  var hintList = [], hintIdx = -1;
  var turnTimer = null, turnLeft = 0, turnMax = 20, lastWholeTick = 99, taunted = false;
  var aiTimer = null;
  var soundOn = { bgm: true, sfx: true, voice: true };
  var started = false;
  var lastPlaySig = '';

  /* ================= 工具 ================= */
  function rnd(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  function cardHTML(card, opts) {
    opts = opts || {};
    var cls = 'card';
    if (card.rank >= 16) cls += ' joker' + (card.rank === 17 ? ' red' : ' dark');
    else if (card.suit === 'H' || card.suit === 'D') cls += ' red';
    if (opts.selected) cls += ' selected';
    if (opts.extra) cls += ' ' + opts.extra;
    if (opts.back) cls += ' back';
    var style = opts.style ? ' style="' + opts.style + '"' : '';
    if (opts.back) return '<div class="' + cls + '"' + style + '></div>';

    if (card.rank >= 16) {
      var big = card.rank === 17;
      return '<div class="' + cls + '" data-id="' + card.id + '"' + style + '>' +
        '<div class="corner"><span class="r">' + (big ? '大' : '小') + '</span>' +
        '<span class="s">王</span></div>' +
        '<div class="jk">JOKER</div><div class="star">' + (big ? '\u2605' : '\u2606') + '</div></div>';
    }
    var sym = C.suitSymbol(card.suit);
    return '<div class="' + cls + '" data-id="' + card.id + '"' + style + '>' +
      '<div class="corner"><span class="r">' + C.label(card.rank) + '</span>' +
      '<span class="s">' + sym + '</span></div>' +
      '<div class="pip">' + sym + '</div></div>';
  }

  function cardWidth() {
    if (E.cardProbe && E.cardProbe.offsetWidth) return E.cardProbe.offsetWidth;
    return 70;
  }

  function sig(cards) {
    return cards.map(function (c) { return c.id; }).sort().join(',');
  }

  function bubble(p, text, ms) {
    var box = E[SEAT[p].bubble];
    if (!box) return;
    box.textContent = text;
    box.classList.add('show');
    clearTimeout(box._t);
    box._t = setTimeout(function () { box.classList.remove('show'); }, ms || 1800);
  }

  function toast(msg, ms) {
    E.toast.textContent = msg;
    E.toast.classList.add('show');
    clearTimeout(E.toast._t);
    E.toast._t = setTimeout(function () { E.toast.classList.remove('show'); }, ms || 1600);
  }

  function banner(text, kind, ms) {
    var b = E.banner;
    b.className = 'banner' + (kind ? ' ' + kind : '');
    b.textContent = text;
    void b.offsetWidth;               // 重启动画
    b.classList.add('show');
    clearTimeout(b._t);
    b._t = setTimeout(function () { b.classList.remove('show'); }, ms || 1350);
  }

  function centerHint(text, ms) {
    E.centerHint.textContent = text;
    E.centerHint.classList.add('show');
    clearTimeout(E.centerHint._t);
    if (text) E.centerHint._t = setTimeout(function () { E.centerHint.classList.remove('show'); }, ms || 2000);
  }

  function flashScreen() {
    var f = E.flash;
    f.classList.remove('show');
    void f.offsetWidth;
    f.classList.add('show');
  }

  function shakeTable() {
    var t = E.table;
    t.classList.remove('shake');
    void t.offsetWidth;
    t.classList.add('shake');
  }

  function sound(name, opts) {
    if (!soundOn.sfx) return;
    try { Au.sfx(name, opts || {}); } catch (e) { }
  }

  function say(p, text) {
    bubble(p, text);
    if (soundOn.voice && p !== 0) {
      try { Au.speak(text); } catch (e) { }
    }
  }

  /* ================= 渲染 ================= */
  function renderBottom(reveal) {
    var html = '';
    for (var i = 0; i < 3; i++) {
      html += cardHTML(g.bottom[i], { back: !reveal, extra: reveal ? 'flip' : '' });
    }
    E.bcRow.innerHTML = html;
  }

  function renderStats() {
    E.statBase.textContent = g.phase === 'bid' || g.phase === 'idle' ? '–' : g.baseScore;
    var m = g.multiplier;
    E.statMult.textContent = g.landlord == null ? '–' : (m + '×');
    E.statMult.parentNode.classList.toggle('hot', m > 1);
    E.statScore.textContent = g.scores[0] > 0 ? '+' + g.scores[0] : String(g.scores[0]);
  }

  function renderSeats() {
    for (var i = 0; i < 3; i++) {
      var s = SEAT[i], pl = g.players[i];
      var seatEl = E[s.seat];
      seatEl.classList.toggle('active', g.phase !== 'over' && g.current === i);
      seatEl.classList.toggle('is-landlord', pl.role === 'landlord');
      if (s.cnt) {
        E[s.cnt].textContent = pl.hand.length;
        E[s.cnt].classList.toggle('warn', pl.hand.length > 0 && pl.hand.length <= 2);
      }
      var tag = E[s.tag];
      if (pl.role) {
        tag.textContent = pl.role === 'landlord' ? '地主' : '农民';
        tag.classList.toggle('landlord', pl.role === 'landlord');
      } else {
        tag.textContent = '等待叫分';
        tag.classList.remove('landlord');
      }
      var rb = E[s.role];
      if (rb && !rb.dataset.done && pl.role) {
        rb.textContent = pl.role === 'landlord' ? '地 主' : '农 民';
        rb.classList.add('show');
        rb.dataset.done = '1';
      }
    }
  }

  function sortHand(cards) {
    return sortDesc ? C.sortDesc(cards) : C.sortAsc(cards);
  }

  function renderHand(animate) {
    var cards = sortHand(g.players[0].hand);
    var n = cards.length;
    var el = E.myHand;
    if (!n) { el.innerHTML = ''; handSig = ''; return; }

    var cw = cardWidth();
    var avail = el.clientWidth || el.parentNode.clientWidth || 800;
    var step = n > 1 ? Math.min(cw * 0.66, (avail - cw - 8) / (n - 1)) : 0;
    if (step < 6) step = 6;
    var totalW = cw + step * (n - 1);
    var left0 = Math.max(0, (avail - totalW) / 2);

    var html = '';
    for (var i = 0; i < n; i++) {
      var c = cards[i];
      html += cardHTML(c, {
        selected: !!selected[c.id],
        style: 'left:' + (left0 + i * step).toFixed(1) + 'px;z-index:' + (i + 1) + ';',
        extra: animate ? 'deal' : ''
      });
    }
    el.innerHTML = html;
    if (animate) {
      var nodes = el.querySelectorAll('.card');
      for (var k = 0; k < nodes.length; k++) {
        nodes[k].style.animationDelay = (k * 26) + 'ms';
      }
    }
    handSig = sig(cards);
    updateSelectionUI();
  }

  function renderHandIfChanged(animate) {
    var s = sig(g.players[0].hand);
    if (s !== handSig) renderHand(animate);
  }

  function updateSelectionUI() {
    var nodes = E.myHand.querySelectorAll('.card');
    for (var i = 0; i < nodes.length; i++) {
      var id = nodes[i].getAttribute('data-id');
      nodes[i].classList.toggle('selected', !!selected[id]);
    }
    E.myHand.querySelectorAll('.card.hintable').forEach(function (el) {
      el.classList.remove('hintable');
    });
    var isMyTurn = g.phase === 'play' && g.current === 0;
    E.btnPlay.disabled = !isMyTurn || !Object.keys(selected).length;
  }

  function clearSelection() {
    selected = {};
    hintList = []; hintIdx = -1;
    updateSelectionUI();
  }

  function selectedCards() {
    var out = [];
    for (var id in selected) if (selected.hasOwnProperty(id)) out.push(selected[id]);
    return C.sortDesc(out);
  }

  function renderPlay(p, cards, pattern) {
    var box = E[SEAT[p].play];
    var html = '';
    for (var i = 0; i < cards.length; i++) {
      html += cardHTML(cards[i], { style: 'animation-delay:' + (i * 30) + 'ms' });
    }
    var tag = '<span class="type-tag' + (R.isBombType(pattern) ? ' bomb' : '') + '">' +
      (pattern ? pattern.name : '') + '</span>';
    if (p === 1) box.innerHTML = tag + html;      // 右侧玩家的标签靠中间
    else box.innerHTML = html + tag;
  }

  function renderPass(p) {
    E[SEAT[p].play].innerHTML = '<span class="pass-pill">不出</span>';
  }

  function clearPlays() {
    E.play0.innerHTML = '';
    E.play1.innerHTML = '';
    E.play2.innerHTML = '';
  }

  function renderActions() {
    var bid = g.phase === 'bid' && g.current === 0;
    var play = g.phase === 'play' && g.current === 0;
    var over = g.phase === 'over';
    E.actBid.classList.toggle('hide', !bid);
    E.actPlay.classList.toggle('hide', !play);
    E.actOver.classList.toggle('hide', !over);

    if (bid) {
      var btns = E.actBid.querySelectorAll('[data-bid]');
      for (var i = 0; i < btns.length; i++) {
        var v = parseInt(btns[i].getAttribute('data-bid'), 10);
        btns[i].disabled = v !== 0 && v <= g.currentBid;
      }
    }
    if (play) {
      var mustPlay = !g.lastPlay || g.lastPlay.player === 0;
      E.btnPass.disabled = mustPlay;
      E.btnPass.textContent = mustPlay ? '请出牌' : '不出';
      E.btnPlay.disabled = !Object.keys(selected).length;
    }
  }

  function render() {
    renderStats();
    renderSeats();
    renderHandIfChanged(false);
    renderActions();
  }

  /* ================= 头像与身份 ================= */
  function assignAvatars() {
    var fi = 0;
    for (var i = 0; i < 3; i++) {
      var img = E[SEAT[i].av];
      if (i === g.landlord) img.src = AVA_LANDLORD;
      else img.src = AVA_FARMERS[fi++ % AVA_FARMERS.length];
    }
  }

  function resetRoleBadges() {
    for (var i = 0; i < 3; i++) {
      var rb = E[SEAT[i].role];
      if (rb) { rb.classList.remove('show'); delete rb.dataset.done; }
      E[SEAT[i].seat].classList.remove('win', 'lose', 'counting');
    }
  }

  /* ================= 倒计时 ================= */
  function clearTurnTimer() {
    if (turnTimer) { clearInterval(turnTimer); turnTimer = null; }
    for (var i = 0; i < 3; i++) {
      E[SEAT[i].seat].classList.remove('counting');
      E['timer' + i].classList.remove('low');
    }
  }

  function updateTimerUI() {
    var pct = Math.max(0, Math.min(100, (turnLeft / turnMax) * 100));
    var seatEl = E['seat' + g.current];
    var tm = E['timer' + g.current];
    if (seatEl) seatEl.style.setProperty('--p', pct.toFixed(1));
    if (tm) tm.classList.toggle('low', turnLeft <= 5);
  }

  function startCountdown(sec) {
    clearTurnTimer();
    turnMax = sec; turnLeft = sec; lastWholeTick = 99; taunted = false;
    E['seat' + g.current].classList.add('counting');
    updateTimerUI();
    turnTimer = setInterval(function () {
      turnLeft -= 0.1;
      if (turnLeft <= 0) {
        turnLeft = 0;
        updateTimerUI();
        clearTurnTimer();
        autoAction();
        return;
      }
      updateTimerUI();
      var whole = Math.ceil(turnLeft);
      if (whole !== lastWholeTick && whole <= 5) {
        lastWholeTick = whole;
        sound(whole <= 3 ? 'warn' : 'tick');
      }
      if (!taunted && turnLeft <= turnMax - 9 && Math.random() < 0.5) {
        taunted = true;
        var others = [1, 2];
        var who = rnd(others);
        say(who, rnd(['快点啊，我等的花儿都谢了', '你快点嘛～', '别磨蹭啦']));
      }
    }, 100);
  }

  function autoAction() {
    if (g.phase === 'bid') { doBid(0); return; }
    if (g.phase === 'play') {
      if (g.lastPlay && g.lastPlay.player !== 0) { doPass(); return; }
      var list = AI.hints(g.players[0].hand, null);
      if (list.length) doPlay(list[0]);
      else doPass();
    }
  }

  /* ================= 玩家操作 ================= */
  function doBid(score) {
    if (g.phase !== 'bid' || g.current !== 0) return;
    clearTurnTimer();
    g.bid(0, score);
    tick();
  }

  function doPlay(cards) {
    if (g.phase !== 'play' || g.current !== 0) return false;
    var v = g.validate(0, cards);
    if (!v.ok) { toast(v.reason); sound('nobid'); return false; }
    clearTurnTimer();
    clearSelection();
    g.play(0, cards);
    tick();
    return true;
  }

  function doPass() {
    if (g.phase !== 'play' || g.current !== 0) return;
    if (!g.lastPlay || g.lastPlay.player === 0) { toast('你是先手，必须出牌'); return; }
    clearTurnTimer();
    clearSelection();
    g.pass(0);
    tick();
  }

  function doHint() {
    var isMyTurn = g.phase === 'play' && g.current === 0;
    if (!isMyTurn) return;
    var pat = (g.lastPlay && g.lastPlay.player !== 0) ? g.lastPlay.pattern : null;
    if (hintIdx < 0 || !hintList.length) {
      hintList = AI.hints(g.players[0].hand, pat);
      hintIdx = -1;
    }
    if (!hintList.length) { toast('没有能管上的牌，只能不出'); sound('nobid'); return; }
    hintIdx = (hintIdx + 1) % hintList.length;
    var cards = hintList[hintIdx];
    selected = {};
    cards.forEach(function (c) { selected[c.id] = c; });
    sound('hint');
    renderHandIfChanged(false);
    updateSelectionUI();
    var p = R.analyze(cards);
    centerHint('提示：' + p.name);
  }

  /* ================= 主循环 ================= */
  function tick() {
    if (!started) return;
    clearTurnTimer();
    if (aiTimer) { clearTimeout(aiTimer); aiTimer = null; }
    render();
    if (g.phase === 'over') return;

    if (g.isAiTurn()) {
      aiTimer = setTimeout(function () {
        aiTimer = null;
        g.step();
        tick();
      }, 780 + Math.random() * 620);
    } else {
      renderActions();
      startCountdown(g.phase === 'bid' ? 15 : 20);
    }
  }

  /* ================= 事件绑定 ================= */
  function bindGame() {
    g.on('deal', function () {
      clearPlays();
      resetRoleBadges();
      selected = {}; handSig = '';
      E.bcRow.innerHTML = '';
      renderBottom(false);
      sound('deal');
      banner('发 牌', 'green', 900);
      centerHint('叫分抢地主', 1600);
    });

    g.on('bid', function (p, score) {
      if (score > 0) {
        sound('bid', { power: score });
        say(p, rnd(['叫' + score + '分！', score + '分，我要了', '我' + score + '分'])) ;
      } else {
        sound('nobid');
        say(p, rnd(['不叫', '不要', '过']) );
      }
    });

    g.on('redeal', function () { centerHint('无人叫地主，重新发牌'); });

    g.on('landlord', function (p) {
      assignAvatars();
      renderBottom(true);
      sound('landlord');
      var name = g.players[p].name;
      banner(p === 0 ? '你是地主！' : name + ' 是地主', '');
      if (p === 0) {
        bubble(0, '我是地主，先出牌！');
      } else {
        say(p, rnd(['我是地主！', '地主是我的了', '看我的']));
        centerHint('地主先出牌', 1500);
      }
    });

    g.on('play', function (p, cards, pattern, multChanged) {
      renderPlay(p, cards, pattern);
      sound(pattern.type, { n: cards.length, power: pattern.size >= 6 ? 1 : 0.7 });

      if (pattern.type === 'bomb') {
        banner('炸 弹 !', '', 1200); flashScreen(); shakeTable();
        say(p, rnd(['炸弹！', '炸死你！', '哈哈，炸弹！']));
      } else if (pattern.type === 'rocket') {
        banner('王 炸 !', '', 1300); flashScreen(); shakeTable();
        setTimeout(shakeTable, 160);
        say(p, rnd(['王炸！', '双王在手，天下我有！']));
      } else if (multChanged) {
        centerHint('倍数 ×' + g.multiplier);
      }

      if (g.players[p].hand.length === 1) {
        say(p, rnd(['我只剩一张了！', '就一张啦，小心点']));
      } else if (g.players[p].hand.length === 2) {
        say(p, rnd(['还剩两张', '我快走完了']));
      }
      updateSelectionUI();
    });

    g.on('pass', function (p) {
      renderPass(p);
      sound('pass');
      say(p, rnd(['不出', '要不起', '过']));
    });

    g.on('free', function (p) {
      clearPlays();
      if (p === 0) centerHint('其他人都不要，你继续出牌', 1600);
      else centerHint(g.players[p].name + ' 获得出牌权', 1400);
    });

    g.on('invalid', function (p, reason) { toast(reason); });

    g.on('over', function (res) { showResult(res); });

    g.on('update', function () {
      renderStats();
      renderSeats();
      renderHandIfChanged(false);
      renderActions();
    });
  }

  function showResult(res) {
    clearTurnTimer();
    var myWin = res.myWin;
    var iAmLandlord = g.players[0].role === 'landlord';

    sound(myWin ? 'win' : 'lose');
    if (res.spring) { setTimeout(function () { banner('春 天 !', 'green', 1500); sound('spring'); }, 250); }
    if (res.antiSpring) { setTimeout(function () { banner('反 春 天 !', 'blue', 1500); sound('anti_spring'); }, 250); }

    // 座位表情
    for (var i = 0; i < 3; i++) {
      var won = (g.players[i].role === 'landlord') === res.landlordWon;
      E[SEAT[i].seat].classList.add(won ? 'win' : 'lose');
      E[SEAT[i].seat].classList.remove(won ? 'lose' : 'win');
    }

    E.result.classList.remove('hide');
    E.resTitle.textContent = myWin ? '胜 利' : '失 败';
    E.resTitle.classList.toggle('lose', !myWin);
    E.resSub.textContent = '你是' + (iAmLandlord ? '地主' : '农民') + ' · ' +
      (res.landlordWon ? '地主获胜' : '农民获胜');

    var tags = [];
    tags.push('<span class="rtag">底分 ' + res.baseScore + '</span>');
    tags.push('<span class="rtag' + (res.multiplier > 1 ? ' red' : '') + '">倍数 ×' + res.multiplier + '</span>');
    if (g.bombCount) tags.push('<span class="rtag red">炸弹/王炸 ' + g.bombCount + '</span>');
    if (res.spring) tags.push('<span class="rtag red">春天 ×2</span>');
    if (res.antiSpring) tags.push('<span class="rtag red">反春天 ×2</span>');
    E.resTags.innerHTML = tags.join('');

    var lines = [];
    for (var k = 0; k < 3; k++) {
      var d = res.delta[k];
      lines.push('<div>' + g.players[k].name + '：<b class="' + (d >= 0 ? 'up' : 'down') + '">' +
        (d > 0 ? '+' : '') + d + '</b> <span style="opacity:.55">(总 ' +
        g.scores[k] + ')</span></div>');
    }
    lines.push('<div style="margin-top:8px;font-size:13px;opacity:.75">本局得分 = 底分 ' +
      res.baseScore + ' × 倍数 ' + res.multiplier + '</div>');
    E.resScore.innerHTML = lines.join('');

    setTimeout(function () {
      say(0, myWin ? rnd(['哈哈，我赢了！', '承让承让～', '这局稳了']) : rnd(['哎，又输了…', '再来一局！', '手气不好']));
    }, 500);
  }

  /* ================= 新的一局 ================= */
  function newRound() {
    E.result.classList.add('hide');
    clearPlays();
    clearSelection();
    clearTurnTimer();
    if (aiTimer) { clearTimeout(aiTimer); aiTimer = null; }
    g.newRound();
    renderBottom(false);
    resetRoleBadges();
    // 未定地主前，用默认形象
    E.av0.src = AVA_LANDLORD;
    E.av1.src = AVA_FARMERS[0];
    E.av2.src = AVA_FARMERS[1];
    renderHand(false);
    tick();
  }

  /* ================= 开始 ================= */
  function boot() {
    Au.init();

    // 音效按钮状态
    function paintTools() {
      E.btnMusic.classList.toggle('off', !soundOn.bgm);
      E.btnSound.classList.toggle('off', !soundOn.sfx);
      E.btnVoice.classList.toggle('off', !soundOn.voice);
    }
    E.btnMusic.onclick = function () {
      soundOn.bgm = !soundOn.bgm;
      Au.setBgmEnabled(soundOn.bgm);
      Au.playBgm(soundOn.bgm ? 'game' : null);
      paintTools();
    };
    E.btnSound.onclick = function () {
      soundOn.sfx = !soundOn.sfx;
      Au.setSfxEnabled(soundOn.sfx);
      paintTools();
    };
    E.btnVoice.onclick = function () {
      soundOn.voice = !soundOn.voice;
      if (Au.setSpeakEnabled) Au.setSpeakEnabled(soundOn.voice);
      paintTools();
    };
    paintTools();

    E.btnHelp.onclick = function () { E.modal.classList.remove('hide'); };
    E.modalClose.onclick = function () { E.modal.classList.add('hide'); };
    E.modal.onclick = function (ev) { if (ev.target === E.modal) E.modal.classList.add('hide'); };

    E.btnStart.onclick = function () {
      E.startScreen.classList.add('hide');
      Au.unlock();
      Au.playBgm('game');
      startGame();
    };

    E.myHand.addEventListener('click', function (ev) {
      var el = ev.target.closest ? ev.target.closest('.card') : null;
      if (!el || g.phase !== 'play' || g.current !== 0) return;
      var id = el.getAttribute('data-id');
      var card = null;
      g.players[0].hand.forEach(function (c) { if (c.id === id) card = c; });
      if (!card) return;
      if (selected[id]) delete selected[id];
      else selected[id] = card;
      sound('select');
      el.classList.toggle('selected', !!selected[id]);
      E.btnPlay.disabled = !Object.keys(selected).length;
    });

    E.btnPlay.onclick = function () { doPlay(selectedCards()); };
    E.btnPass.onclick = doPass;
    E.btnHint.onclick = doHint;
    E.btnClear.onclick = function () { clearSelection(); sound('click'); };
    E.btnSortTip.onclick = function () {
      sortDesc = !sortDesc;
      E.btnSortTip.textContent = '排序：' + (sortDesc ? '大→小' : '小→大');
      renderHand(false);
      sound('click');
    };
    E.btnAgain.onclick = newRound;
    E.btnResultAgain.onclick = newRound;

    Array.prototype.forEach.call(E.actBid.querySelectorAll('[data-bid]'), function (b) {
      b.onclick = function () { doBid(parseInt(b.getAttribute('data-bid'), 10)); };
    });

    window.addEventListener('resize', function () {
      if (started) renderHand(false);
    });
    window.addEventListener('keydown', function (ev) {
      if (ev.code === 'Space') { ev.preventDefault(); doHint(); }
      if (ev.code === 'Enter') { ev.preventDefault(); if (!E.btnPlay.disabled) doPlay(selectedCards()); }
      if (ev.code === 'Escape') { clearSelection(); }
    });
  }

  function startGame() {
    started = true;
    g = new Game();
    g.players[0].name = '你';
    bindGame();
    renderBottom(false);
    renderHand(false);
    E.av0.src = AVA_LANDLORD;
    E.av1.src = AVA_FARMERS[0];
    E.av2.src = AVA_FARMERS[1];
    // 首局做个发牌动画
    setTimeout(function () { renderHand(true); }, 120);
    tick();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.DDZUIRefresh = function () { if (g) render(); };

  /* 调试/自动化测试钩子（供 tools/verify-ui.js 使用） */
  window.DDZDebug = {
    game: function () { return g; },
    snapshot: function () {
      if (!g) return null;
      return {
        phase: g.phase,
        current: g.current,
        landlord: g.landlord,
        counts: g.players.map(function (p) { return p.hand.length; }),
        myHand: g.players[0].hand.map(function (c) { return C.label(c.rank) + c.suit; }),
        myRole: g.players[0].role,
        bottom: g.bottom.map(function (c) { return C.label(c.rank); }),
        baseScore: g.baseScore,
        multiplier: g.multiplier,
        bombCount: g.bombCount,
        lastPlayer: g.lastPlay ? g.lastPlay.player : null,
        lastType: g.lastPlay ? g.lastPlay.pattern.type : null,
        roundNo: g.roundNo,
        result: g.result
      };
    },
    audio: function () {
      var o = { ready: !!Au.ready, hasSfx: typeof Au.sfx === 'function' };
      if (typeof Au.debugInfo === 'function') { try { o.info = Au.debugInfo(); } catch (e) { } }
      return o;
    },
    /* 强制摆出一个指定牌型并打出（仅用于截图验证） */
    force: function (labels, type) {
      if (!g) return 'no game';
      var cards = labels.map(function (l, i) {
        var rank = l === 'w' ? 16 : l === 'W' ? 17 : (l === 'A' ? 14 : l === 'K' ? 13 : l === 'Q' ? 12 :
          l === 'J' ? 11 : parseInt(l, 10));
        var suits = ['S', 'H', 'C', 'D'];
        return { id: 'forced' + i + '_' + Math.random().toString(36).slice(2), rank: rank, suit: rank >= 16 ? 'J' : suits[i % 4] };
      });
      g.phase = 'play';
      g.current = 0;
      g.lastPlay = null;
      g.passCount = 0;
      g.players[0].hand = cards.concat(g.players[0].hand);
      var ok = g.play(0, cards);
      return ok ? 'played ' + type : 'play failed';
    }
  };
})();
