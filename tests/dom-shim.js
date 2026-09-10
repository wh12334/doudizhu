/*!
 * 极简 DOM 实现 (tests/dom-shim.js) —— 仅覆盖本项目 ui.js 用到的浏览器 API
 * 目的：在没有浏览器的环境里真实执行 ui.js，捕捉运行期错误
 */
'use strict';

var VOID_TAGS = { meta: 1, link: 1, img: 1, br: 1, hr: 1, input: 1, source: 1 };
var RAW_TAGS = { script: 1, style: 1 };

/* 先抓住真实的计时器，避免被 window 上的缩放版覆盖后递归 */
var _setTimeout = setTimeout;
var _setInterval = setInterval;
var _clearTimeout = clearTimeout;
var _clearInterval = clearInterval;

function ClassList(el) {
  this.el = el;
}
ClassList.prototype._list = function () {
  return (this.el._class || '').split(/\s+/).filter(Boolean);
};
ClassList.prototype._set = function (arr) {
  this.el._class = arr.join(' ');
};
ClassList.prototype.contains = function (c) { return this._list().indexOf(c) >= 0; };
ClassList.prototype.add = function () {
  var a = this._list();
  for (var i = 0; i < arguments.length; i++) if (a.indexOf(arguments[i]) < 0) a.push(arguments[i]);
  this._set(a);
};
ClassList.prototype.remove = function () {
  var a = this._list();
  for (var i = 0; i < arguments.length; i++) {
    var k = a.indexOf(arguments[i]);
    if (k >= 0) a.splice(k, 1);
  }
  this._set(a);
};
ClassList.prototype.toggle = function (c, force) {
  var has = this.contains(c);
  var want = force === undefined ? !has : !!force;
  if (want && !has) this.add(c);
  if (!want && has) this.remove(c);
  return want;
};

function Style(el) {
  this.el = el;
  this._props = {};
}
Style.prototype.setProperty = function (k, v) { this._props[k] = String(v); };
Style.prototype.getPropertyValue = function (k) { return this._props[k] || ''; };
Style.prototype.removeProperty = function (k) { delete this._props[k]; };

function Element(doc, tag) {
  this.ownerDocument = doc;
  this.tagName = String(tag).toUpperCase();
  this.nodeName = this.tagName;
  this._class = '';
  this.attributes = {};
  this.children = [];
  this.parentNode = null;
  this._text = '';
  this.style = new Style(this);
  this.classList = new ClassList(this);
  this.dataset = {};
  this._listeners = {};
  this._w = null;
}
Object.defineProperty(Element.prototype, 'className', {
  get: function () { return this._class; },
  set: function (v) { this._class = String(v); }
});
Object.defineProperty(Element.prototype, 'id', {
  get: function () { return this.attributes.id || ''; },
  set: function (v) { this.attributes.id = String(v); }
});
Object.defineProperty(Element.prototype, 'src', {
  get: function () { return this.attributes.src || ''; },
  set: function (v) { this.attributes.src = String(v); }
});
Object.defineProperty(Element.prototype, 'disabled', {
  get: function () { return this.attributes.disabled === 'true'; },
  set: function (v) {
    if (v) this.attributes.disabled = 'true';
    else delete this.attributes.disabled;
  }
});
Object.defineProperty(Element.prototype, 'textContent', {
  get: function () {
    if (this.children.length) {
      return this.children.map(function (c) { return c.textContent; }).join('');
    }
    return this._text;
  },
  set: function (v) {
    this.children = [];
    this._text = v === null || v === undefined ? '' : String(v);
  }
});
Object.defineProperty(Element.prototype, 'innerHTML', {
  get: function () { return this._html || ''; },
  set: function (v) {
    this._html = String(v);
    this.children = [];
    this._text = '';
    var parsed = parseHTML(this._html, this.ownerDocument);
    for (var i = 0; i < parsed.length; i++) {
      parsed[i].parentNode = this;
      this.children.push(parsed[i]);
      if (!VOID_TAGS[parsed[i].tagName.toLowerCase()]) this.ownerDocument._index(parsed[i]);
      else this.ownerDocument._indexVoid(parsed[i]);
    }
  }
});
Object.defineProperty(Element.prototype, 'offsetWidth', {
  get: function () { return this._w != null ? this._w : (this.classList.contains('card') ? 70 : 600); }
});
Object.defineProperty(Element.prototype, 'clientWidth', {
  get: function () { return this._w != null ? this._w : (this.classList.contains('card') ? 70 : 1000); }
});
Object.defineProperty(Element.prototype, 'offsetHeight', {
  get: function () { return this._w != null ? this._w : 100; }
});

