export const DEBUG_PAGE_SCRIPT = String.raw`
(function () {
  'use strict';

  var state = {
    token: localStorage.getItem('paboot.debug.token') || '',
    config: null,
    runs: [],
    memorySessions: [],
    selectedRun: null,
    detail: null,
    memory: [],
    payload: null,
    follow: true,
    stream: null,
    streamConnected: false,
    pollTimer: null,
    reconnectTimer: null,
  };

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function fmtTime(ts) {
    if (!ts) return '-';
    return new Date(ts).toLocaleTimeString();
  }

  function fmtBytes(n) {
    if (n === null || n === undefined) return '-';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  function fill(node, children) {
    node.textContent = '';
    for (var i = 0; i < children.length; i++) node.appendChild(children[i]);
    return node;
  }

  function api(path) {
    return fetch(path, { headers: { Authorization: 'Bearer ' + state.token } }).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          var err = new Error(body.error || (res.status + ' ' + res.statusText));
          err.status = res.status;
          err.code = body.code;
          throw err;
        });
      }
      return res.json();
    });
  }

  function showError(err) {
    var box = $('error');
    if (!err) { box.textContent = ''; return; }
    var text = err.message || String(err);
    if (err.status === 401) text = 'token 无效或已轮换（401）';
    if (err.code === 'operator_required') text = '需要 operator token（agent token 不能访问调试接口）';
    box.textContent = text;
  }

  function renderHeader() {
    var capture = $('capture');
    if (!state.config) { capture.textContent = 'capture ?'; capture.className = 'badge'; return; }
    var c = state.config.capture;
    var active = c.mode === 'on' || (c.mode === 'auto' && state.streamConnected);
    var label;
    if (c.mode === 'off') label = 'capture off';
    else if (c.mode === 'on') label = 'capture on (always)';
    else label = active ? 'capture on (debug attached)' : 'capture idle (auto)';
    capture.textContent = label + '  max ' + fmtBytes(c.maxBytes) +
      ' / total ' + fmtBytes(c.maxTotalBytes) + ' / keep ' + c.keepMinutes + 'm';
    capture.className = 'badge ' + (active ? 'on' : (c.mode === 'off' ? 'off' : ''));
  }

  function statusDot(status) {
    var cls = 'dot';
    if (status === 'running') cls += ' running';
    else if (status === 'failed') cls += ' failed';
    else if (status === 'cancelled') cls += ' cancelled';
    return el('span', cls);
  }

  function renderRuns() {
    var list = $('runs');
    if (state.runs.length === 0) {
      var message = '当前没有运行的会话';
      if (!state.token) message = '填写 operator token 后开始接收调试数据';
      else if (state.config && state.config.capture.mode === 'off') message = '采集已关闭（PABOOT_DEBUG=off）';
      else if (!state.streamConnected) message = '正在连接调试流…';
      fill(list, [el('div', 'empty', message)]);
      return;
    }
    var nodes = state.runs.map(function (run) {
      var item = el('div', 'item' + (run.runId === state.selectedRun ? ' active' : ''));
      var title = el('div', 'title', run.sessionTitle || run.sessionId);
      var meta = el('div', 'meta');
      meta.appendChild(statusDot(run.status));
      meta.appendChild(el('span', null, run.runtime));
      meta.appendChild(el('span', null, run.model || '-'));
      meta.appendChild(el('span', null, fmtTime(run.startedAt)));
      if (run.captured === false) meta.appendChild(el('span', 'err', '未采集'));
      else meta.appendChild(el('span', null, run.snapshotCount + ' snapshot(s)'));
      item.appendChild(title);
      item.appendChild(meta);
      var meta2 = el('div', 'meta');
      if (run.workspaceName) meta2.appendChild(el('span', null, run.workspaceName));
      if (run.endedAt) meta2.appendChild(el('span', null, 'ended ' + fmtTime(run.endedAt)));
      if (run.error) meta2.appendChild(el('span', 'err', run.error));
      item.appendChild(meta2);
      item.addEventListener('click', function () { selectRun(run.runId); });
      return item;
    });
    fill(list, nodes);
  }

  function renderMemorySessions() {
    var list = $('memory-list');
    if (state.memorySessions.length === 0) {
      fill(list, [el('div', 'empty', '暂无后台记忆提取')]);
      return;
    }
    fill(list, state.memorySessions.map(function (entry) {
      var selected = state.detail && state.detail.memoryOnly && state.detail.sessionId === entry.sessionId;
      var item = el('div', 'item' + (selected ? ' active' : ''));
      item.appendChild(el('div', 'title', entry.sessionTitle || entry.sessionId));
      var meta = el('div', 'meta');
      meta.appendChild(el('span', null, entry.count + ' call(s)'));
      meta.appendChild(el('span', null, fmtTime(entry.lastCreatedAt)));
      item.appendChild(meta);
      item.addEventListener('click', function () {
        selectSessionMemory(entry.sessionId, entry.sessionTitle);
      });
      return item;
    }));
  }

  function snapshotRow(snapshot) {
    var item = el('div', 'item' + (state.payload && state.payload.snapshot.id === snapshot.id ? ' active' : ''));
    var title = el('div', 'title');
    title.appendChild(el('span', 'pill', snapshot.kind));
    if (snapshot.step !== null && snapshot.step !== undefined) {
      title.appendChild(el('span', 'muted', ' step ' + snapshot.step));
    }
    var meta = el('div', 'meta');
    meta.appendChild(el('span', null, (snapshot.provider || '-') + ':' + (snapshot.model || '-')));
    meta.appendChild(el('span', null, fmtBytes(snapshot.bytes)));
    if (snapshot.truncated) meta.appendChild(el('span', 'err', 'truncated'));
    meta.appendChild(el('span', null, fmtTime(snapshot.createdAt)));
    item.appendChild(title);
    item.appendChild(meta);
    item.addEventListener('click', function () { loadSnapshot(snapshot.id); });
    return item;
  }

  function kv(rows) {
    var box = el('div', 'kv');
    rows.forEach(function (row) {
      box.appendChild(el('div', 'k', row[0]));
      var value = el('div', 'v');
      if (row[1] instanceof Node) value.appendChild(row[1]);
      else value.textContent = row[1] === undefined || row[1] === null ? '-' : String(row[1]);
      box.appendChild(value);
    });
    return box;
  }

  function preBlock(title, value, open) {
    var details = el('details');
    if (open) details.open = true;
    details.appendChild(el('summary', null, title));
    var text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    details.appendChild(el('pre', null, text === undefined ? 'null' : text));
    return details;
  }

  function renderDetail() {
    var box = $('detail');
    if (!state.detail) {
      fill(box, [el('div', 'empty', '选择左侧的运行或记忆条目查看 paboot 注入的上下文')]);
      return;
    }
    if (state.detail.uncaptured) {
      var uncapturedChildren = [];
      uncapturedChildren.push(el('h3', null, (state.detail.sessionTitle || state.detail.sessionId) + '  /  ' + (state.detail.sessionId || '').slice(0, 8)));
      uncapturedChildren.push(kv([
        ['status', state.detail.status],
        ['runtime', state.detail.runtime],
        ['model', state.detail.model || '-'],
        ['started', fmtTime(state.detail.startedAt)],
      ]));
      uncapturedChildren.push(el('div', 'empty',
        '该 run 在调试页面连接前（或采集开启前）已经启动，paboot 没有记录到它的注入上下文。' +
        'Claude / Codex / DeepSeek 每轮只在开始时注入一次，下一轮开始前保持本页面打开即可；' +
        'builtin 会从下一步模型调用开始出现在这里。'));
      fill(box, uncapturedChildren);
      return;
    }
    if (state.detail.memoryOnly) {
      var memoryChildren = [];
      memoryChildren.push(el('h3', null, '记忆提取 · ' + (state.detail.sessionTitle || state.detail.sessionId)));
      memoryChildren.push(el('div', 'muted', '后台 memory worker 的模型调用（system / user / 响应 / usage / 错误 / 重试）'));
      if (state.memory.length === 0) memoryChildren.push(el('div', 'empty', '暂无记录'));
      else memoryChildren.push(fill(el('div'), state.memory.map(snapshotRow)));
      if (state.payload) memoryChildren.push(renderPayload(state.payload));
      fill(box, memoryChildren);
      return;
    }
    var run = state.detail;
    var children = [];
    var title = el('h3', null, (run.sessionTitle || run.sessionId) + '  /  ' + run.runId.slice(0, 8));
    children.push(title);
    children.push(kv([
      ['status', run.status],
      ['runtime', run.runtime],
      ['model', run.model || '-'],
      ['workspace', run.workspaceName || run.workspaceId || '-'],
      ['started', fmtTime(run.startedAt) + '  (' + Math.max(0, Math.round(((run.endedAt || Date.now()) - run.startedAt) / 1000)) + 's)'],
      ['error', run.error || '-'],
    ]));

    children.push(el('h3', null, '快照'));
    var snapshots = [];
    if (run.injection) snapshots.push(run.injection);
    for (var i = 0; i < run.steps.length; i++) snapshots.push(run.steps[i]);
    if (snapshots.length === 0) children.push(el('div', 'empty', '暂无快照'));
    else children.push(fill(el('div'), snapshots.map(snapshotRow)));

    if (state.memory.length > 0) {
      children.push(el('h3', null, '记忆提取调用'));
      children.push(fill(el('div'), state.memory.map(snapshotRow)));
    }

    if (state.payload) children.push(renderPayload(state.payload));

    fill(box, children);
  }

  function renderPayload(data) {
    var snapshot = data.snapshot;
    var payload = data.payload || {};
    var box = el('div');
    box.appendChild(el('h3', null, '快照 #' + snapshot.id + '  ' + snapshot.kind));
    var kind = snapshot.kind;

    if (kind === 'run-injection') {
      box.appendChild(kv([
        ['injectionMode', payload.injectionMode],
        ['resumed', String(payload.resumeNativeSession)],
        ['model', payload.model || '-'],
        ['modelParameters', JSON.stringify(payload.modelParameters)],
        ['permissionMode', payload.permissionMode],
        ['extraDirs', (payload.extraDirs || []).join(', ') || '-'],
      ]));
      if (payload.toolServers) box.appendChild(preBlock('tool servers', payload.toolServers, false));
      box.appendChild(preBlock('prompt (raw)', payload.prompt || '', false));
      box.appendChild(preBlock('prompt sent', payload.promptSent || '', false));
      if (payload.systemContext) box.appendChild(preBlock('systemContext', payload.systemContext, true));
      if (payload.merged) {
        var mergedTitle = 'merged prelude';
        if (payload.memory && payload.merged.prefix === payload.memory.prefix) {
          mergedTitle = 'merged prelude（= memory brief，本轮无 knowledge / recall）';
        } else if (payload.knowledge && payload.merged.prefix === payload.knowledge.prefix) {
          mergedTitle = 'merged prelude（= knowledge，本轮无 memory / recall）';
        }
        box.appendChild(preBlock(mergedTitle, payload.merged.prefix, false));
      }
      if (payload.knowledge) box.appendChild(preBlock('knowledge', payload.knowledge.prefix, false));
      if (payload.memory) box.appendChild(preBlock('memory brief', payload.memory.prefix, true));
      if (payload.recall) box.appendChild(preBlock('memory recall', payload.recall.prefix, true));
      if (payload.recall) {
        box.appendChild(preBlock('recall meta', {
          query: payload.recall.query,
          terms: payload.recall.terms,
          hits: payload.recall.hits,
          droppedCount: payload.recall.droppedCount,
          dropped: payload.recall.dropped,
        }, false));
      }
      if (payload.memory) {
        box.appendChild(preBlock('brief meta', {
          claims: payload.memory.claims,
          truncated: payload.memory.truncated,
          usedClaimIds: payload.memory.usedClaimIds,
        }, false));
      }
      box.appendChild(preBlock('raw JSON', payload, false));
      return box;
    }

    if (kind === 'builtin-step') {
      box.appendChild(kv([
        ['step', payload.step],
        ['provider', payload.provider + ':' + payload.model],
        ['maxTokens', payload.maxTokens],
        ['estimatedTokens', payload.estimatedTokens],
        ['systemVersion', payload.systemVersion],
        ['contextVersion', payload.contextVersion],
        ['overBudget', 'system=' + payload.systemOverBudget + ' runtime=' + payload.runtimeContext.overBudget],
      ]));
      box.appendChild(preBlock('system', payload.system || '', true));
      box.appendChild(preBlock('runtime context', payload.runtimeContext.text || '', true));
      box.appendChild(preBlock('messages', payload.messages, false));
      box.appendChild(preBlock('tools', payload.tools, false));
      if (payload.wireBody) box.appendChild(preBlock('wire body', payload.wireBody, false));
      box.appendChild(preBlock('raw JSON', payload, false));
      return box;
    }

    box.appendChild(kv([
      ['batchKey', payload.batchKey],
      ['attempt', payload.attempt + ' / ' + payload.maxAttempts],
      ['provider', payload.provider + ':' + payload.model],
      ['scope', payload.scope],
      ['duration', payload.durationMs + 'ms'],
      ['deterministic', String(payload.deterministic)],
      ['willRetry', String(payload.willRetry)],
      ['error', payload.error || '-'],
    ]));
    box.appendChild(preBlock('system', payload.system || '', false));
    box.appendChild(preBlock('user', payload.user || '', true));
    box.appendChild(preBlock('response', payload.response || (payload.error ? 'ERROR: ' + payload.error : ''), true));
    if (payload.usage) box.appendChild(preBlock('usage', payload.usage, false));
    if (payload.failureState) box.appendChild(preBlock('failure state', payload.failureState, false));
    box.appendChild(preBlock('raw JSON', payload, false));
    return box;
  }

  function loadConfig() {
    return api('/api/debug/config').then(function (data) {
      state.config = data;
      renderHeader();
    }).catch(showError);
  }

  function loadLive() {
    if (!state.token) return Promise.resolve();
    return api('/api/debug/live').then(function (data) {
      showError(null);
      state.runs = data.runs || [];
      state.memorySessions = data.memory || [];
      renderMemorySessions();
      if (!state.selectedRun && !(state.detail && state.detail.memoryOnly)) {
        var running = state.runs.find(function (run) { return run.status === 'running'; });
        if (running) { selectRun(running.runId); return; }
      }
      if (state.selectedRun && !state.runs.some(function (run) { return run.runId === state.selectedRun; }) && !state.detail) {
        state.selectedRun = null;
      }
      renderRuns();
    }).catch(showError);
  }

  function uncapturedDetail(summary) {
    return {
      uncaptured: true,
      sessionId: summary.sessionId,
      sessionTitle: summary.sessionTitle || null,
      status: summary.status,
      runtime: summary.runtime,
      model: summary.model || null,
      workspaceId: summary.workspaceId || null,
      workspaceName: summary.workspaceName || null,
      startedAt: summary.startedAt,
      endedAt: null,
      error: null,
      injection: null,
      steps: [],
    };
  }

  function selectRun(runId) {
    var summary = state.runs.find(function (run) { return run.runId === runId; });
    state.selectedRun = runId;
    state.memory = [];
    state.payload = null;
    if (summary && summary.captured === false) {
      state.detail = uncapturedDetail(summary);
      renderRuns();
      renderMemorySessions();
      renderDetail();
      return;
    }
    state.detail = null;
    renderRuns();
    renderMemorySessions();
    loadRun(runId);
  }

  function selectSessionMemory(sessionId, sessionTitle) {
    state.selectedRun = null;
    state.payload = null;
    state.memory = [];
    state.detail = {
      memoryOnly: true,
      sessionId: sessionId,
      sessionTitle: sessionTitle || null,
      status: 'memory',
      runtime: 'memory',
      model: null,
      workspaceId: null,
      workspaceName: null,
      startedAt: 0,
      endedAt: null,
      error: null,
      injection: null,
      steps: [],
    };
    renderRuns();
    renderMemorySessions();
    renderDetail();
    loadMemory(sessionId);
  }

  function loadRun(runId) {
    return api('/api/debug/runs/' + encodeURIComponent(runId)).then(function (data) {
      if (state.selectedRun !== runId) return;
      state.detail = data;
      renderDetail();
      loadMemory(data.sessionId);
    }).catch(function (err) {
      if (err.status === 404) {
        var summary = state.runs.find(function (run) { return run.runId === runId; });
        if (summary) {
          state.detail = uncapturedDetail(summary);
          renderDetail();
          return;
        }
      }
      showError(err);
    });
  }

  function loadMemory(sessionId) {
    if (!sessionId) return;
    api('/api/debug/sessions/' + encodeURIComponent(sessionId) + '/memory').then(function (data) {
      state.memory = data.snapshots || [];
      renderDetail();
    }).catch(function () {});
  }

  function loadSnapshot(id) {
    api('/api/debug/snapshots/' + id).then(function (data) {
      state.payload = data;
      renderDetail();
    }).catch(showError);
  }

  function setStreamStatus(connected) {
    var was = state.streamConnected;
    state.streamConnected = connected;
    var node = $('stream');
    node.textContent = connected ? 'live' : 'offline';
    node.className = 'badge ' + (connected ? 'on' : 'off');
    renderHeader();
    // Capture only starts when this stream connects (auto mode), so refresh the
    // list at that moment instead of waiting for the next run event.
    if (connected && !was && state.token) {
      loadLive();
      if (state.selectedRun) loadRun(state.selectedRun);
    }
  }

  function handleFrame(frame) {
    var lines = frame.split('\n');
    var event = 'message';
    var data = '';
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.indexOf('event:') === 0) event = line.slice(6).trim();
      else if (line.indexOf('data:') === 0) data += line.slice(5).trim();
    }
    if (event === 'ping' || !data) return;
    var msg;
    try { msg = JSON.parse(data); } catch (err) { return; }
    var selected = state.selectedRun;
    if (msg.type === 'snapshot') {
      if (selected && msg.runId === selected) loadRun(selected);
      if (state.detail && msg.sessionId && msg.sessionId === state.detail.sessionId) loadMemory(msg.sessionId);
      if (state.follow) loadLive();
      return;
    }
    if (msg.type === 'run-started' || msg.type === 'run-finished' || msg.type === 'run-removed') {
      loadLive();
      if (selected && msg.runId === selected) loadRun(selected);
    }
  }

  function scheduleReconnect() {
    if (state.reconnectTimer) return;
    setStreamStatus(false);
    state.reconnectTimer = setTimeout(function () {
      state.reconnectTimer = null;
      connectStream();
    }, 2000);
  }

  function connectStream() {
    if (state.stream) { state.stream.abort(); state.stream = null; }
    if (!state.token) return;
    var ctrl = new AbortController();
    state.stream = ctrl;
    fetch('/api/debug/stream', {
      headers: { Authorization: 'Bearer ' + state.token },
      signal: ctrl.signal,
    }).then(function (res) {
      if (!res.ok) throw new Error('stream ' + res.status);
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      setStreamStatus(true);
      function pump() {
        return reader.read().then(function (result) {
          if (result.done) { scheduleReconnect(); return; }
          buffer += decoder.decode(result.value, { stream: true });
          var idx;
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            var frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            handleFrame(frame);
          }
          return pump();
        });
      }
      return pump();
    }).catch(function (err) {
      if (err && err.name === 'AbortError') return;
      scheduleReconnect();
    });
  }

  function saveToken() {
    state.token = $('token').value.trim();
    if (state.token) localStorage.setItem('paboot.debug.token', state.token);
    else localStorage.removeItem('paboot.debug.token');
    showError(null);
    loadConfig();
    loadLive();
    connectStream();
  }

  function clearToken() {
    localStorage.removeItem('paboot.debug.token');
    state.token = '';
    $('token').value = '';
    state.runs = [];
    state.memorySessions = [];
    state.detail = null;
    state.payload = null;
    state.memory = [];
    renderRuns();
    renderMemorySessions();
    renderDetail();
    if (state.stream) { state.stream.abort(); state.stream = null; }
    setStreamStatus(false);
  }

  function init() {
    $('token').value = state.token;
    $('save').addEventListener('click', saveToken);
    $('clear').addEventListener('click', clearToken);
    $('token').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') saveToken(); });
    $('follow').addEventListener('change', function (ev) {
      state.follow = ev.target.checked;
      if (state.follow) loadLive();
    });
    $('follow').checked = state.follow;
    renderDetail();
    if (state.token) { loadConfig(); loadLive(); connectStream(); }
    // Poll as a safety net for lifecycle changes that emit no model event
    // (e.g. an in-flight run that started before capture was enabled).
    state.pollTimer = setInterval(function () {
      if (!state.token) return;
      loadLive();
      if (!state.streamConnected && state.selectedRun) loadRun(state.selectedRun);
    }, 5000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
`;
