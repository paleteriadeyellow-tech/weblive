const $ = (id) => document.getElementById(id);
let ws, reconnectTimer;

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws${location.search}`);
  ws.onopen = () => clearTimeout(reconnectTimer);
  ws.onclose = () => { reconnectTimer = setTimeout(connectWS, 1500); };
  ws.onmessage = (ev) => {
    const { type, payload } = JSON.parse(ev.data);
    if (type === 'battle') render(payload);
    if (type === 'settings' && payload.battle) {
      render({
        enabled: payload.battle.enabled,
        teamA: payload.battle.teamA,
        teamB: payload.battle.teamB,
        goal: payload.battle.goal,
        scoreA: lastA,
        scoreB: lastB,
      });
    }
  };
}

let lastA = 0, lastB = 0;

function render(b) {
  lastA = b.scoreA ?? lastA;
  lastB = b.scoreB ?? lastB;

  const wrap = $('wrap');
  wrap.classList.toggle('hidden', !b.enabled);
  if (!b.enabled) return;

  $('nameA').textContent = b.teamA || 'Equipo A';
  $('nameB').textContent = b.teamB || 'Equipo B';
  $('goal').textContent = b.goal ?? 0;
  $('scoreA').textContent = fmt(lastA);
  $('scoreB').textContent = fmt(lastB);

  const total = lastA + lastB;
  let pctA = total > 0 ? (lastA / total) * 100 : 50;
  pctA = Math.max(8, Math.min(92, pctA)); // que ambos lados se vean siempre
  $('fillA').style.width = pctA + '%';
  $('fillB').style.width = (100 - pctA) + '%';
}

function fmt(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n ?? 0);
}

connectWS();
