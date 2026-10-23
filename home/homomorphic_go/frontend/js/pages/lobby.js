import { listGames, createGame, joinGame } from '../api.js';
import { requireMe, ensureSecret, syncKeys, pubB64 } from './session.js';

function cell(text, cls) {
  const td = document.createElement('td');
  td.textContent = text;
  if (cls) td.className = cls;
  return td;
}

export async function init(ready) {
  const user = await requireMe();
  document.getElementById('me').textContent = user.username;
  const secret = ensureSecret(user.id);
  const A = pubB64(secret);
  await syncKeys(user, secret);
  const list = document.getElementById('games-list');
  const errEl = document.getElementById('lobby-error');

  const openGame = id => { location.href = `game.html?id=${encodeURIComponent(id)}`; };
  const fail = err => { errEl.textContent = err.message || 'Request failed'; };

  async function join(id) {
    errEl.textContent = '';
    try { await joinGame(id, A); openGame(id); } catch (err) { fail(err); }
  }

  function row(g) {
    const tr = document.createElement('tr');
    tr.className = 'game-row';
    tr.dataset.gameId = g.id;
    tr.appendChild(cell(String(g.id), 'gid'));
    tr.appendChild(cell(g.black ? g.black.username : '—', 'black'));
    tr.appendChild(cell(g.white ? g.white.username : '—', 'white'));
    tr.appendChild(cell(g.status, 'st st-' + g.status));
    const acts = cell('', 'acts');
    if (g.status === 'waiting' && (!g.black || g.black.id !== user.id)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'join-btn';
      b.dataset.gameId = g.id;
      b.textContent = 'Join';
      b.addEventListener('click', () => join(g.id));
      acts.appendChild(b);
    }
    const a = document.createElement('a');
    a.className = 'open-link';
    a.dataset.gameId = g.id;
    a.href = `game.html?id=${encodeURIComponent(g.id)}`;
    a.textContent = 'Open';
    acts.appendChild(a);
    tr.appendChild(acts);
    return tr;
  }

  async function refresh() {
    try {
      const games = (await listGames()) || [];
      list.replaceChildren(...games.map(row));
    } catch (err) {
      if (err.status === 401) location.href = 'index.html';
    }
  }

  document.getElementById('create-game-btn').addEventListener('click', async () => {
    errEl.textContent = '';
    try { const g = await createGame(A); openGame(g.game_id ?? g.id); } catch (err) { fail(err); }
  });
  document.getElementById('join-form').addEventListener('submit', e => {
    e.preventDefault();
    const id = document.getElementById('join-id').value.trim();
    if (!/^\d+$/.test(id)) { errEl.textContent = 'Enter a numeric game id'; return; }
    join(id);
  });

  await refresh();
  ready();
  setInterval(refresh, 3000);
}
