/* pd-shim.js - runs the original Property Desk (the Claude artifact) on Supabase, unchanged.
   Same idea as the Maintenance Desk's desk-shim.js. The board asks for three things through
   window.claude.use(...): "db", "mcp" and "sample". This file gives it all three:
     db     -> the pd_docs table (live updates, same doc()/collection() calls the artifact had)
     mcp    -> Slack, Dropbox and Asana through Edge Functions (keys stay on the server)
     sample -> Claude, through the pd-sample Edge Function (key stays on the server)
   Sign-in decides who you are; the name picker is filled in and locked.
   The board's code is not in the public repo: it is read from pd_app after sign-in. */
(function(){
  "use strict";
  var C = window.PD_CONFIG || {};
  var sb = supabase.createClient(C.url, C.anonKey, { auth:{ persistSession:true, detectSessionInUrl:true, flowType:"implicit" } });
  window.PD_SB = sb;
  var T = "pd_docs";

  function dbErr(code, msg){ var e = new Error(msg || code); e.code = code; return e; }
  function mapErr(e){
    var m = (e && e.message) || String(e || "");
    if(/row-level security|permission denied/i.test(m)) return dbErr("invalid_argument", "Your login can't change this");
    if((e && e.code === "P0002") || /does not exist/i.test(m)) return dbErr("invalid_argument", m);
    return dbErr("unavailable", m);
  }
  function clone(x){ return JSON.parse(JSON.stringify(x)); }
  function split(path){
    var p = String(path || "").split("/");
    if(p.length < 2 || p.length % 2) throw new TypeError("doc path needs an even number of segments: " + path);
    return { c: p.slice(0, -1).join("/"), id: p[p.length - 1] };
  }
  var META = { fromCache:false, hasPendingWrites:false };
  function docSnap(id, data){
    return { id:id, exists:data !== undefined && data !== null, metadata:META,
             data:function(){ return data == null ? undefined : data; } };
  }
  function querySnap(map, prev){
    var ids = Object.keys(map).sort();
    var docs = ids.map(function(id){ return docSnap(id, map[id]); });
    return { docs:docs, size:docs.length, empty:!docs.length, metadata:META,
      forEach:function(f){ docs.forEach(f); },
      docChanges:function(){
        var out = [];
        docs.forEach(function(d, i){
          if(!prev || !(d.id in prev)) out.push({ type:"added", doc:d, oldIndex:-1, newIndex:i });
          else if(prev[d.id] !== map[d.id]) out.push({ type:"modified", doc:d, oldIndex:i, newIndex:i });
        });
        if(prev) Object.keys(prev).forEach(function(id){ if(!(id in map)) out.push({ type:"removed", doc:docSnap(id, prev[id]), oldIndex:-1, newIndex:-1 }); });
        return out;
      } };
  }

  async function getOne(c, id){
    var r = await sb.from(T).select("data").eq("collection", c).eq("id", id).maybeSingle();
    if(r.error) throw mapErr(r.error);
    return r.data ? r.data.data : undefined;
  }
  async function getAll(c){
    var out = {}, from = 0;
    for(;;){
      var r = await sb.from(T).select("id,data").eq("collection", c).order("id").range(from, from + 499);
      if(r.error) throw mapErr(r.error);
      (r.data || []).forEach(function(x){ out[x.id] = x.data; });
      if(!r.data || r.data.length < 500) break;
      from += 500;
    }
    return out;
  }

  /* one realtime channel for the whole table; each listener refetches what it watches */
  var watchers = [];
  function hub(){
    if(hub.on) return; hub.on = true;
    sb.channel("pd-docs").on("postgres_changes", { event:"*", schema:"public", table:T }, function(p){
      var row = (p.new && p.new.collection) ? p.new : p.old; if(!row) return;
      watchers.forEach(function(w){ if(w.c === row.collection && (w.id == null || w.id === row.id)) w.poke(row.id); });
    }).subscribe();
    // backstop: realtime can drop - catch up when the tab comes back and every few minutes
    var catchUp = function(){ watchers.forEach(function(w){ w.poke(null); }); };
    document.addEventListener("visibilitychange", function(){ if(!document.hidden) catchUp(); });
    setInterval(function(){ if(!document.hidden) catchUp(); }, 5 * 60 * 1000);
  }

  function docRef(path){
    var s = split(path);
    return {
      id: s.id, path: path,
      get: async function(){ return docSnap(s.id, await getOne(s.c, s.id)); },
      set: async function(data){
        var r = await sb.from(T).upsert({ collection:s.c, id:s.id, data:clone(data) }, { onConflict:"collection,id", returning:"minimal" });
        if(r.error) throw mapErr(r.error);
      },
      update: async function(patch){
        var r = await sb.rpc("pd_update", { p_collection:s.c, p_id:s.id, p_patch:clone(patch) });
        if(r.error) throw mapErr(r.error);
      },
      delete: async function(){ throw dbErr("invalid_argument", "Nothing is deleted on the Property Desk."); },
      acquire: async function(){ return { acquired:true }; },
      onSnapshot: function(next, onErr){
        var dead = false, busy = false, again = false, last;
        var load = async function(){
          if(busy){ again = true; return; } busy = true;
          try{ var d = await getOne(s.c, s.id); if(!dead && d !== last){ last = d; next(docSnap(s.id, d)); } }
          catch(e){ console.error(e); if(onErr && e.code !== "unavailable"){ dead = true; onErr(e); } }
          busy = false; if(again){ again = false; load(); }
        };
        var w = { c:s.c, id:s.id, poke:function(){ if(!dead) load(); } };
        watchers.push(w); hub(); load();
        return function(){ dead = true; watchers = watchers.filter(function(x){ return x !== w; }); };
      },
      collection: function(sub){ return collRef(path + "/" + sub); }
    };
  }

  function query(c, filters, order, lim){
    function apply(map){
      var ids = Object.keys(map).filter(function(id){
        var v = map[id] || {};
        return filters.every(function(f){
          var x = v[f[0]], y = f[2];
          switch(f[1]){
            case "==": return x === y;   case "!=": return x !== y;
            case "<": return x < y;      case "<=": return x <= y;
            case ">": return x > y;      case ">=": return x >= y;
            case "in": return (y || []).indexOf(x) >= 0;
            case "not-in": return (y || []).indexOf(x) < 0;
            case "array-contains": return Array.isArray(x) && x.indexOf(y) >= 0;
          } return true; });
      });
      if(order) ids.sort(function(a, b){ var x = (map[a] || {})[order[0]], y = (map[b] || {})[order[0]];
        var r = x === y ? 0 : (x === undefined ? 1 : y === undefined ? -1 : (x < y ? -1 : 1)); return order[1] === "desc" ? -r : r; });
      if(lim) ids = ids.slice(0, lim);
      var out = {}; ids.forEach(function(id){ out[id] = map[id]; }); return out;
    }
    return {
      where: function(f, op, v){ return query(c, filters.concat([[f, op, v]]), order, lim); },
      orderBy: function(f, dir){ return query(c, filters, [f, dir || "asc"], lim); },
      limit: function(n){ return query(c, filters, order, n); },
      get: async function(){ return querySnap(apply(await getAll(c))); },
      onSnapshot: function(next, onErr){
        var dead = false, cache = null, prevView = null, busy = false, again = false;
        var emit = function(){ var view = apply(cache); next(querySnap(view, prevView)); prevView = view; };
        var full = async function(){
          if(busy){ again = true; return; } busy = true;
          try{ cache = await getAll(c); if(!dead) emit(); }
          catch(e){ console.error(e); if(onErr && e.code !== "unavailable"){ dead = true; onErr(e); } }
          busy = false; if(again){ again = false; full(); }
        };
        var one = async function(id){
          try{ var d = await getOne(c, id); if(dead || !cache) return;
               cache = Object.assign({}, cache); if(d === undefined) delete cache[id]; else cache[id] = d; emit(); }
          catch(e){ console.error(e); }
        };
        var w = { c:c, id:null, poke:function(id){ if(dead) return; if(id && cache) one(id); else full(); } };
        watchers.push(w); hub(); full();
        return function(){ dead = true; watchers = watchers.filter(function(x){ return x !== w; }); };
      }
    };
  }
  function collRef(c){
    var q = query(c, [], null, 0);
    q.path = c;
    q.doc = function(id){ return docRef(c + "/" + (id || ("d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)))); };
    q.add = async function(data){ var r = q.doc(); await r.set(data); return r; };
    return q;
  }
  var DB = Object.freeze({ doc:docRef, collection:collRef });

  /* ---------- connectors, through the Edge Functions ---------- */
  async function invoke(fn, body){
    var r = await sb.functions.invoke(fn, { body:body });
    var d = r.data;
    if(r.error || !d || d.ok === false){
      var msg = (d && d.error) || (r.error && r.error.message) || "failed";
      var e = dbErr("tool_error", msg); e.retryable = false; throw e;
    }
    return d;
  }
  var MCP = Object.freeze({
    callTool: async function(server, tool, input){
      input = input || {};
      if(server === "Slack" && tool === "slack_send_message"){
        var s = await invoke("pd-slack-post", { channel:input.channel_id, text:input.message, thread_ts:input.thread_ts || null });
        return { payload:s, cache:null };
      }
      if(server === "Dropbox" || server === "Asana"){
        var t = await invoke("pd-tools", { server:server, tool:tool, input:input });
        return { payload:t.payload, cache:null };
      }
      // Claude_Code_Remote (the old browser errands): the entry stays on the job's queue.
      throw dbErr("tool_error", "Not on the website yet - it stays on the queue.");
    },
    watchTool: function(){ return function(){}; }
  });

  var SAMPLE = null;
  async function sampleReady(){
    try{ var p = await invoke("pd-sample", { probe:true }); if(!p.ready) return null; }catch(e){ return null; }
    var f = async function(input, opts){
      var r = await invoke("pd-sample", { input:input, tier:(opts && opts.modelTier) || "default" });
      var out = { text:r.text || "", truncated:!!r.truncated };
      if(opts && typeof opts.onText === "function"){ try{ opts.onText({ text:out.text, delta:out.text }); }catch(e){} }
      return out;
    };
    f.json = async function(input, opts){
      var r = await invoke("pd-sample", { input:input, tier:(opts && opts.modelTier) || "default", json:true });
      return r.json;
    };
    f.limits = async function(){ return { images:false }; };
    return Object.freeze(f);
  }

  /* ---------- sign-in gate, then run the board ---------- */
  function gate(html){
    document.getElementById("pd-loading") && document.getElementById("pd-loading").remove();
    document.body.insertAdjacentHTML("afterbegin",
      '<div style="max-width:440px;margin:15vh auto;padding:0 18px;font-family:system-ui,sans-serif;line-height:1.5">' + html + "</div>");
  }
  function runBoard(html){
    var holder = document.createElement("div");
    holder.innerHTML = html;
    var scripts = Array.prototype.slice.call(holder.querySelectorAll("script"));
    scripts.forEach(function(s){ s.parentNode.removeChild(s); });
    while(holder.firstChild) document.body.appendChild(holder.firstChild);
    scripts.forEach(function(s){ var el = document.createElement("script"); el.textContent = s.textContent; document.body.appendChild(el); });
  }

  async function boot(){
    var s = (await sb.auth.getSession()).data.session;
    if(!s){ gate('<h2>Property Desk</h2><p>Sign in first.</p><p><a href="./" style="font-weight:700">Go to sign in &rarr;</a></p>'); return; }
    var me = ((await sb.rpc("pd_identity")).data || [])[0];
    if(!me){ gate("<h2>Not on the list</h2><p>" + s.user.email.replace(/</g, "&lt;") + " isn't set up for the Property Desk. Ask Brandon to add it.</p>"); return; }
    window.PD_ME = me;
    try{ localStorage.setItem("pd_me", me.initials || ""); }catch(e){}

    var app = await sb.from("pd_app").select("html,version").eq("name", "desk").maybeSingle();
    if(app.error || !app.data){ gate("<h2>Board not loaded</h2><p>The board's code isn't in the database yet. Run DEPLOY_property.bat on the ThinkStation.</p>"); return; }

    SAMPLE = await sampleReady();
    var caps = { db:DB, mcp:MCP, sample:SAMPLE };
    window.claude = Object.freeze({ use:function(name){ return Promise.resolve(caps[name] || null); } });

    document.getElementById("pd-loading") && document.getElementById("pd-loading").remove();
    runBoard(app.data.html);

    // the name picker becomes "who is signed in"
    var who = document.getElementById("who");
    if(who){ who.value = me.initials || ""; who.disabled = true; who.title = "Signed in as " + me.name; }
    var bar = document.createElement("div");
    bar.setAttribute("style", "position:fixed;right:10px;bottom:10px;z-index:9999;font:12px system-ui,sans-serif;" +
      "background:rgba(20,20,19,.85);color:#fff;padding:6px 10px;border-radius:8px");
    bar.innerHTML = "Signed in as <b></b> &middot; <a href='#' style='color:#fff'>Sign out</a>";
    bar.querySelector("b").textContent = me.name;
    bar.querySelector("a").onclick = async function(e){ e.preventDefault(); await sb.auth.signOut(); location.href = "./"; };
    document.body.appendChild(bar);
  }
  boot().catch(function(e){ console.error(e); gate("<h2>Something went wrong</h2><p>" + String(e && e.message || e).replace(/</g, "&lt;") + "</p>"); });
})();