Element.prototype.getAttribute = function (k) {
  if (k === 'class') return this._class;
  if (k === 'id') return this.id;
  if (k === 'style') return this._styleText || '';
  return this.attributes[k] !== undefined ? this.attributes[k] : null;
};
Element.prototype.setAttribute = function (k, v) {
  if (k === 'class') { this._class = String(v); return; }
  if (k === 'id') { this.attributes.id = String(v); return; }
  if (k === 'style') { this._styleText = String(v); return; }
  this.attributes[k] = String(v);
};
Element.prototype.removeAttribute = function (k) { delete this.attributes[k]; };
Element.prototype.hasAttribute = function (k) { return this.attributes[k] !== undefined; };

Element.prototype.appendChild = function (c) {
  c.parentNode = this;
  this.children.push(c);
  if (c.id) this.ownerDocument._index(c);
  return c;
};
Element.prototype.addEventListener = function (type, fn) {
  (this._listeners[type] = this._listeners[type] || []).push(fn);
};
Element.prototype.removeEventListener = function (type, fn) {
  var l = this._listeners[type] || [];
  var i = l.indexOf(fn);
  if (i >= 0) l.splice(i, 1);
};
Element.prototype.dispatchEvent = function (ev) {
  ev.target = ev.target || this;
  var node = this;
  while (node) {
    var l = (node._listeners[ev.type] || []).slice();
    for (var i = 0; i < l.length; i++) l[i].call(node, ev);
    if (typeof node['on' + ev.type] === 'function') node['on' + ev.type](ev);
    if (ev._stopped) break;
    node = node.parentNode;
  }
  return true;
};
Element.prototype.click = function () {
  this.dispatchEvent({ type: 'click', target: this });
};
Element.prototype.closest = function (sel) {
  var node = this;
  while (node && node.tagName) {
    if (node.matches && node.matches(sel)) return node;
    node = node.parentNode;
  }
  return null;
};
Element.prototype.getBoundingClientRect = function () {
  return { left: 0, top: 0, right: this.offsetWidth, bottom: this.offsetHeight, width: this.offsetWidth, height: this.offsetHeight };
};
Element.prototype.matches = function (sel) {
  return matchesSelector(this, sel);
};
Element.prototype.querySelectorAll = function (sel) {
  var out = [];
  collect(this, sel, out);
  return out;
};
Element.prototype.querySelector = function (sel) {
  var r = this.querySelectorAll(sel);
  return r.length ? r[0] : null;
};
Element.prototype.contains = function (n) {
  var p = n;
  while (p) { if (p === this) return true; p = p.parentNode; }
  return false;
};
Element.prototype.scrollIntoView = function () { };
Element.prototype.focus = function () { };
Element.prototype.remove = function () {
  if (this.parentNode) {
    var i = this.parentNode.children.indexOf(this);
    if (i >= 0) this.parentNode.children.splice(i, 1);
  }
};
Element.prototype.insertBefore = function (n, ref) {
  var i = this.children.indexOf(ref);
  if (i < 0) this.children.push(n); else this.children.splice(i, 0, n);
  n.parentNode = this;
  return n;
};

