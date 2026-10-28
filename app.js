(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };

  // Station directory: Radio Browser (https://api.radio-browser.info). Tests may override window.RADIO_SERVERS.
  var FALLBACK_SERVERS = ["https://de1.api.radio-browser.info", "https://de2.api.radio-browser.info", "https://fi1.api.radio-browser.info"];
  var HLS_JS = "https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.17/hls.min.js";
  var STORE = "tarang-radio-v1";
  var SECURE_PAGE = location.protocol === "https:";

  var store = load();
  var servers = null, serverIdx = 0;
  var stations = [];            // normalized, de-duplicated, playable here
  var hiddenInsecure = 0;
  var view = [];                // current filtered list
  var f = { q: "", tag: "", state: "", sort: "listeners", favs: false, mine: false };
  var curId = null, playing = false, wantPlay = false, hls = null, sleepTimer = null;
  var audio = new Audio();
  audio.preload = "none";
  audio.volume = store.volume;

  // ---------- storage ----------
  function load() {
    var d = { favs: {}, custom: [], volume: 0.8, lang: "telugu", theme: "" };
    try { var s = JSON.parse(localStorage.getItem(STORE) || "{}"); for (var k in d) if (s[k] !== undefined) d[k] = s[k]; } catch (e) {}
    return d;
  }
  function save() { try { localStorage.setItem(STORE, JSON.stringify(store)); } catch (e) {} }

  // ---------- helpers ----------
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function initials(n) { var w = String(n).replace(/[^\p{L}\p{N} ]/gu, "").trim().split(/\s+/); return ((w[0] || "?")[0] + (w[1] ? w[1][0] : "")).toUpperCase(); }
  var toastT;
  function toast(m) { var t = $("toast"); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(function () { t.hidden = true; }, 4500); }
  function byId(id) { for (var i = 0; i < stations.length; i++) if (stations[i].id === id) return stations[i]; }
  function isHls(s) { return s.hls || /\.m3u8($|\?)/i.test(s.url); }
  function fetchT(url, ms) {
    var c = new AbortController(), t = setTimeout(function () { c.abort(); }, ms || 9000);
    return fetch(url, { signal: c.signal }).finally(function () { clearTimeout(t); });
  }

  // ---------- directory API ----------
  function discover() {
    if (servers) return Promise.resolve(servers);
    if (window.RADIO_SERVERS) { servers = window.RADIO_SERVERS.slice(); return Promise.resolve(servers); }
    return fetchT("https://all.api.radio-browser.info/json/servers", 6000)
      .then(function (r) { if (!r.ok) throw 0; return r.json(); })
      .then(function (l) {
        var names = l.map(function (x) { return "https://" + x.name; }).filter(function (v, i, a) { return a.indexOf(v) === i; });
        if (!names.length) throw 0;
        for (var i = names.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = names[i]; names[i] = names[j]; names[j] = t; }
        servers = names; return servers;
      })
      .catch(function () { servers = FALLBACK_SERVERS.slice(); return servers; });
  }
  function api(path) {
    return discover().then(function (list) {
      var tries = 0;
      function next() {
        if (tries >= list.length) return Promise.reject(new Error("Could not reach the station directory."));
        var base = list[(serverIdx + tries) % list.length]; tries++;
        return fetchT(base + path).then(function (r) { if (!r.ok) throw 0; serverIdx = (serverIdx + tries - 1) % list.length; return r.json(); }).catch(next);
      }
      return next();
    });
  }

  function normalize(r) {
    var url = r.url_resolved || r.url || "";
    if (!/^https?:\/\//i.test(url)) return null;
    return {
      id: r.stationuuid, name: String(r.name || "").replace(/\s+/g, " ").trim(), url: url, home: r.homepage || "", icon: r.favicon || "",
      tags: String(r.tags || "").split(",").map(function (t) { return t.trim().toLowerCase(); }).filter(function (t) { return t && t.length < 24; }),
      state: r.state || "", country: r.countrycode || "", codec: r.codec || "", bitrate: r.bitrate || 0,
      hls: !!r.hls, votes: r.votes || 0, listeners: r.clickcount || 0
    };
  }

  function loadStations() {
    var lang = store.lang;
    $("grid").setAttribute("aria-busy", "true");
    $("grid").innerHTML = new Array(9).join('<div class="skel"></div>');
    $("empty").hidden = true; $("count").textContent = "Loading stations…";
    return api("/json/stations/search?language=" + encodeURIComponent(lang) + "&languageExact=true&hidebroken=true&order=clickcount&reverse=true&limit=500")
      .then(function (rows) {
        var seen = {}, out = []; hiddenInsecure = 0;
        rows.forEach(function (r) {
          var s = normalize(r); if (!s || !s.name) return;
          var key = s.name.toLowerCase(); if (seen[key]) return; seen[key] = 1;
          if (SECURE_PAGE && /^http:/i.test(s.url)) { hiddenInsecure++; return; }
          out.push(s);
        });
        stations = store.custom.concat(out);
        buildFilters(); apply();
      })
      .catch(function (e) {
        stations = store.custom.slice(); buildFilters(); apply();
        $("grid").setAttribute("aria-busy", "false");
        showEmpty(e.message + " Check your connection, then try again.", true);
      });
  }

  // ---------- filters + render ----------
  function buildFilters() {
    var tagCount = {}, states = {};
    stations.forEach(function (s) {
      s.tags.forEach(function (t) { if (t !== store.lang) tagCount[t] = (tagCount[t] || 0) + 1; });
      if (s.state) states[s.state] = (states[s.state] || 0) + 1;
    });
    var tags = Object.keys(tagCount).sort(function (a, b) { return tagCount[b] - tagCount[a]; }).slice(0, 12);
    var h = '<button class="chip" data-chip="favs" aria-pressed="' + f.favs + '">★ Favorites</button>';
    if (store.custom.length) h += '<button class="chip" data-chip="mine" aria-pressed="' + f.mine + '">My streams</button>';
    h += tags.map(function (t) { return '<button class="chip" data-tag="' + esc(t) + '" aria-pressed="' + (f.tag === t) + '">' + esc(t) + "</button>"; }).join("");
    $("chips").innerHTML = h;
    var sel = $("stateSel"), keep = f.state;
    sel.innerHTML = '<option value="">All locations</option>' + Object.keys(states).sort().map(function (s) { return '<option value="' + esc(s) + '">' + esc(s) + " (" + states[s] + ")</option>"; }).join("");
    sel.value = states[keep] ? keep : ""; f.state = sel.value;
  }

  function apply() {
    var q = f.q.trim().toLowerCase();
    view = stations.filter(function (s) {
      if (f.favs && !store.favs[s.id]) return false;
      if (f.mine && !s.custom) return false;
      if (f.tag && s.tags.indexOf(f.tag) < 0) return false;
      if (f.state && s.state !== f.state) return false;
      if (q && (s.name + " " + s.tags.join(" ") + " " + s.state).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var by = { listeners: function (a, b) { return b.listeners - a.listeners; }, votes: function (a, b) { return b.votes - a.votes; },
      name: function (a, b) { return a.name.localeCompare(b.name); }, bitrate: function (a, b) { return b.bitrate - a.bitrate; } }[f.sort];
    view.sort(by);
    $("grid").setAttribute("aria-busy", "false");
    render();
  }

  function cardHtml(s) {
    var sub = [s.state, s.tags.slice(0, 2).join(", "), s.codec && s.bitrate ? s.codec.toUpperCase() + " " + s.bitrate + "k" : ""].filter(Boolean).join(" · ") || "Live radio";
    var img = s.icon && /^https?:/i.test(s.icon) && !(SECURE_PAGE && /^http:/i.test(s.icon)) ? '<img src="' + esc(s.icon) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : "";
    var on = s.id === curId;
    return '<div class="card' + (on ? " on" + (playing ? " live" : "") : "") + '" data-id="' + esc(s.id) + '">' +
      '<button class="go" data-play="' + esc(s.id) + '" aria-label="Play ' + esc(s.name) + '"><span class="av">' + esc(initials(s.name)) + img + '</span>' +
      '<span class="meta"><span class="name">' + esc(s.name) + '</span><span class="sub">' + esc(sub) + '</span></span></button>' +
      '<span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>' +
      '<button class="fav" data-fav="' + esc(s.id) + '" aria-pressed="' + !!store.favs[s.id] + '" aria-label="Favorite ' + esc(s.name) + '">' + (store.favs[s.id] ? "★" : "☆") + "</button></div>";
  }

  function render() {
    $("grid").innerHTML = view.map(cardHtml).join("");
    var n = view.length, note = hiddenInsecure ? " · " + hiddenInsecure + " plain-http streams hidden on this secure page" : "";
    $("count").textContent = n + " station" + (n === 1 ? "" : "s") + note;
    if (!n) {
      if (f.favs) showEmpty("No favorites yet. Tap ☆ on a station to keep it here.");
      else if (stations.length) showEmpty("No stations match these filters.");
    } else $("empty").hidden = true;
    moveNeedle();
  }
  function showEmpty(msg, retry) {
    var e = $("empty"); e.hidden = false;
    e.innerHTML = "<p>" + esc(msg) + "</p>" + (retry ? '<button class="btn primary" id="retry" type="button">Try again</button>' : "");
  }
  function refreshCards() {
    var cards = $("grid").querySelectorAll(".card");
    Array.prototype.forEach.call(cards, function (c) {
      var on = c.getAttribute("data-id") === curId;
      c.className = "card" + (on ? " on" + (playing ? " live" : "") : "");
    });
  }
  function moveNeedle() {
    var i = -1; for (var k = 0; k < view.length; k++) if (view[k].id === curId) i = k;
    var pos = i < 0 ? 0 : (view.length > 1 ? i / (view.length - 1) : 0.5);
    $("needle").style.left = "calc(" + (pos * 100) + "% - " + (pos * 3) + "px)";
  }

  // ---------- player ----------
  function setSub(t, err) { var e = $("npSub"); e.textContent = t; e.className = "np-sub" + (err ? " err" : ""); }
  function setPlayUi() { var b = $("playBtn"); b.textContent = wantPlay ? "⏸" : "▶"; b.setAttribute("aria-label", wantPlay ? "Stop" : "Play"); }
  function teardownHls() { if (hls) { try { hls.destroy(); } catch (e) {} hls = null; } }
  function stopAudio() {
    wantPlay = false; playing = false; teardownHls();
    audio.pause(); audio.removeAttribute("src"); audio.load();
    setPlayUi(); refreshCards();
  }

  function loadHlsLib() {
    if (window.Hls) return Promise.resolve(window.Hls);
    return new Promise(function (res, rej) {
      var s = document.createElement("script"); s.src = HLS_JS; s.async = true;
      s.onload = function () { res(window.Hls); }; s.onerror = function () { rej(new Error("hls")); };
      document.head.appendChild(s);
    });
  }

  function playStation(id) {
    var s = byId(id); if (!s) return;
    curId = id; wantPlay = true; playing = false; teardownHls();
    $("npName").textContent = s.name;
    var av = $("npAv"); av.textContent = initials(s.name);
    setSub("Connecting…"); setPlayUi(); refreshCards(); moveNeedle(); mediaSession(s);
    if (!s.custom && servers && servers[serverIdx]) fetchT(servers[serverIdx] + "/json/url/" + encodeURIComponent(id), 5000).catch(function () {}); // click count, as the directory asks
    var token = id + ":" + Date.now(); audio._token = token;
    var start = function () { var p = audio.play(); if (p && p.catch) p.catch(function (e) { if (audio._token === token && e.name !== "AbortError") fail(); }); };
    if (isHls(s) && !audio.canPlayType("application/vnd.apple.mpegurl")) {
      loadHlsLib().then(function (Hls) {
        if (audio._token !== token) return;
        if (!Hls || !Hls.isSupported()) return fail();
        hls = new Hls({ lowLatencyMode: false });
        hls.on(Hls.Events.ERROR, function (_e, d) { if (d.fatal && audio._token === token) fail(); });
        hls.loadSource(s.url); hls.attachMedia(audio); start();
      }).catch(fail);
    } else { audio.src = s.url; start(); }
  }
  function fail() {
    playing = false; wantPlay = false; teardownHls(); setPlayUi(); refreshCards();
    setSub("This stream is not available. Try another station.", true);
    toast("Could not play that station.");
  }
  audio.addEventListener("playing", function () { playing = true; var s = byId(curId); setSub("Live" + (s && s.state ? " · " + s.state : "")); refreshCards(); });
  audio.addEventListener("waiting", function () { if (wantPlay) setSub("Buffering…"); });
  audio.addEventListener("error", function () { if (wantPlay && audio.getAttribute("src")) fail(); });

  function toggle() {
    if (wantPlay) { stopAudio(); setSub("Stopped"); return; }
    if (curId) playStation(curId);
    else if (view.length) playStation(view[0].id);
  }
  function step(d) {
    if (!view.length) return;
    var i = -1; for (var k = 0; k < view.length; k++) if (view[k].id === curId) i = k;
    playStation(view[(i + d + view.length) % view.length].id);
  }
  function mediaSession(s) {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: s.name, artist: "Tarang Radio", artwork: s.icon && /^https:/.test(s.icon) ? [{ src: s.icon }] : [] });
      navigator.mediaSession.setActionHandler("play", toggle); navigator.mediaSession.setActionHandler("pause", toggle);
      navigator.mediaSession.setActionHandler("nexttrack", function () { step(1); }); navigator.mediaSession.setActionHandler("previoustrack", function () { step(-1); });
    } catch (e) {}
  }

  // ---------- events ----------
  $("grid").addEventListener("click", function (e) {
    var p = e.target.closest("[data-play]"), fv = e.target.closest("[data-fav]");
    if (p) { var id = p.getAttribute("data-play"); if (id === curId && wantPlay) { stopAudio(); setSub("Stopped"); } else playStation(id); }
    else if (fv) {
      var s = byId(fv.getAttribute("data-fav")); if (!s) return;
      if (store.favs[s.id]) delete store.favs[s.id]; else store.favs[s.id] = s;
      save(); if (f.favs) apply(); else { fv.textContent = store.favs[s.id] ? "★" : "☆"; fv.setAttribute("aria-pressed", String(!!store.favs[s.id])); }
    }
  });
  // Broken logos fall back to the initials underneath.
  $("grid").addEventListener("error", function (e) { if (e.target.tagName === "IMG") e.target.remove(); }, true);
  $("empty").addEventListener("click", function (e) { if (e.target.id === "retry") loadStations(); });

  $("chips").addEventListener("click", function (e) {
    var b = e.target.closest("button"); if (!b) return;
    if (b.dataset.chip === "favs") { f.favs = !f.favs; f.mine = false; }
    else if (b.dataset.chip === "mine") { f.mine = !f.mine; f.favs = false; }
    else if (b.dataset.tag) f.tag = f.tag === b.dataset.tag ? "" : b.dataset.tag;
    buildFilters(); apply();
  });
  $("q").addEventListener("input", function () { f.q = this.value; apply(); });
  $("stateSel").addEventListener("change", function () { f.state = this.value; apply(); });
  $("sortSel").addEventListener("change", function () { f.sort = this.value; apply(); });
  $("lang").addEventListener("change", function () { store.lang = this.value; save(); f.tag = ""; f.state = ""; loadStations(); });
  $("playBtn").addEventListener("click", toggle);
  $("nextBtn").addEventListener("click", function () { step(1); });
  $("prevBtn").addEventListener("click", function () { step(-1); });
  $("vol").addEventListener("input", function () { audio.volume = +this.value; audio.muted = false; store.volume = +this.value; save(); $("muteBtn").textContent = "🔊"; });
  $("muteBtn").addEventListener("click", function () { audio.muted = !audio.muted; this.textContent = audio.muted ? "🔇" : "🔊"; this.setAttribute("aria-label", audio.muted ? "Unmute" : "Mute"); });
  $("sleep").addEventListener("change", function () {
    clearTimeout(sleepTimer); var m = +this.value;
    if (m) { sleepTimer = setTimeout(function () { stopAudio(); setSub("Sleep timer ended"); $("sleep").value = "0"; }, m * 60000); toast("Radio will stop in " + m + " minutes."); }
  });

  document.addEventListener("keydown", function (e) {
    var tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "select" || tag === "textarea" || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "/") { e.preventDefault(); $("q").focus(); }
    else if (e.key === " " && tag !== "button") { e.preventDefault(); toggle(); }
  });

  // theme
  function applyTheme() { if (store.theme) document.documentElement.setAttribute("data-theme", store.theme); }
  $("themeBtn").addEventListener("click", function () {
    var cur = document.documentElement.getAttribute("data-theme");
    var dark = cur === "dark" || (!cur && matchMedia("(prefers-color-scheme:dark)").matches);
    store.theme = dark ? "light" : "dark"; save(); applyTheme();
  });

  // add custom stream
  var dlg = $("addDlg");
  $("addBtn").addEventListener("click", function () { $("addErr").textContent = ""; $("addForm").reset(); dlg.showModal(); $("addName").focus(); });
  $("addCancel").addEventListener("click", function () { dlg.close(); });
  $("addForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var name = $("addName").value.trim(), url = $("addUrl").value.trim(), u;
    try { u = new URL(url); } catch (x) { $("addErr").textContent = "Enter a full address starting with http:// or https://"; return; }
    if (u.protocol !== "http:" && u.protocol !== "https:") { $("addErr").textContent = "Only http and https streams are supported."; return; }
    if (SECURE_PAGE && u.protocol === "http:") { $("addErr").textContent = "This page is served over HTTPS, so your browser blocks plain http streams. Use an https address."; return; }
    var s = { id: "custom-" + Date.now().toString(36), name: name, url: url, home: "", icon: "", tags: ["my stream"], state: "", country: "", codec: "", bitrate: 0, hls: false, votes: 0, listeners: 0, custom: true };
    store.custom.unshift(s); save(); stations.unshift(s); dlg.close(); buildFilters(); apply(); toast("Saved " + name + ".");
  });

  // ---------- boot ----------
  applyTheme();
  $("vol").value = store.volume;
  $("lang").value = store.lang;
  loadStations();
})();
