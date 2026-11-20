// UI layer. All DOM is built with textContent (never innerHTML) so decrypted data
// can't inject markup or script.
import { VaultClient } from './client.js';
import { generatePassword } from './crypto.js';

const client = new VaultClient();
const app = document.getElementById('app');
const AUTO_LOCK_MS = 10 * 60 * 1000;
const CLIPBOARD_CLEAR_MS = 30 * 1000;

const state = { vaults: [], vaultId: null, items: [], itemId: null, editing: null, search: '', members: [] };

// ---------- tiny DOM helper ----------
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3000);
}

async function busy(btn, fn) {
  const prev = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Working…';
  }
  try {
    return await fn();
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = prev;
    }
  }
}

function handleError(err, target) {
  if (err?.status === 401 && client.user && !client.unlocked) return renderUnlock();
  if (err?.status === 401 && !client.user) return renderAuth('login');
  const msg = err?.message || 'Something went wrong';
  if (target) target.textContent = msg;
  else toast(msg);
}

function safeHref(url) {
  try {
    const u = new URL(url.includes('://') ? url : `https://${url}`);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

async function copy(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label} copied. Clipboard clears in 30s.`);
    clearTimeout(copy.timer);
    copy.timer = setTimeout(() => navigator.clipboard.writeText('').catch(() => {}), CLIPBOARD_CLEAR_MS);
  } catch {
    toast('Copy failed: clipboard not available');
  }
}

function strength(pw) {
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^A-Za-z0-9]/.test(pw)) pool += 33;
  const bits = pw.length * Math.log2(pool || 1);
  return Math.min(1, bits / 100);
}

// ---------- auto-lock ----------
let idleTimer;
function resetIdle() {
  clearTimeout(idleTimer);
  if (client.unlocked) idleTimer = setTimeout(lockNow, AUTO_LOCK_MS);
}
['pointerdown', 'keydown'].forEach((e) => document.addEventListener(e, resetIdle, { passive: true }));

function lockNow() {
  client.lock();
  Object.assign(state, { items: [], itemId: null, editing: null, members: [] });
  client.me().then(
    (profile) => {
      client.user = profile; // keep identity, drop keys
      renderUnlock();
    },
    () => renderAuth('login'),
  );
}

// ---------- auth screens ----------
function brand(sub) {
  return h('div', {},
    h('div', { class: 'brand' }, h('img', { src: '/favicon.svg', alt: '' }), h('h1', {}, 'Vault')),
    h('p', { class: 'muted small' }, sub));
}

function renderAuth(mode = 'login') {
  const err = h('p', { class: 'error', role: 'alert' });
  const email = h('input', { type: 'email', required: true, autocomplete: 'username', autofocus: true });
  const pw = h('input', { type: 'password', required: true, autocomplete: mode === 'login' ? 'current-password' : 'new-password', minLength: mode === 'register' ? 12 : 1 });
  const pw2 = h('input', { type: 'password', required: true, autocomplete: 'new-password' });
  const bar = h('div');
  const submit = h('button', { class: 'btn primary', type: 'submit' }, mode === 'login' ? 'Unlock vault' : 'Create account');
  if (mode === 'register') {
    pw.addEventListener('input', () => {
      const s = strength(pw.value);
      bar.style.width = `${Math.round(s * 100)}%`;
      bar.style.background = s < 0.5 ? 'var(--danger)' : s < 0.75 ? '#d39b1f' : 'var(--accent)';
    });
  }

  const form = h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = '';
    if (mode === 'register') {
      if (pw.value.length < 12) return (err.textContent = 'Use at least 12 characters. A passphrase of 4+ random words is ideal.');
      if (pw.value !== pw2.value) return (err.textContent = 'Passwords do not match.');
    }
    await busy(submit, async () => {
      try {
        if (mode === 'login') await client.login(email.value.trim(), pw.value);
        else await client.register(email.value.trim(), pw.value);
        pw.value = pw2.value = '';
        await enterApp();
      } catch (e2) {
        err.textContent = e2.message;
      }
    });
  } },
    h('label', { class: 'field' }, 'Email', email),
    h('label', { class: 'field' }, mode === 'login' ? 'Master password' : 'Choose a master password', pw),
    mode === 'register' && h('div', { class: 'meter', 'aria-hidden': 'true' }, bar),
    mode === 'register' && h('label', { class: 'field' }, 'Confirm master password', pw2),
    mode === 'register' && h('p', { class: 'notice warn' },
      'Your master password is never sent to the server and cannot be recovered. If you forget it, your data is gone. Write it down somewhere safe.'),
    err,
    submit,
  );

  const tab = (m, label) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(m === mode), onclick: () => renderAuth(m) }, label);
  app.replaceChildren(h('main', { class: 'auth-wrap' }, h('div', { class: 'auth-card' },
    brand('End-to-end encrypted password manager. Encryption happens in your browser.'),
    h('div', { class: 'tabs', role: 'tablist' }, tab('login', 'Sign in'), tab('register', 'Create account')),
    form)));
  email.focus();
}

function renderUnlock() {
  clearTimeout(idleTimer);
  const err = h('p', { class: 'error', role: 'alert' });
  const pw = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Unlock');
  app.replaceChildren(h('main', { class: 'auth-wrap' }, h('div', { class: 'auth-card' },
    brand(`Locked. Signed in as ${client.user?.email ?? ''}`),
    h('form', { class: 'stack', onsubmit: async (e) => {
      e.preventDefault();
      await busy(submit, async () => {
        try {
          await client.unlock(pw.value);
          pw.value = '';
          await enterApp();
        } catch (e2) {
          err.textContent = e2.message;
        }
      });
    } },
      h('label', { class: 'field' }, 'Master password', pw), err, submit,
      h('button', { class: 'btn ghost', type: 'button', onclick: async () => { await client.logout().catch(() => {}); renderAuth('login'); } }, 'Sign out')))));
  pw.focus();
}

// ---------- main app ----------
async function enterApp() {
  resetIdle();
  await refreshVaults();
  if (!state.vaults.length) {
    await client.createVault('Personal');
    await refreshVaults();
  }
  if (!state.vaults.some((v) => v.id === state.vaultId)) state.vaultId = state.vaults[0]?.id ?? null;
  await loadItems();
}

async function refreshVaults() {
  state.vaults = await client.listVaults();
}

async function loadItems() {
  state.items = state.vaultId ? await client.listItems(state.vaultId) : [];
  if (!state.items.some((i) => i.id === state.itemId)) state.itemId = null;
  render();
}

const currentVault = () => state.vaults.find((v) => v.id === state.vaultId);
const canEdit = () => ['owner', 'editor'].includes(currentVault()?.role);
const isOwner = () => currentVault()?.role === 'owner';

function render() {
  const shell = h('div', { class: `shell${state.itemId || state.editing ? ' show-detail' : ''}` },
    renderSidebar(), renderList(), h('section', { class: 'detail', 'aria-label': 'Item details' }, renderDetail()));
  app.replaceChildren(shell);
}

function renderSidebar() {
  return h('nav', { class: 'sidebar', 'aria-label': 'Vaults' },
    h('div', { class: 'sidebar-head' }, h('img', { src: '/favicon.svg', alt: '', width: 24, height: 24 }), h('h2', {}, 'Vault'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm', title: 'New vault', onclick: newVaultDialog }, '+ Vault')),
    h('ul', { class: 'vault-list' }, state.vaults.map((v) => h('li', {},
      h('button', { 'aria-current': String(v.id === state.vaultId), onclick: async () => {
        state.vaultId = v.id;
        state.itemId = null;
        state.editing = null;
        state.search = '';
        await loadItems().catch(handleError);
      } },
        h('span', { class: 'name' }, v.name),
        v.memberCount > 1 && h('span', { class: 'badge', title: `Shared with ${v.memberCount - 1} other(s)` }, `${v.memberCount}`),
        v.role !== 'owner' && h('span', { class: 'badge' }, v.role))))),
    h('div', { class: 'sidebar-foot' },
      h('div', { class: 'who', title: client.user.email }, client.user.email),
      h('div', { class: 'row' },
        h('button', { class: 'btn sm', onclick: accountDialog }, 'Account'),
        h('button', { class: 'btn sm', onclick: lockNow }, 'Lock'),
        h('button', { class: 'btn sm ghost', onclick: async () => { await client.logout().catch(() => {}); renderAuth('login'); } }, 'Sign out'))));
}

function renderList() {
  const v = currentVault();
  const search = h('input', { type: 'search', placeholder: 'Search this vault', value: state.search, 'aria-label': 'Search' });
  const list = h('ul', { class: 'item-list' });
  const fill = () => {
    const q = state.search.toLowerCase();
    const shown = state.items.filter((i) => !q || [i.title, i.username, i.url].some((f) => String(f || '').toLowerCase().includes(q)));
    list.replaceChildren(...(shown.length ? shown.map((i) => h('li', {},
      h('button', { 'aria-current': String(i.id === state.itemId), onclick: () => { state.itemId = i.id; state.editing = null; render(); } },
        h('span', { class: 'avatar', 'aria-hidden': 'true' }, (i.title || '?').trim()[0] || '?'),
        h('span', { class: 'txt' }, h('div', { class: 't' }, i.title || '(untitled)'), h('div', { class: 's' }, i.username || i.url || ''))))) :
      [h('li', { class: 'empty' }, state.items.length ? 'No matches' : canEdit() ? 'No items yet. Add your first login.' : 'This vault is empty.')]));
  };
  search.addEventListener('input', () => { state.search = search.value; fill(); });
  fill();
  return h('section', { class: 'list-pane', 'aria-label': 'Items' },
    h('div', { class: 'list-head' },
      h('div', { class: 'row' },
        h('h2', { class: 'spacer' }, v?.name ?? ''),
        v && h('button', { class: 'btn sm', onclick: shareDialog }, v.memberCount > 1 ? `Shared · ${v.memberCount}` : 'Share'),
        canEdit() && h('button', { class: 'btn sm primary', onclick: () => { state.editing = { title: '', username: '', password: generatePassword(), url: '', notes: '' }; state.itemId = null; render(); } }, '+ Add')),
      search),
    list);
}

function back() {
  return h('button', { class: 'btn sm ghost back', onclick: () => { state.itemId = null; state.editing = null; render(); } }, '← Back');
}

function renderDetail() {
  if (state.editing) return renderEditor();
  const item = state.items.find((i) => i.id === state.itemId);
  if (!item) return h('div', { class: 'empty' }, 'Select an item to view it.');

  let revealed = false;
  const pwVal = h('span', { class: 'v mono' }, '••••••••••••');
  const revealBtn = h('button', { class: 'btn sm', onclick: () => {
    revealed = !revealed;
    pwVal.textContent = revealed ? item.password : '••••••••••••';
    revealBtn.textContent = revealed ? 'Hide' : 'Show';
  } }, 'Show');
  const href = item.url && safeHref(item.url);

  return h('div', {},
    h('div', { class: 'detail-head' }, back(),
      h('span', { class: 'avatar', 'aria-hidden': 'true' }, (item.title || '?')[0]),
      h('h1', { class: 'spacer' }, item.title || '(untitled)'),
      canEdit() && h('button', { class: 'btn sm', onclick: () => { state.editing = { ...item }; render(); } }, 'Edit'),
      canEdit() && h('button', { class: 'btn sm danger', onclick: async (e) => {
        if (!confirm(`Delete "${item.title}"? Everyone with access to this vault will lose it.`)) return;
        await busy(e.currentTarget, async () => {
          try {
            await client.deleteItem(state.vaultId, item.id);
            state.itemId = null;
            await refreshVaults();
            await loadItems();
          } catch (err) { handleError(err); }
        });
      } }, 'Delete')),
    item.username && h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Username'), h('span', { class: 'v' }, item.username),
      h('button', { class: 'btn sm', onclick: () => copy(item.username, 'Username') }, 'Copy')),
    item.password && h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Password'), pwVal,
      h('span', { class: 'row' }, revealBtn, h('button', { class: 'btn sm', onclick: () => copy(item.password, 'Password') }, 'Copy'))),
    item.url && h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Website'),
      href ? h('a', { class: 'v', href, target: '_blank', rel: 'noopener noreferrer' }, item.url) : h('span', { class: 'v' }, item.url),
      h('button', { class: 'btn sm', onclick: () => copy(item.url, 'URL') }, 'Copy')),
    item.notes && h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Notes'), h('span', { class: 'v pre' }, item.notes), h('span')),
    h('p', { class: 'muted small' }, `Last updated ${new Date(item.updatedAt).toLocaleString()}`));
}

function renderEditor() {
  const it = state.editing;
  const f = {
    title: h('input', { type: 'text', value: it.title, required: true, maxLength: 500 }),
    username: h('input', { type: 'text', value: it.username, autocomplete: 'off', maxLength: 1000 }),
    password: h('input', { type: 'password', value: it.password, autocomplete: 'new-password', class: 'mono' }),
    url: h('input', { type: 'text', value: it.url, placeholder: 'https://', maxLength: 2000 }),
    notes: h('textarea', { maxLength: 50000 }, it.notes),
  };
  const opts = { length: 20, lower: true, upper: true, digits: true, symbols: true };
  const len = h('input', { type: 'number', min: 8, max: 128, value: 20, class: 'small' });
  len.style.width = '70px';
  const optBoxes = ['upper', 'digits', 'symbols'].map((k) =>
    h('label', {}, h('input', { type: 'checkbox', checked: true, onchange: (e) => { opts[k] = e.target.checked; } }), k));
  const err = h('p', { class: 'error', role: 'alert' });
  const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save');

  return h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    const fields = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]));
    await busy(save, async () => {
      try {
        const id = await client.saveItem(state.vaultId, fields, it.id);
        state.editing = null;
        state.itemId = id;
        await refreshVaults();
        await loadItems();
        toast('Saved');
      } catch (e2) { handleError(e2, err); }
    });
  } },
    h('div', { class: 'detail-head' }, back(), h('h1', { class: 'spacer' }, it.id ? 'Edit item' : 'New item')),
    h('label', { class: 'field' }, 'Title', f.title),
    h('label', { class: 'field' }, 'Username / email', f.username),
    h('label', { class: 'field' }, 'Password', h('div', { class: 'input-group' }, f.password,
      h('button', { class: 'btn', type: 'button', onclick: (e) => {
        f.password.type = f.password.type === 'password' ? 'text' : 'password';
        e.currentTarget.textContent = f.password.type === 'password' ? 'Show' : 'Hide';
      } }, 'Show'),
      h('button', { class: 'btn', type: 'button', onclick: () => {
        try {
          f.password.value = generatePassword({ ...opts, length: Number(len.value) || 20 });
          f.password.type = 'text';
        } catch (e2) { err.textContent = e2.message; }
      } }, 'Generate'))),
    h('div', { class: 'gen-opts muted' }, h('label', {}, 'Length', len), optBoxes),
    h('label', { class: 'field' }, 'Website', f.url),
    h('label', { class: 'field' }, 'Notes', f.notes),
    err,
    h('div', { class: 'row' }, save, h('button', { class: 'btn', type: 'button', onclick: () => { state.editing = null; render(); } }, 'Cancel')));
}

// ---------- dialogs ----------
function dialog(...content) {
  const d = h('dialog', {}, h('div', { class: 'dlg' }, ...content));
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  d.showModal();
  return d;
}

function newVaultDialog() {
  const name = h('input', { type: 'text', required: true, maxLength: 200, placeholder: 'e.g. Family, Work' });
  const err = h('p', { class: 'error' });
  const ok = h('button', { class: 'btn primary', type: 'submit' }, 'Create');
  const d = dialog(h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    await busy(ok, async () => {
      try {
        state.vaultId = await client.createVault(name.value.trim());
        state.itemId = null;
        d.close();
        await refreshVaults();
        await loadItems();
      } catch (e2) { handleError(e2, err); }
    });
  } },
    h('h2', {}, 'New vault'),
    h('p', { class: 'muted small' }, 'A vault is a group of items with its own encryption key. Share a vault to give people access to everything in it.'),
    h('label', { class: 'field' }, 'Name', name), err,
    h('div', { class: 'dlg-foot' }, h('button', { class: 'btn', type: 'button', onclick: () => d.close() }, 'Cancel'), ok)));
}

async function shareDialog() {
  const v = currentVault();
  const body = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Loading…'));
  const d = dialog(h('div', { class: 'row' }, h('h2', { class: 'spacer' }, `Sharing: ${v.name}`),
    h('button', { class: 'btn sm ghost', onclick: () => d.close(), 'aria-label': 'Close' }, '✕')), body);
  d.addEventListener('close', () => { if (client.unlocked && state.vaults.some((x) => x.id === v.id)) render(); });

  async function draw() {
    const [members, activity] = await Promise.all([client.listMembers(v.id), client.activity(v.id)]);
    const itemNames = new Map(state.items.map((i) => [i.id, i.title]));
    const err = h('p', { class: 'error', role: 'alert' });

    const memberRows = members.map((m) => {
      const me = m.userId === client.user.id;
      const roleSel = h('select', { 'aria-label': `Role for ${m.email}`, disabled: !isOwner(), onchange: async (e) => {
        try {
          await client.setRole(v.id, m.userId, e.target.value);
          toast('Role updated');
          await refreshVaults();
          await draw();
        } catch (e2) { handleError(e2, err); await draw(); }
      } }, ['owner', 'editor', 'viewer'].map((r) => h('option', { value: r, selected: r === m.role }, r)));
      roleSel.style.width = 'auto';
      return h('div', { class: 'member' },
        h('div', { class: 'info' }, h('div', {}, m.email, me ? ' (you)' : ''), h('div', { class: 'fp', title: 'Key fingerprint' }, m.fingerprint)),
        roleSel,
        isOwner() && !me && h('button', { class: 'btn sm danger', onclick: async (e) => {
          if (!confirm(`Remove ${m.email}? The vault key will be rotated and every item re-encrypted, so their old access stops working.\n\nRemember: anything they already saw (or copied) should be considered known to them. Change those passwords if that matters.`)) return;
          await busy(e.currentTarget, async () => {
            try {
              await client.removeMember(v.id, m.userId);
              toast(`${m.email} removed. Vault key rotated.`);
              await refreshVaults();
              await draw();
            } catch (e2) { handleError(e2, err); }
          });
        } }, 'Remove'),
        !isOwner() && me && h('button', { class: 'btn sm danger', onclick: async () => {
          if (!confirm('Leave this vault? You will lose access to its items.')) return;
          try {
            await client.leaveVault(v.id);
            d.close();
            state.vaultId = null;
            await enterApp();
          } catch (e2) { handleError(e2, err); }
        } }, 'Leave'));
    });

    const add = isOwner() ? addMemberForm(v, draw, err) : h('p', { class: 'muted small' }, 'Only owners can add or remove people.');

    const labels = {
      'vault.create': 'created the vault', 'vault.rename': 'renamed the vault', 'vault.rotate_key': 'rotated the vault key',
      'item.create': 'added', 'item.update': 'edited', 'item.delete': 'deleted an item',
      'member.add': 'shared with', 'member.remove': 'removed', 'member.role': 'changed role:', 'member.leave': 'left the vault',
    };
    const act = h('ul', { class: 'activity' }, activity.map((a) => h('li', {},
      `${new Date(a.at).toLocaleString()} · ${a.email ?? 'deleted user'} ${labels[a.action] ?? a.action} `,
      a.action.startsWith('item.') && a.action !== 'item.delete' ? (itemNames.get(a.target) ?? 'an item') :
        a.action.startsWith('member.') && a.action !== 'member.leave' ? (a.target ?? '') : '')));

    body.replaceChildren(
      h('h3', {}, 'People with access'),
      h('div', {}, memberRows),
      err,
      add,
      isOwner() && h('div', { class: 'row' },
        h('button', { class: 'btn sm', onclick: async () => {
          const name = prompt('Rename vault', v.name);
          if (!name?.trim()) return;
          try {
            await client.renameVault(v.id, name.trim());
            await refreshVaults();
            d.close();
            render();
          } catch (e2) { handleError(e2, err); }
        } }, 'Rename'),
        h('button', { class: 'btn sm danger', onclick: async () => {
          if (!confirm(`Permanently delete "${v.name}" and all ${v.itemCount} item(s) for everyone? This cannot be undone.`)) return;
          try {
            await client.deleteVault(v.id);
            d.close();
            state.vaultId = null;
            await enterApp();
          } catch (e2) { handleError(e2, err); }
        } }, 'Delete vault')),
      h('h3', {}, 'Activity'),
      act);
  }
  draw().catch((e) => handleError(e));
}

function addMemberForm(v, redraw, err) {
  const email = h('input', { type: 'email', placeholder: 'their account email', required: true });
  const role = h('select', {}, h('option', { value: 'viewer' }, 'viewer: can view'), h('option', { value: 'editor', selected: true }, 'editor: can edit'), h('option', { value: 'owner' }, 'owner: can manage sharing'));
  const step2 = h('div', { class: 'stack' });
  const find = h('button', { class: 'btn', type: 'submit' }, 'Find');
  return h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = '';
    await busy(find, async () => {
      try {
        const user = await client.lookupUser(email.value.trim());
        if (user.id === client.user.id) throw new Error('That is you.');
        const confirmBtn = h('button', { class: 'btn primary', type: 'button', onclick: async (ev) => {
          await busy(ev.currentTarget, async () => {
            try {
              await client.shareVault(v.id, user, role.value);
              toast(`Shared with ${user.email}`);
              await refreshVaults();
              await redraw();
            } catch (e2) { handleError(e2, err); }
          });
        } }, `Share with ${user.email}`);
        step2.replaceChildren(
          h('p', { class: 'small' }, 'Before sharing, confirm this fingerprint with them by phone, in person or on a trusted channel. They can see theirs under Account. If it doesn’t match, do not share.'),
          h('div', { class: 'fp-big' }, user.fingerprint),
          h('div', { class: 'row' }, confirmBtn, h('button', { class: 'btn', type: 'button', onclick: () => step2.replaceChildren() }, 'Cancel')));
      } catch (e2) { handleError(e2, err); }
    });
  } },
    h('h3', {}, 'Add someone'),
    h('p', { class: 'muted small' }, 'They need their own Vault account. You’ll share the vault’s key encrypted to their personal public key.'),
    h('div', { class: 'input-group' }, email, role, find),
    step2);
}

async function accountDialog() {
  const fp = await client.myFingerprint();
  const cur = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const nw = h('input', { type: 'password', autocomplete: 'new-password', required: true, minLength: 12 });
  const nw2 = h('input', { type: 'password', autocomplete: 'new-password', required: true });
  const err = h('p', { class: 'error', role: 'alert' });
  const save = h('button', { class: 'btn primary', type: 'submit' }, 'Change master password');
  const d = dialog(
    h('div', { class: 'row' }, h('h2', { class: 'spacer' }, 'Account'), h('button', { class: 'btn sm ghost', onclick: () => d.close(), 'aria-label': 'Close' }, '✕')),
    h('p', { class: 'muted' }, client.user.email),
    h('h3', {}, 'Your key fingerprint'),
    h('p', { class: 'muted small' }, 'When someone shares a vault with you, they should see exactly this fingerprint. Read it to them to confirm.'),
    h('div', { class: 'fp-big' }, fp),
    h('h3', {}, 'Change master password'),
    h('form', { class: 'stack', onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      if (nw.value.length < 12) return (err.textContent = 'Use at least 12 characters.');
      if (nw.value !== nw2.value) return (err.textContent = 'New passwords do not match.');
      await busy(save, async () => {
        try {
          await client.changePassword(cur.value, nw.value);
          d.close();
          toast('Master password changed. Other sessions were signed out.');
        } catch (e2) { handleError(e2, err); }
      });
    } },
      h('label', { class: 'field' }, 'Current master password', cur),
      h('label', { class: 'field' }, 'New master password', nw),
      h('label', { class: 'field' }, 'Confirm new master password', nw2),
      err,
      h('div', { class: 'dlg-foot' }, save)));
}

// ---------- boot ----------
(async () => {
  if (!globalThis.crypto?.subtle) {
    app.replaceChildren(h('main', { class: 'auth-wrap' }, h('div', { class: 'auth-card' },
      h('p', { class: 'notice warn' }, 'This page must be served over HTTPS (or localhost). The browser’s crypto API is unavailable.'))));
    return;
  }
  try {
    client.user = await client.me();
    renderUnlock();
  } catch {
    renderAuth('login');
  }
})();
