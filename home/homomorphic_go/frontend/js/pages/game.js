import { getGame, postMove, postKeys, getMessages, postMessage, b64enc, b64dec } from '../api.js';
import { shared, allNonZero } from '../gf251.js';
import { encryptMsg, decryptMsg } from '../crypto.js';
import { saveShared, saveBoard } from '../store-local.js';
import { legalMove, renderBoard } from '../board.js';
import { computeNextC, recoverMFromC, isValidBoard } from '../game-flow.js';
import { requireMe, ensureSecret, regenerateSecret, syncKeys, pubB64 } from './session.js';

const POLL_MS = 1500;
const $ = id => document.getElementById(id);

export async function init(ready) {
  const id = new URLSearchParams(location.search).get('id') || '';
  if (!/^\d+$/.test(id)) { location.href = 'lobby.html'; return; }
  const user = await requireMe();
  const st = {
    a: ensureSecret(user.id), game: null, S: null, sKey: '', M: new Uint8Array(361), regenCount: 0,
    color: 0, corrupted: false, busy: false, moveSeq: 0, renderKey: null, msgKey: null, msgSeq: 0, error: '',
  };
  await syncKeys(user, st.a);
  const gidEl = $('game-id');
  gidEl.dataset.gameId = id;
  gidEl.textContent = '#' + id;
  const board = $('board');
  const statusEl = $('status');
  const alertEl = $('move-alert');
  let alertTimer = 0;

  function setStatus(text, bad) {
    statusEl.textContent = text;
    statusEl.classList.toggle('bad', !!bad);
  }

  function clearAlert() {
    if (alertTimer) { clearTimeout(alertTimer); alertTimer = 0; }
    alertEl.hidden = true;
    alertEl.textContent = '';
  }

  function flashAlert(text) {
    if (alertTimer) clearTimeout(alertTimer);
    alertEl.textContent = text;
    alertEl.hidden = false;
    alertTimer = setTimeout(() => { alertEl.hidden = true; alertEl.textContent = ''; alertTimer = 0; }, 2500);
  }

  function statusText() {
    const g = st.game;
    if (!g) return ['Loading…'];
    if (st.error) return [st.error, true];
    if (st.corrupted) return ['Board corrupted', true];
    if (g.status === 'waiting') return ['Waiting for opponent'];
    if (g.status === 'finished') return ['Game over'];
    if (!st.S) return ['Deriving shared key…'];
    return [g.turn === 0 ? 'Black to move' : 'White to move'];
  }

  const refreshStatus = () => setStatus(...statusText());

  function setChatEnabled(on) {
    $('chat-input').disabled = !on;
    $('chat-send').disabled = !on;
  }

  function draw(key) {
    if (key === st.renderKey) return;
    st.renderKey = key;
    renderBoard(board, st.M, onPointClick);
  }

  async function deriveKey(g) {
    if (!g.white || !g.black.pubkey_b64 || !g.white.pubkey_b64 || !st.color) return null;
    const peerB64 = st.color === 1 ? g.white.pubkey_b64 : g.black.pubkey_b64;
    const key = peerB64 + ':' + st.a;
    if (key === st.sKey && st.S) return st.S;
    let peer;
    try { peer = b64dec(peerB64); } catch { return null; }
    if (peer.length !== 19 || !allNonZero(peer)) return null;
    const S = shared(peer, st.a);
    if (!allNonZero(S)) {
      if (st.color === 1 && st.regenCount < 32) {
        st.regenCount++;
        st.a = regenerateSecret(user.id);
        try { await postKeys(pubB64(st.a)); } catch { }
      }
      st.sKey = '';
      return null;
    }
    st.sKey = key;
    saveShared(id, S);
    return S;
  }

  function loadBoardState(g) {
    st.corrupted = false;
    const cb = g.board_c_b64 || '';
    if (!st.S || cb === '') { st.M = new Uint8Array(361); return; }
    let C;
    try { C = b64dec(cb); } catch { C = new Uint8Array(0); }
    if (C.length !== 361) { st.corrupted = true; st.M = new Uint8Array(361); return; }
    const M = recoverMFromC(C, st.S);
    if (!isValidBoard(M)) {
      st.corrupted = true;
      st.M = M.map(v => (v <= 2 ? v : 0));
      return;
    }
    st.M = M;
    saveBoard(id, M);
  }

  async function pollGame() {
    if (st.busy) return;
    const seq = st.moveSeq;
    let g;
    try { g = await getGame(id); } catch (err) {
      if (err.status === 401) { location.href = 'index.html'; return; }
      st.error = err.status === 404 ? 'Game not found' : st.error;
      refreshStatus();
      return;
    }
    if (st.busy || seq !== st.moveSeq) return;
    st.game = g;
    st.color = g.black && g.black.id === user.id ? 1 : g.white && g.white.id === user.id ? 2 : 0;
    $('you').textContent = st.color === 1 ? 'You play black' : st.color === 2 ? 'You play white' : 'You are spectating';
    $('players').textContent = `● ${g.black ? g.black.username : '—'}  vs  ○ ${g.white ? g.white.username : '—'}`;
    const S = await deriveKey(g);
    if (st.busy || seq !== st.moveSeq) return;
    const sChanged = S !== st.S;
    st.S = S;
    loadBoardState(g);
    draw((g.board_c_b64 || '') + '|' + (S ? b64enc(S) : ''));
    setChatEnabled(!!S);
    refreshStatus();
    if (sChanged) pollMessages();
  }

  function moveRejection(g, r, c) {
    if (!st.color) return 'You are only spectating this game';
    if (g.status === 'waiting') return 'Waiting for an opponent to join';
    if (g.status === 'finished') return 'This game is over';
    if (!st.S) return 'Still deriving the shared key — try again in a moment';
    if (st.corrupted) return 'The board is corrupted — no moves allowed';
    if ((g.turn === 0 ? 1 : 2) !== st.color) return 'Not your turn';
    if (st.M[r * 19 + c] !== 0) return 'That point is already occupied';
    if (!legalMove(st.M, r, c, st.color).ok) return 'Illegal move: that would be suicide';
    return '';
  }

  async function onPointClick(r, c) {
    const g = st.game;
    if (st.busy || !g) return;
    const reason = moveRejection(g, r, c);
    if (reason) { flashAlert(reason); return; }
    clearAlert();
    st.busy = true;
    try {
      const prevC = g.board_c_b64 ? b64dec(g.board_c_b64) : new Uint8Array(361);
      const { C2, M2 } = computeNextC(prevC, st.M, r, c, st.color, st.S);
      const cb = b64enc(C2);
      await postMove(id, cb);
      st.moveSeq++;
      st.game.board_c_b64 = cb;
      st.game.turn = st.game.turn === 0 ? 1 : 0;
      st.M = M2;
      st.error = '';
      saveBoard(id, M2);
      draw(cb + '|' + b64enc(st.S));
    } catch (err) {
      st.error = err.message || 'Move failed';
      flashAlert(st.error);
      setTimeout(() => { st.error = ''; refreshStatus(); }, 2500);
    } finally {
      st.busy = false;
      refreshStatus();
    }
  }

  async function messageText(m, S) {
    if (!S) return ['[encrypted]', false];
    try { return [await decryptMsg(S, m.ciphertext), true]; } catch { return ['[undecryptable]', false]; }
  }

  async function pollMessages() {
    let msgs;
    try { msgs = (await getMessages(id)) || []; } catch { return; }
    const S = st.S;
    const key = JSON.stringify(msgs.map(m => [m.sender_id, m.ciphertext, m.created_at])) + (S ? b64enc(S) : '');
    if (key === st.msgKey) return;
    const seq = ++st.msgSeq;
    const texts = await Promise.all(msgs.map(m => messageText(m, S)));
    if (seq !== st.msgSeq) return;
    st.msgKey = key;
    const log = $('chat-log');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 30;
    log.replaceChildren(...msgs.map((m, i) => {
      const div = document.createElement('div');
      div.className = 'chat-msg' + (m.sender_id === user.id ? ' mine' : '') + (texts[i][1] ? '' : ' undecryptable');
      div.dataset.senderId = m.sender_id;
      if (m.created_at) div.title = m.created_at;
      div.textContent = texts[i][0];
      return div;
    }));
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  $('chat-form').addEventListener('submit', async e => {
    e.preventDefault();
    const input = $('chat-input');
    const text = input.value.trim();
    if (!text || !st.S) return;
    try {
      await postMessage(id, await encryptMsg(st.S, text));
      input.value = '';
      await pollMessages();
    } catch (err) {
      setStatus(err.message || 'Message failed', true);
    }
  });

  setChatEnabled(false);
  draw('init');
  let inFlight = false;
  async function tick() {
    if (inFlight) return;
    inFlight = true;
    try { await pollGame(); await pollMessages(); } finally { inFlight = false; }
  }
  await tick();
  ready();
  setInterval(tick, POLL_MS);
}
