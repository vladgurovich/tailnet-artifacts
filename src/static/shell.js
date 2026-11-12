// Viewer shell: version switching and live reload when a new version is published.
(() => {
  const shell = document.getElementById('shell');
  const frame = document.getElementById('frame');
  const select = document.getElementById('ver');
  const live = document.getElementById('live');
  const toast = document.getElementById('toast');
  const id = shell.dataset.id;
  const base = shell.dataset.versionBase;
  let follow = shell.dataset.follow === '1';
  let current = Number(shell.dataset.current);

  live.hidden = !follow;

  function show(n) {
    frame.src = `${base}${n}/`;
    select.value = String(n);
    const url = new URL(location.href);
    if (follow) url.searchParams.delete('v');
    else url.searchParams.set('v', String(n));
    history.replaceState(null, '', url);
  }

  function notify(text) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(notify.t);
    notify.t = setTimeout(() => { toast.hidden = true; }, 3500);
  }

  select.addEventListener('change', () => {
    const n = Number(select.value);
    follow = n === current;
    live.hidden = !follow;
    show(n);
  });

  function addOption(n) {
    for (const o of select.options) if (o.value !== String(n)) o.textContent = `v${o.value}`;
    const o = new Option(`v${n} (latest)`, String(n));
    select.insertBefore(o, select.firstChild);
  }

  let retry = 1000;
  function connect() {
    const es = new EventSource(`/api/artifacts/${encodeURIComponent(id)}/events`);
    es.addEventListener('open', () => { retry = 1000; });
    es.addEventListener('published', (e) => {
      const { version } = JSON.parse(e.data);
      if (version <= current) return;
      current = version;
      addOption(version);
      if (follow) {
        show(version);
        notify(`Updated to v${version}`);
      } else {
        notify(`v${version} published — select it to view`);
      }
    });
    es.addEventListener('removed', () => {
      es.close();
      location.reload();
    });
    es.addEventListener('error', () => {
      es.close();
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 30000);
    });
  }
  connect();
})();
