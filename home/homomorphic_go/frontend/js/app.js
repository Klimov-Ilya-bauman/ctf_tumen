import * as login from './pages/login.js';
import * as lobby from './pages/lobby.js';
import * as game from './pages/game.js';

const pages = { login, lobby, game };
const body = document.body;
const mod = pages[body.dataset.page];

if (mod) {
  Promise.resolve()
    .then(() => mod.init(() => { body.dataset.ready = '1'; }))
    .catch(err => console.error(err));
}