/* ---------------- 选择器 ---------------- */
function parseSelector(sel) {
  return sel.trim().split(/\s+/).map(function (part) {
    var t = { tag: null, id: null, classes: [], attrs: [], nots: [] };
    var re = /([.#]?[\w-]+)|\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]|:not\(([^)]+)\)/g;
    var m;
    while ((m = re.exec(part))) {
      if (m[1]) {
        if (m[1][0] === '.') t.classes.push(m[1].slice(1));
        else if (m[1][0] === '#') t.id = m[1].slice(1);
        else t.tag = m[1].toLowerCase();
      } else if (m[2]) {
        t.attrs.push({ name: m[2], value: m[3] === undefined ? null : m[3] });
      } else if (m[4]) {
        t.nots.push(m[4]);
      }
    }
    return t;
  });
}
function matchSimple(el, t) {
  if (t.tag && el.tagName.toLowerCase() !== t.tag) return false;
  if (t.id && el.id !== t.id) return false;
  for (var i = 0; i < t.classes.length; i++) if (!el.classList.contains(t.classes[i])) return false;
  for (var j = 0; j < t.attrs.length; j++) {
    var a = t.attrs[j];
    var v = el.getAttribute(a.name);
    if (v === null) return false;
    if (a.value !== null && v !== a.value) return false;
  }
  for (var k = 0; k < t.nots.length; k++) if (el.matches(t.nots[k])) return false;
  return true;
}
function matchesSelector(el, sel) {
  var parts = parseSelector(sel);
  if (!matchSimple(el, parts[parts.length - 1])) return false;
  var i = parts.length - 2, node = el.parentNode;
  while (i >= 0) {
    var found = false;
    while (node && node.tagName) {
      if (matchSimple(node, parts[i])) { found = true; node = node.parentNode; break; }
      node = node.parentNode;
    }
    if (!found) return false;
    i--;
  }
  return true;
}
function collect(root, sel, out) {
  for (var i = 0; i < root.children.length; i++) {
    var c = root.children[i];
    if (c.tagName && matchesSelector(c, sel)) out.push(c);
    if (c.children && c.children.length) collect(c, sel, out);
  }
}

/* ---------------- HTML 解析 ---------------- */
function parseAttrs(attrStr, el) {
  var re = /([\w:-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  var m;
  while ((m = re.exec(attrStr))) {
    var name = m[1];
    var value = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : (m[5] !== undefined ? m[5] : ''));
    el.setAttribute(name, value);
    if (name.indexOf('data-') === 0) {
      var key = name.slice(5).replace(/-([a-z])/g, function (s, c) { return c.toUpperCase(); });
      el.dataset[key] = value;
    }
  }
}
function parseHTML(html, doc) {
  var root = { children: [], tagName: '#root', parentNode: null };
  var stack = [root];
  var re = /<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<\/([\w-]+)\s*>|<([\w-]+)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|([^<]+)/g;
  var m;
  while ((m = re.exec(html))) {
    if (m[0].slice(0, 4) === '<!--' || /^<!DOCTYPE/i.test(m[0])) continue;
    if (m[1]) {                                   // 闭合标签
      var tag = m[1].toLowerCase();
      for (var i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName.toLowerCase() === tag) { stack.length = i; break; }
      }
      continue;
    }
    if (m[2]) {                                   // 开始标签
      var name = m[2].toLowerCase();
      var el = new Element(doc, name);
      parseAttrs(m[3] || '', el);
      var parent = stack[stack.length - 1];
      el.parentNode = parent;
      parent.children.push(el);
      if (RAW_TAGS[name]) {
        // script/style：内容当文本，且不进入子树
        var rest = html.slice(re.lastIndex);
        var close = rest.toLowerCase().indexOf('</' + name);
        var content = close >= 0 ? rest.slice(0, close) : rest;
        el._text = content;
        re.lastIndex += content.length;
      } else if (!VOID_TAGS[name] && !m[4]) {
        stack.push(el);
      }
      continue;
    }
    if (m[5]) {                                   // 文本
      var txt = m[5];
      if (txt.trim()) {
        var p = stack[stack.length - 1];
        if (p.tagName && p.tagName !== '#root') p._text += txt;
      }
    }
  }
  return root.children;
}

/* ---------------- Document ---------------- */
function Document() {
  this.byId = {};
  this.documentElement = new Element(this, 'html');
  this.body = new Element(this, 'body');
  this.documentElement.appendChild(this.body);
  this.readyState = 'complete';
  this._listeners = {};
  this.documentElement.parentNode = this;
  this.body.parentNode = this.documentElement;
}
Document.prototype._index = function (el) {
  if (el.id) this.byId[el.id] = el;
  for (var i = 0; i < el.children.length; i++) {
    if (el.children[i].tagName) this._index(el.children[i]);
  }
};
Document.prototype._indexVoid = function (el) { if (el.id) this.byId[el.id] = el; };
Document.prototype.createElement = function (tag) { return new Element(this, tag); };
Document.prototype.createTextNode = function (t) { var e = new Element(this, '#text'); e._text = t; return e; };
Document.prototype.getElementById = function (id) { return this.byId[id] || null; };
Document.prototype.querySelector = function (sel) {
  var r = this.querySelectorAll(sel);
  return r.length ? r[0] : null;
};
Document.prototype.querySelectorAll = function (sel) {
  var out = [];
  collect(this.documentElement, sel, out);
  return out;
};
Document.prototype.addEventListener = function (t, fn) {
  (this._listeners[t] = this._listeners[t] || []).push(fn);
};
Document.prototype.dispatchEvent = function (ev) {
  var l = this._listeners[ev.type] || [];
  for (var i = 0; i < l.length; i++) l[i](ev);
  return true;
};
Document.prototype.setInnerHTML = function (html) {
  var nodes = parseHTML(html, this);
  var self = this;
  this.body.children = [];
  nodes.forEach(function (n) {
    n.parentNode = self.body;
    self.body.children.push(n);
    if (n.tagName && !VOID_TAGS[n.tagName.toLowerCase()]) self._index(n);
    else self._indexVoid(n);
  });
};

/* ---------------- window ---------------- */
function createWindow(opts) {
  opts = opts || {};
  var doc = new Document();
  var timeScale = opts.timeScale || 1;

  var win = {
    document: doc,
    location: { href: 'file:///test/index.html', search: opts.search || '', hash: '' },
    innerWidth: opts.width || 1440,
    innerHeight: opts.height || 900,
    devicePixelRatio: 1,
    navigator: { userAgent: 'node-dom-shim', language: 'zh-CN' },
    _listeners: {},
    addEventListener: function (t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    removeEventListener: function () { },
    dispatchEvent: function (ev) {
      var l = this._listeners[ev.type] || [];
      for (var i = 0; i < l.length; i++) l[i](ev);
      return true;
    },
    matchMedia: function () { return { matches: false, addListener: function () { }, addEventListener: function () { } }; },
    getComputedStyle: function () { return { getPropertyValue: function () { return ''; } }; },
    requestAnimationFrame: function (fn) { return setTimeout(function () { fn(Date.now()); }, 16); },
    cancelAnimationFrame: function (id) { clearTimeout(id); },
    localStorage: {
      _d: {},
      getItem: function (k) { return this._d[k] === undefined ? null : this._d[k]; },
      setItem: function (k, v) { this._d[k] = String(v); },
      removeItem: function (k) { delete this._d[k]; }
    },
    // 缩放计时器，让一局游戏在测试里几秒内跑完（代码路径完全一致）
    setTimeout: function (fn, ms) {
      var extra = [].slice.call(arguments, 2);
      return _setTimeout.apply(null, [fn, Math.max(1, (ms || 0) / timeScale)].concat(extra));
    },
    setInterval: function (fn, ms) { return _setInterval(fn, Math.max(1, (ms || 0) / timeScale)); },
    clearTimeout: function (id) { return _clearTimeout(id); },
    clearInterval: function (id) { return _clearInterval(id); }
  };
  win.window = win;
  win.self = win;
  win.top = win;
  win.parent = win;
  win.console = console;
  win.Date = Date;
  win.Math = Math;
  win.JSON = JSON;
  win.Object = Object;
  win.Array = Array;
  win.String = String;
  win.Number = Number;
  win.Boolean = Boolean;
  win.Error = Error;
  win.TypeError = TypeError;
  win.isNaN = isNaN;
  win.parseInt = parseInt;
  win.parseFloat = parseFloat;
  win.encodeURI = encodeURI;
  win.decodeURI = decodeURI;
  win.__setTimeout = win.setTimeout;
  win.__setInterval = win.setInterval;
  win.__clearTimeout = win.clearTimeout;
  win.__clearInterval = win.clearInterval;
  return win;
}

module.exports = {
  createWindow: createWindow,
  parseHTML: parseHTML,
  Element: Element,
  Document: Document
};
