// Small DOM helpers: element builder, toasts, in-page dialogs (no native prompt/confirm) and file pickers.

export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k === 'value') n.value = v;
    else if (v === true) n.setAttribute(k, '');
    else n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(c instanceof Node ? c : String(c));
  return n;
}

export const button = (label, onclick, attrs = {}) => el('button', { type: 'button', class: 'btn', onclick, ...attrs }, label);

export function toast(message, kind = 'info', ms = kind === 'error' ? 8000 : 4000) {
  const host = document.getElementById('toasts');
  const t = el('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  host.append(t);
  setTimeout(() => t.remove(), ms);
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/** @returns {Promise<File[]>} */
export function pickFiles({ multiple = false, accept = '', directory = false } = {}) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', multiple, accept: accept || null, webkitdirectory: directory, hidden: true });
    input.addEventListener('change', () => {
      resolve([...input.files]);
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve([]);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

function openDialog(build) {
  return new Promise((resolve) => {
    const dlg = el('dialog', { class: 'dialog' });
    const done = (value) => {
      dlg.close();
      dlg.remove();
      resolve(value);
    };
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      done(null);
    });
    build(dlg, done);
    document.body.append(dlg);
    dlg.showModal();
    dlg.querySelector('[autofocus]')?.focus();
  });
}

/** Ask for a line of text. Resolves to the string, or null when cancelled. */
export function ask(title, value = '', okLabel = 'OK') {
  return openDialog((dlg, done) => {
    const input = el('input', { type: 'text', class: 'input', value, autofocus: true, spellcheck: 'false', 'aria-label': title });
    const form = el(
      'form',
      { method: 'dialog', onsubmit: (e) => (e.preventDefault(), done(input.value)) },
      el('h2', { class: 'dialog-title' }, title),
      input,
      el('div', { class: 'dialog-actions' }, button('Cancel', () => done(null)), el('button', { type: 'submit', class: 'btn btn-primary' }, okLabel)),
    );
    dlg.append(form);
    setTimeout(() => input.select(), 0);
  });
}

/** Yes/no question. Resolves to true or false. */
export function confirmBox(message, okLabel = 'OK', danger = false) {
  return openDialog((dlg, done) => {
    dlg.append(
      el('p', { class: 'dialog-text' }, message),
      el(
        'div',
        { class: 'dialog-actions' },
        button('Cancel', () => done(false)),
        button(okLabel, () => done(true), { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, autofocus: true }),
      ),
    );
  }).then((v) => v === true);
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
