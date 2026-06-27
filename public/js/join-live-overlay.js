/* Join al live — lógica compartida (gamer / Minecraft / DBZ / Mario). */
(function () {
  'use strict';

  function init(opt) {
    opt = opt || {};
    var kind = opt.kind || 'streamjoin';
    var settingsKey = opt.settingsKey || 'streamJoin';
    var defaultPhrases = (opt.defaultPhrases && opt.defaultPhrases.length)
      ? opt.defaultPhrases.slice()
      : ['se unió a la partida', 'entró a la squad', 'ready to rumble', 'spawneó en el chat', 'se unió al live'];
    var previewName = opt.previewName || 'Gamer Preview';

    var params = new URLSearchParams(location.search);
    var isEmbed = params.get('embed') === '1';
    var DEFAULT_AVATAR = 'https://api.dicebear.com/7.x/bottts/svg?seed=Gamer';
    var PREVIEW_AVATAR = isEmbed ? '/jarron/lv.png' : DEFAULT_AVATAR;

    var alertEl = document.getElementById('joinAlert');
    var tagEl = document.getElementById('joinTag');
    var statusEl = document.getElementById('statusText');
    var avatarEl = document.getElementById('userAvatar');

    var joinQueue = [];
    var showing = false;
    var hideTimer = null;
    var pinned = false;
    var durMs = 4500;
    var phraseMode = 'random';
    var fixedPhrase = '';
    var customPhrases = defaultPhrases.slice();

    function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }
    function root() { return document.documentElement.style; }

    function applyConfig(cfg) {
      cfg = cfg || {};
      var ne = String(cfg.neon || '').trim().replace(/^#/, '');
      if (/^[0-9a-fA-F]{6}$/.test(ne)) root().setProperty('--primary-neon', '#' + ne);
      var acc = String(cfg.accent || '').trim().replace(/^#/, '');
      if (/^[0-9a-fA-F]{6}$/.test(acc)) root().setProperty('--join-accent', '#' + acc);
      var dur = parseFloat(cfg.durationSec);
      if (!isNaN(dur) && dur >= 2 && dur <= 15) { durMs = Math.round(dur * 1000); root().setProperty('--join-dur-ms', String(durMs)); }
      var osz = parseInt(cfg.scale, 10);
      if (!isNaN(osz) && osz >= 50 && osz <= 200) root().setProperty('--join-scale', String(osz / 100));
      var px = parseInt(cfg.posTop, 10);
      if (!isNaN(px) && px >= 0 && px <= 400) root().setProperty('--join-top', px + 'px');
      var pl = parseInt(cfg.posLeft, 10);
      if (!isNaN(pl) && pl >= 0 && pl <= 400) root().setProperty('--join-left', pl + 'px');
      var ls = parseFloat(cfg.laserSpeed);
      if (!isNaN(ls) && ls >= 0.5 && ls <= 6) root().setProperty('--laser-speed', ls + 's');
      var bgop = parseInt(cfg.bgOpacity, 10);
      if (!isNaN(bgop)) {
        bgop = clamp(bgop, 40, 100);
        root().setProperty('--join-bg-alpha', String((bgop / 100).toFixed(2)));
      }
      var tagsz = parseFloat(cfg.tagSize);
      if (!isNaN(tagsz) && tagsz >= 0.8 && tagsz <= 2.2) root().setProperty('--tag-size', tagsz + 'rem');
      var sts = parseFloat(cfg.statusSize);
      if (!isNaN(sts) && sts >= 0.55 && sts <= 1.4) root().setProperty('--status-size', sts + 'rem');
      var pm = String(cfg.phraseMode || '').trim().toLowerCase();
      if (pm === 'fixed' || pm === 'random') phraseMode = pm;
      var ph = String(cfg.phrase || '').trim();
      fixedPhrase = ph;
      var phl = String(cfg.phrases || '').trim();
      customPhrases = phl ? phl.split('|').map(function (s) { return s.trim(); }).filter(Boolean) : defaultPhrases.slice();
      if (!customPhrases.length) customPhrases = defaultPhrases.slice();
    }

    function pickAvatar(d) { return (d && (d.photo || d.profilePictureUrl) || '').toString().trim() || PREVIEW_AVATAR; }
    function pickName(d) { return String((d && (d.nickname || d.uniqueId)) || 'viewer').trim() || 'viewer'; }
    function pickPhrase() { return phraseMode === 'fixed' && fixedPhrase ? fixedPhrase : (customPhrases[Math.floor(Math.random() * customPhrases.length)] || 'se unió al live'); }

    function setContent(d, phrase) {
      if (tagEl) tagEl.textContent = pickName(d).toUpperCase();
      if (statusEl) statusEl.textContent = phrase || pickPhrase();
      if (avatarEl) {
        avatarEl.onerror = function () { avatarEl.onerror = null; avatarEl.src = PREVIEW_AVATAR; };
        avatarEl.src = pickAvatar(d);
        avatarEl.alt = pickName(d);
      }
    }
    function sample() { return { uniqueId: 'Preview', nickname: previewName, photo: PREVIEW_AVATAR }; }

    function showPinned() {
      pinned = true;
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      showing = false;
      setContent(sample());
      if (alertEl) alertEl.classList.add('active');
    }
    function hidePinned() { pinned = false; }
    function hideJoin() {
      if (pinned) return;
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      if (alertEl) alertEl.classList.remove('active');
    }

    function showJoin(d, opts) {
      opts = opts || {};
      if (!alertEl) return;
      if (pinned && !opts.force) return;
      setContent(d, opts.phrase);
      alertEl.classList.remove('active');
      requestAnimationFrame(function () { alertEl.classList.add('active'); });
      hideTimer = setTimeout(function () {
        hideJoin();
        showing = false;
        if (isEmbed) showPinned();
        setTimeout(pumpQueue, 180);
      }, durMs);
    }
    function pumpQueue() { if (showing || pinned || !joinQueue.length) return; showing = true; showJoin(joinQueue.shift(), { force: true }); }
    function enqueue(d) { if (!d) return; joinQueue.push(d); pumpQueue(); }

    function runTest() {
      hidePinned();
      joinQueue = [];
      showing = true;
      showJoin(sample(), { force: true });
    }
    function resetAll() {
      joinQueue = [];
      showing = false;
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      hidePinned();
      if (alertEl) alertEl.classList.remove('active');
      if (isEmbed) showPinned();
    }

    var ws, rt;
    function connect() {
      var proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(proto + '://' + location.host + '/ws' + location.search);
      ws.onopen = function () { clearTimeout(rt); };
      ws.onclose = function () { rt = setTimeout(connect, 1500); };
      ws.onmessage = function (ev) {
        var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.type === 'settings') {
          if (m.payload && m.payload[settingsKey]) applyConfig(m.payload[settingsKey]);
          return;
        }
        if (isEmbed) return;
        if (m.type === 'member') enqueue(m.payload);
        else if (m.type === 'streamJoinTest') runTest();
        else if (m.type === 'streamJoinReset') resetAll();
      };
    }

    window.addEventListener('message', function (e) {
      var d = e.data;
      if (!d || d.kind !== kind) return;
      if (d.type === 'config') {
        applyConfig(d.config);
        if (isEmbed) { setContent(sample()); if (alertEl) alertEl.classList.add('active'); }
      } else if (d.type === 'test') runTest();
      else if (d.type === 'reset') resetAll();
    });

    if (isEmbed) document.documentElement.classList.add('tf-embed');
    applyConfig(opt.defaults || {});
    if (isEmbed) requestAnimationFrame(showPinned);
    connect();
  }

  window.JoinLiveOverlay = { init: init };
})();
