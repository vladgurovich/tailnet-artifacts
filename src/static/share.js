// Share buttons (gallery and viewer): the system share sheet where the browser has
// one (Web Share API), otherwise copy the link. Also picks the platform's share icon.
(() => {
  const apple = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
  document.documentElement.classList.toggle('apple', apple);

  function toast(message) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = message;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 2500);
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Older browsers / non-secure contexts.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { /* unsupported */ }
      ta.remove();
      return ok;
    }
  }

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-share-url]');
    if (!btn) return;
    const url = btn.dataset.shareUrl;
    const title = btn.dataset.shareTitle;
    if (navigator.share) {
      try {
        await navigator.share({ title, url });
        return;
      } catch (err) {
        if (err.name === 'AbortError') return; // the user closed the share sheet
        // Anything else (e.g. not allowed here): fall back to copying.
      }
    }
    toast((await copy(url)) ? 'Link copied' : url);
  });
})();
