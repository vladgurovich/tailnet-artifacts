// Gallery + info page behaviour: relative times and owner actions.
(() => {
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const UNITS = [['year', 31536e6], ['month', 2592e6], ['week', 6048e5], ['day', 864e5], ['hour', 36e5], ['minute', 6e4]];
  function rel(ms) {
    const d = ms - Date.now();
    for (const [u, size] of UNITS) if (Math.abs(d) >= size) return rtf.format(Math.round(d / size), u);
    return d > 0 ? 'in under a minute' : 'just now';
  }
  function refreshTimes() {
    for (const t of document.querySelectorAll('time[data-rel]')) {
      const ms = Date.parse(t.dateTime);
      if (!Number.isNaN(ms)) {
        t.textContent = rel(ms);
        t.title = new Date(ms).toLocaleString();
      }
    }
  }
  refreshTimes();
  setInterval(refreshTimes, 60e3);

  async function act(id, action) {
    const opts = { method: 'POST', headers: { 'X-Artifacts-Csrf': '1', 'Content-Type': 'application/json' } };
    let url = `/api/artifacts/${encodeURIComponent(id)}`;
    if (action === 'delete') opts.method = 'DELETE';
    else if (action === 'pin' || action === 'unpin') { url += '/pin'; opts.body = JSON.stringify({ pinned: action === 'pin' }); }
    else if (action === 'extend') { url += '/extend'; opts.body = JSON.stringify({ ttl: '7d' }); }
    const res = await fetch(url, opts);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${res.status}`);
    }
  }

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.closest('[data-id]')?.dataset.id;
    const action = btn.dataset.action;
    if (!id) return;
    if (action === 'delete' && !btn.classList.contains('armed')) {
      btn.classList.add('armed');
      btn.textContent = 'Confirm delete';
      setTimeout(() => { btn.classList.remove('armed'); btn.textContent = 'Delete'; }, 4000);
      return;
    }
    btn.disabled = true;
    try {
      await act(id, action);
      if (action === 'delete' && location.pathname !== '/') location.href = '/';
      else location.reload();
    } catch (err) {
      btn.disabled = false;
      btn.title = err.message;
      btn.textContent = 'Failed';
    }
  });
})();
