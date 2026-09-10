/*!
 * 用 GitHub REST API 推送仓库并开启 GitHub Pages (tools/deploy-gh.js)
 *   $env:GH_TOKEN = (gh auth token); node tools/deploy-gh.js
 *
 * 之所以不用 git push：本机沙箱禁止命名管道，git 无法启动 ssh/凭据助手；
 * 而 Node 自带 OpenSSL 的 HTTPS 可以正常访问 api.github.com。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var https = require('https');

var TOKEN = process.env.GH_TOKEN;
var REPO = process.env.GH_REPO || 'wh12334/doudizhu';
var BRANCH = process.env.GH_BRANCH || 'main';
var ROOT = path.resolve(__dirname, '..');
var LOGFILE = path.join(__dirname, '_deploy.log');
var MESSAGE = process.env.GH_MESSAGE ||
  '斗地主单机网页版：1 真人 + 2 电脑，参考图角色形象，Web Audio 音乐与牌型音效';

try { fs.writeFileSync(LOGFILE, ''); } catch (e) { }
function log(line) {
  var s = String(line);
  process.stdout.write(s + '\n');
  try { fs.appendFileSync(LOGFILE, s + '\n'); } catch (e) { }
}
function done(code) {
  try { fs.appendFileSync(LOGFILE, '\n[exit ' + code + ']\n'); } catch (e) { }
  process.exit(code);      // 日志已同步落盘，可以立即退出，避免残留 socket
}

if (!TOKEN) {
  log('缺少 GH_TOKEN（用 gh auth token 获取）');
  done(2);
}

/* 排除规则：以下划线开头的目录/文件（_cp/_shots/_tmp/_chrome 等）与所有日志都不上传 */
function isSkipped(rel, name) {
  if (!rel) return false;                                   // 根目录本身
  if (name === '.git' || name === 'node_modules') return true;
  if (name.charAt(0) === '_') return true;
  if (/\.log$/i.test(name)) return true;
  return false;
}

function walk(dir, rel, out) {
  var entries = fs.readdirSync(dir, { withFileTypes: true });
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var r = rel ? rel + '/' + e.name : e.name;
    if (isSkipped(r, e.name)) continue;
    if (e.isDirectory()) walk(path.join(dir, e.name), r, out);
    else out.push(r);
  }
  return out;
}

