/*
 * Adaptador da Jornada CPSI para hospedagem própria do órgão.
 *
 * A página foi escrita para rodar no Claude, que oferece window.claude.use(nome)
 * com as capacidades "db", "user", "sample" (IA) e "downloads". Este arquivo
 * recria a mesma interface sobre a infraestrutura do órgão, sem alterar a página.
 *
 * Configuração (antes de carregar este arquivo):
 *   window.JORNADA_CONFIG = {
 *     backend: 'rest',            // 'rest' (produção) ou 'local' (demonstração no navegador)
 *     apiBase: '/api',            // prefixo da API do órgão
 *     pollMs: 5000,               // intervalo de atualização das listas compartilhadas
 *     gestor: { orgao: '...', encarregado: '...', contato: '...' },
 *     metas: { edital: 120 }      // opcional: ajusta metas dos KPIs
 *   };
 *
 * Contrato da API REST esperado: ver API.md.
 */
(function () {
  'use strict';
  var CFG = Object.assign({ backend: 'rest', apiBase: '/api', pollMs: 5000 }, window.JORNADA_CONFIG || {});
  window.JORNADA_CONFIG = CFG;

  function err(code, message) { var e = new Error(message || code); e.code = code; return e; }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function parentOf(path) { var s = path.split('/'); s.pop(); return s.join('/'); }
  function lastOf(path) { var s = path.split('/'); return s[s.length - 1]; }
  function checkDoc(path) { if (typeof path !== 'string' || path.split('/').length % 2 !== 0) throw new TypeError('Caminho de documento inválido: ' + path); }
  function checkCol(path) { if (typeof path !== 'string' || path.split('/').length % 2 !== 1) throw new TypeError('Caminho de coleção inválido: ' + path); }
  function deepMerge(a, b) {
    var out = Object.assign({}, a || {});
    Object.keys(b || {}).forEach(function (k) {
      var v = b[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = deepMerge(out[k], v);
      else out[k] = v;
    });
    return out;
  }
  /* HTTP 402: recurso fora do plano atual. Erro com code 'plan_required' e o campo `recurso` ('processos', 'ia'...). */
  function planError(r) {
    return r.json().catch(function () { return {}; }).then(function (b) {
      var e = err('plan_required', 'Recurso disponível em outro plano.');
      e.recurso = (b && b.recurso) || null; e.plano = (b && b.plano) || null; e.limite = b && b.limite != null ? b.limite : null;
      throw e;
    });
  }
  function docSnap(path, data, pending) {
    var frozen = data == null ? undefined : clone(data);
    return { id: lastOf(path), exists: data != null, data: function () { return clone(frozen); }, metadata: { fromCache: false, hasPendingWrites: !!pending } };
  }

  /* ---------------- Armazenamento: local (demonstração) ---------------- */
  function LocalStore() {
    var KEY = 'jornada-cpsi-local-db';
    var mem = {};
    try { mem = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { mem = {}; }
    function persist() { try { localStorage.setItem(KEY, JSON.stringify(mem)); } catch (e) {} }
    return {
      getDoc: function (path) { return Promise.resolve(mem[path] == null ? null : clone(mem[path])); },
      setDoc: function (path, data, merge) {
        if (merge && mem[path] == null) return Promise.reject(err('invalid_argument', 'Documento não existe'));
        mem[path] = merge ? deepMerge(mem[path], data) : clone(data); persist(); return Promise.resolve();
      },
      deleteDoc: function (path) { delete mem[path]; persist(); return Promise.resolve(); },
      listCol: function (col) {
        return Promise.resolve(Object.keys(mem).filter(function (p) { return parentOf(p) === col; }).sort().map(function (p) { return { id: lastOf(p), data: clone(mem[p]) }; }));
      }
    };
  }

  /* ---------------- Armazenamento: REST (produção) ---------------- */
  function RestStore() {
    var base = CFG.apiBase.replace(/\/$/, '');
    function call(method, url, body) {
      var h = { 'X-Requested-With': 'jornada' };
      if (body) h['Content-Type'] = 'application/json';
      return fetch(base + url, {
        method: method, credentials: 'same-origin', headers: h,
        body: body ? JSON.stringify(body) : undefined
      }).then(function (r) {
        if (r.status === 401) throw err('not_granted', CFG.planos ? 'Sessão expirada. Entre novamente com o Google.' : 'Sessão expirada. Entre novamente com gov.br.');
        if (r.status === 402) return planError(r);
        if (r.status === 403 || r.status === 400 || r.status === 404 && method !== 'GET') throw err('invalid_argument', 'Operação não permitida.');
        if (r.status === 413 || r.status === 507) throw err('quota_exceeded', 'Limite de armazenamento atingido.');
        if (r.status >= 500) throw err('unavailable', 'Serviço indisponível.');
        return r.status === 204 ? null : r.json();
      }, function () { throw err('unavailable', 'Sem conexão com o servidor.'); });
    }
    var q = function (p) { return '?path=' + encodeURIComponent(p); };
    return {
      getDoc: function (path) { return call('GET', '/db/doc' + q(path)).then(function (r) { return r && r.exists ? r.data : null; }); },
      setDoc: function (path, data, merge) { return call('PUT', '/db/doc', { path: path, data: data, merge: !!merge }).then(function () {}); },
      deleteDoc: function (path) { return call('DELETE', '/db/doc' + q(path)).then(function () {}); },
      listCol: function (col) { return call('GET', '/db/collection' + q(col)).then(function (r) { return (r && r.docs) || []; }); },
      me: function () { return call('GET', '/me'); },
      profiles: function (ids) { return call('POST', '/profiles', { ids: ids }); }
    };
  }

  var store = CFG.backend === 'local' ? LocalStore() : RestStore();

  /* ---------------- Assinaturas (onSnapshot) ---------------- */
  var docSubs = {}, colSubs = {};
  function notifyDoc(path) {
    (docSubs[path] || []).forEach(function (s) { s.refresh(); });
    (colSubs[parentOf(path)] || []).forEach(function (s) { s.refresh(); });
  }
  function subscribe(map, key, refresh) {
    var sub = { refresh: refresh, timer: null, dead: false };
    (map[key] = map[key] || []).push(sub);
    sub.timer = setInterval(function () { if (!document.hidden) refresh(); }, CFG.pollMs);
    setTimeout(refresh, 0);
    return function () { sub.dead = true; clearInterval(sub.timer); map[key] = (map[key] || []).filter(function (x) { return x !== sub; }); };
  }

  function docRef(path) {
    checkDoc(path);
    return {
      id: lastOf(path), path: path,
      get: function () { return store.getDoc(path).then(function (d) { return docSnap(path, d); }); },
      set: function (data) { return store.setDoc(path, data, false).then(function () { notifyDoc(path); }); },
      update: function (data) { return store.setDoc(path, data, true).then(function () { notifyDoc(path); }); },
      delete: function () { return store.deleteDoc(path).then(function () { notifyDoc(path); }); },
      acquire: function () { return Promise.resolve({ acquired: true }); },
      collection: function (sub) { return colRef(path + '/' + sub); },
      onSnapshot: function (next, onErr) {
        var last;
        return subscribe(docSubs, path, function () {
          store.getDoc(path).then(function (d) {
            var key = JSON.stringify(d);
            if (key === last) return; last = key;
            next(docSnap(path, d));
          }, function (e) { if (onErr && e.code !== 'unavailable') onErr(e); });
        });
      }
    };
  }
  function colRef(path) {
    checkCol(path);
    var filters = [], order = null, lim = null;
    function apply(list) {
      var out = list.filter(function (d) {
        return filters.every(function (f) {
          var v = d.data[f[0]];
          switch (f[1]) { case '==': return v === f[2]; case '!=': return v !== f[2]; case '<': return v < f[2]; case '<=': return v <= f[2];
            case '>': return v > f[2]; case '>=': return v >= f[2]; case 'in': return f[2].indexOf(v) >= 0; case 'not-in': return f[2].indexOf(v) < 0;
            case 'array-contains': return Array.isArray(v) && v.indexOf(f[2]) >= 0; default: return true; }
        });
      });
      if (order) out.sort(function (a, b) { var x = a.data[order[0]], y = b.data[order[0]]; var c = x === y ? 0 : x > y ? 1 : -1; return order[1] === 'desc' ? -c : c; });
      return lim ? out.slice(0, lim) : out;
    }
    function qsnap(list, prev) {
      var docs = list.map(function (d) { return docSnap(path + '/' + d.id, d.data); });
      var prevIds = prev || {};
      var changes = [];
      list.forEach(function (d, i) {
        var k = JSON.stringify(d.data);
        if (!(d.id in prevIds)) changes.push({ type: 'added', doc: docs[i], oldIndex: -1, newIndex: i });
        else if (prevIds[d.id] !== k) changes.push({ type: 'modified', doc: docs[i], oldIndex: i, newIndex: i });
      });
      Object.keys(prevIds).forEach(function (id) { if (!list.some(function (d) { return d.id === id; })) changes.push({ type: 'removed', doc: docSnap(path + '/' + id, {}), oldIndex: 0, newIndex: -1 }); });
      return { docs: docs, size: docs.length, empty: !docs.length, docChanges: function () { return changes; }, metadata: { fromCache: false, hasPendingWrites: false } };
    }
    var api = {
      path: path,
      doc: function (id) { return docRef(path + '/' + (id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)))); },
      add: function (data) { var r = api.doc(); return r.set(data).then(function () { return r; }); },
      where: function (f, op, v) { return api._wrap(filters.concat([[f, op, v]]), order, lim); },
      orderBy: function (f, dir) { return api._wrap(filters, [f, dir || 'asc'], lim); },
      limit: function (n) { return api._wrap(filters, order, n); },
      _wrap: function (f, o, l) { var c = colRef(path); c._set(f, o, l); return c; },
      _set: function (f, o, l) { filters = f; order = o; lim = l; },
      get: function () { return store.listCol(path).then(function (l) { return qsnap(apply(l), null); }); },
      onSnapshot: function (next, onErr) {
        var prev = null;
        return subscribe(colSubs, path, function () {
          store.listCol(path).then(function (l) {
            var list = apply(l), map = {};
            list.forEach(function (d) { map[d.id] = JSON.stringify(d.data); });
            if (prev && JSON.stringify(map) === JSON.stringify(prev)) return;
            var s = qsnap(list, prev); prev = map; next(s);
          }, function (e) { if (onErr && e.code !== 'unavailable') onErr(e); });
        });
      }
    };
    return api;
  }
  var db = { doc: docRef, collection: colRef };

  /* ---------------- Usuário ---------------- */
  var mePromise = CFG.backend === 'local'
    ? Promise.resolve({ id: 'u_local', name: 'Você', isOwner: false, canWrite: true })
    : store.me().catch(function () { return null; });
  var user = {
    id: function () { return mePromise.then(function (m) { return m ? m.id : null; }); },
    me: function () { return mePromise.then(function (m) { return m ? { id: m.id, name: m.name || '', email: m.email || null, isOwner: !!m.isOwner, canEdit: !!m.isOwner } : { id: null, name: '', email: null, isOwner: false, canEdit: false }; }); },
    name: function () { return mePromise.then(function (m) { return (m && m.name) || ''; }); },
    isOwner: function () { return mePromise.then(function (m) { return !!(m && m.isOwner); }); },
    canEdit: function () { return mePromise.then(function (m) { return !!(m && m.isOwner); }); },
    can: function () { return mePromise.then(function (m) { return m ? m.canWrite !== false : false; }); },
    profiles: function (ids) {
      if (CFG.backend === 'local') return mePromise.then(function (m) { var o = {}; ids.forEach(function (i) { o[i] = { id: i, name: i === m.id ? m.name : '' }; }); return o; });
      return store.profiles(ids).catch(function () { return {}; });
    },
    avatarUrl: function () { return Promise.resolve(null); },
    email: function () { return mePromise.then(function (m) { return (m && m.email) || null; }); },
    search: function () { return Promise.resolve([]); }
  };

  /* ---------------- IA (copiloto) ---------------- */
  function sample(input, opts) {
    opts = opts || {};
    if (CFG.backend === 'local') return Promise.reject(err('not_granted', 'Copiloto desativado na demonstração local.'));
    var body = typeof input === 'string' ? { messages: [{ role: 'user', content: input }] } : { messages: input };
    return fetch(CFG.apiBase.replace(/\/$/, '') + '/ia', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'jornada' },
      body: JSON.stringify(body), signal: opts.signal
    }).then(function (r) {
      if (r.status === 402) return planError(r);
      if (r.status === 429) throw err('rate_limited', 'Muitas solicitações.');
      if (r.status === 401 || r.status === 403) throw err('not_granted', 'Copiloto não autorizado.');
      if (!r.ok || !r.body) throw err('unavailable', 'Copiloto indisponível.');
      var reader = r.body.getReader(), dec = new TextDecoder(), text = '';
      function pump() {
        return reader.read().then(function (x) {
          if (x.done) return { text: text, truncated: false };
          var delta = dec.decode(x.value, { stream: true });
          if (delta) { text += delta; if (opts.onText) try { opts.onText({ text: text, delta: delta }); } catch (e) {} }
          return pump();
        });
      }
      return pump();
    }).catch(function (e) {
      if (e && e.name === 'AbortError') { var c = err('cancelled', 'Interrompido.'); throw c; }
      throw e;
    });
  }
  sample.json = function (input, opts) {
    return sample(input, opts).then(function (r) {
      var t = r.text.trim(), m = t.match(/```(?:json)?\s*([\s\S]*?)```/);
      var s = m ? m[1] : t.slice(Math.min(t.indexOf('{') >= 0 ? t.indexOf('{') : Infinity, t.indexOf('[') >= 0 ? t.indexOf('[') : Infinity));
      try { return JSON.parse(s); } catch (e) { var x = err('invalid_json', 'Resposta não é JSON.'); x.text = r.text; throw x; }
    });
  };
  sample.limits = function () { return Promise.resolve({ maxInputBytes: 262144 }); };

  /* ---------------- Downloads ---------------- */
  var downloads = {
    save: function (req) {
      var blob = req.data instanceof Blob ? req.data : new Blob([req.data]);
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = req.filename; a.hidden = true;
      document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      return Promise.resolve({ status: 'saved' });
    }
  };

  /* ---------------- Conta, planos e assinatura (só versão hospedada) ----------------
     Funções finas que devolvem o JSON da API; rejeitam com { status, body } fora de 2xx. */
  function api(method, url, body) {
    var h = { 'X-Requested-With': 'jornada' };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    return fetch(CFG.apiBase.replace(/\/$/, '') + url, {
      method: method, credentials: 'same-origin', headers: h,
      body: body !== undefined ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.text().then(function (t) {
        var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { j = t; }
        if (!r.ok) throw { status: r.status, body: j };
        return j;
      });
    }, function () { throw { status: 0, body: { erro: 'Sem conexão com o servidor.' } }; });
  }
  window.JORNADA_API = {
    me: function () { return api('GET', '/me'); },
    plans: function () { return api('GET', '/billing/plans'); },
    loginGoogle: function (credential) { return api('POST', '/auth/google', { credential: credential }).then(function (m) { mePromise = Promise.resolve(m); return m; }); },
    logout: function () { return api('POST', '/auth/logout', {}).then(function (r) { mePromise = Promise.resolve(null); return r; }); },
    checkout: function (plano, periodo) { return api('POST', '/billing/checkout', { plano: plano, periodo: periodo === 'ano' ? 'ano' : 'mês' }); },
    cancel: function () { return api('POST', '/billing/cancel', {}); },
    proposta: function (dados) { return api('POST', '/orgao/proposta', dados || {}); },
    adminResumo: function () { return api('GET', '/admin/resumo'); },
    adminPlano: function (dados) { return api('POST', '/admin/plano', dados || {}); },
    alertasPreferencias: function () { return api('GET', '/alertas/preferencias'); },
    salvarAlertas: function (p) { return api('POST', '/alertas/preferencias', p || {}); },
    alertasEditais: function (limite) { return api('GET', '/alertas/editais' + (limite ? '?limite=' + encodeURIComponent(limite) : '')); },
    adminRodarAlertas: function (dados) { return api('POST', '/admin/alertas/rodar', dados || {}); }
  };

  var NS = { db: db, user: user, sample: sample, downloads: downloads };
  window.claude = {
    use: function (name) { return Promise.resolve(NS[name] || null); }
  };
})();
