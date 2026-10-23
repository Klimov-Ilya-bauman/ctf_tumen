import { register, login } from '../api.js';

export function init(ready) {
  const form = document.getElementById('auth-form');
  const user = document.getElementById('username');
  const pass = document.getElementById('password');
  const errEl = document.getElementById('auth-error');
  const buttons = [document.getElementById('login-btn'), document.getElementById('register-btn')];

  async function run(doRegister) {
    errEl.textContent = '';
    const u = user.value.trim(), p = pass.value;
    if (!u || !p) { errEl.textContent = 'Enter username and password'; return; }
    buttons.forEach(b => { b.disabled = true; });
    try {
      if (doRegister) await register(u, p);
      await login(u, p);
      location.href = 'lobby.html';
    } catch (err) {
      errEl.textContent = err.message || 'Request failed';
      buttons.forEach(b => { b.disabled = false; });
    }
  }

  form.addEventListener('submit', e => { e.preventDefault(); run(false); });
  document.getElementById('register-btn').addEventListener('click', () => run(true));
  ready();
}