/* 带重试的 GitHub API 调用（网络偶发 ECONNRESET，需要退避重试） */
function apiOnce(method, url, body) {
  return new Promise(function (resolve, reject) {
    var data = body ? JSON.stringify(body) : null;
    var headers = {
      'user-agent': 'dsh-deploy',
      'authorization': 'Bearer ' + TOKEN,
      'accept': 'application/vnd.github+json',
      'content-type': 'application/json'
    };
    if (data) headers['content-length'] = Buffer.byteLength(data);
    var req = https.request({
      host: 'api.github.com', path: url, method: method, headers: headers, agent: false
    }, function (res) {
      var b = '';
      res.on('data', function (d) { b += d; });
      res.on('end', function () {
        var j = null;
        try { j = JSON.parse(b); } catch (e) { }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(j);
        else {
          var err = new Error(method + ' ' + url + ' -> ' + res.statusCode + ' ' +
            (j && j.message ? j.message : b.slice(0, 200)));
          err.status = res.statusCode;
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(45000, function () { req.destroy(new Error('timeout ' + method + ' ' + url)); });
    if (data) req.write(data);
    req.end();
  });
}

function api(method, url, body) {
  var attempt = 0;
  function run() {
    attempt++;
    return apiOnce(method, url, body).catch(function (e) {
      var retryable = !e.status || e.status >= 500 || e.status === 429;
      if (retryable && attempt < 5) {
        log('    retry ' + attempt + '/4 ' + method + ' ' + url.split('/').pop() + ' (' + e.message + ')');
        return new Promise(function (r) { setTimeout(r, 1200 * attempt); }).then(run);
      }
      throw e;
    });
  }
  return run();
}

function walk(dir, rel, out) {
  var entries = fs.readdirSync(dir, { withFileTypes: true });
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var r = rel ? rel + '/' + e.name : e.name;
    if (isSkipped(r, e.name)) continue;
    if (e.isDirectory()) walk(path.join(dir, e.name), r, out);
    else out.push(r);
  }
  return out;
}

(async function () {
  var files = walk(ROOT, '', []);
  log('待上传文件 ' + files.length + ' 个:');
  files.forEach(function (f) { log('  ' + f); });

  // 0) 空仓库必须先有一个提交，Git Data API 才可用
  var headSha = null;
  try {
    var ref = await api('GET', '/repos/' + REPO + '/git/ref/heads/' + BRANCH);
    headSha = ref.object.sha;
    log('现有分支 ' + BRANCH + ' -> ' + headSha);
  } catch (e) {
    headSha = null;
  }
  if (!headSha) {
    var seed = await api('PUT', '/repos/' + REPO + '/contents/README.md', {
      message: 'init',
      content: Buffer.from('# 斗地主\n', 'utf8').toString('base64'),
      branch: BRANCH
    });
    headSha = seed.commit.sha;
    log('初始化首个提交 ' + headSha);
  }

  // 1) blobs
  var tree = [];
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    var buf = fs.readFileSync(path.join(ROOT, f));
    var isText = /\.(html|css|js|md|ps1|json|txt)$/i.test(f) || f === '.nojekyll' || f === '.gitignore';
    var blob;
    if (isText && buf.length === 0) {
      blob = await api('POST', '/repos/' + REPO + '/git/blobs', { content: '', encoding: 'utf-8' });
    } else {
      blob = await api('POST', '/repos/' + REPO + '/git/blobs',
        { content: buf.toString('base64'), encoding: 'base64' });
    }
    tree.push({ path: f, mode: '100644', type: 'blob', sha: blob.sha });
    log('  blob ' + f + ' -> ' + blob.sha.slice(0, 8) + '  (' + (buf.length / 1024).toFixed(1) + ' KB)');
  }

  // 2) tree
  var treeRes = await api('POST', '/repos/' + REPO + '/git/trees', { tree: tree });
  log('tree ' + treeRes.sha);

  // 3) commit（GH_ORPHAN=1 时创建无父提交，用于清掉历史里误传的文件）
  var orphan = process.env.GH_ORPHAN === '1';
  var commit = await api('POST', '/repos/' + REPO + '/git/commits',
    { message: MESSAGE, tree: treeRes.sha, parents: orphan ? [] : (headSha ? [headSha] : []) });
  log('commit ' + commit.sha + (orphan ? ' (orphan / 重置历史)' : ''));

  // 4) ref
  var refExists = null;
  try { refExists = await api('GET', '/repos/' + REPO + '/git/ref/heads/' + BRANCH); } catch (e) { }
  if (refExists) {
    await api('PATCH', '/repos/' + REPO + '/git/refs/heads/' + BRANCH, { sha: commit.sha, force: true });
    log('updated ref heads/' + BRANCH + ' -> ' + commit.sha);
  } else {
    await api('POST', '/repos/' + REPO + '/git/refs', { ref: 'refs/heads/' + BRANCH, sha: commit.sha });
    log('created ref heads/' + BRANCH);
  }

  // 5) GitHub Pages
  var pages = null;
  try {
    pages = await api('POST', '/repos/' + REPO + '/pages',
      { source: { branch: BRANCH, path: '/' }, build_type: 'legacy' });
    log('pages enabled');
  } catch (e) {
    if (e.status === 409) {
      log('pages 已存在，改为更新配置');
      pages = await api('PUT', '/repos/' + REPO + '/pages',
        { source: { branch: BRANCH, path: '/' }, build_type: 'legacy' });
    } else {
      throw e;
    }
  }

  // 6) 等构建完成
  var url = (pages && pages.html_url) || ('https://' + REPO.split('/')[0].toLowerCase() + '.github.io/' +
    REPO.split('/')[1] + '/');
  log('pages url: ' + url);
  for (var t = 0; t < 30; t++) {
    await new Promise(function (r) { setTimeout(r, 6000); });
    try {
      var info = await api('GET', '/repos/' + REPO + '/pages');
      log('  build status: ' + (info.status || '?') + (info.html_url ? '  ' + info.html_url : ''));
      if (info.status === 'built') break;
    } catch (e) { log('  poll: ' + e.message); }
  }

  // 7) 真实验证线上页面
  for (var k = 0; k < 20; k++) {
    await new Promise(function (r) { setTimeout(r, 6000); });
    try {
      var html = await new Promise(function (res, rej) {
        https.get(url + '?t=' + Date.now(), function (x) {
          var b = '';
          x.on('data', function (d) { b += d; });
          x.on('end', function () { res({ code: x.statusCode, body: b }); });
        }).on('error', rej);
      });
      if (html.code === 200 && /斗地主/.test(html.body)) {
        log('\nLIVE OK ' + url + '  (' + html.body.length + ' bytes)');
        // 顺便验证 js/css 也能取到
        for (var a = 0; a < 3; a++) {
          var assetPath = ['js/ui.js', 'js/audio.js', 'css/style.css'][a];
          var st = await new Promise(function (res) {
            https.get(url + assetPath, function (x) { x.resume(); res(x.statusCode); }).on('error', function () { res(0); });
          });
          log('  asset ' + assetPath + ' -> HTTP ' + st);
        }
        done(0);
      }
      log('  waiting for pages... HTTP ' + html.code);
    } catch (e) { log('  waiting: ' + e.message); }
  }
  log('页面暂时还没生效，稍后再访问 ' + url);
  done(1);
})().catch(function (e) {
  log('部署失败: ' + (e && e.message || e));
  done(1);
});
