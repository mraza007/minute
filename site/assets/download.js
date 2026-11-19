// Minute runs only on macOS. On a Mac, point the download buttons at the
// visitor's chip. Anywhere else, turn them into a button that sends this
// page's link to the visitor's Mac, so nobody downloads a zip they cannot open.
(() => {
  const links = [...document.querySelectorAll('a[href*="/releases/download/"]')];
  if (!links.length) return;

  const ua = navigator.userAgent;
  if (/bot|crawler|spider/i.test(ua)) return;
  // iPadOS Safari reports itself as a Mac. A touch screen gives it away.
  const isMac = /Macintosh/.test(ua) && navigator.maxTouchPoints < 2;

  const armUrl = links.find((a) => a.href.includes('arm64'))?.href;
  const intelUrl = links.find((a) => a.href.includes('x86_64'))?.href;

  if (isMac) {
    // Chromium browsers can report the chip. Safari and Firefox cannot, so
    // they keep the Apple silicon default with the Intel build beside it.
    navigator.userAgentData?.getHighEntropyValues(['architecture']).then(({ architecture }) => {
      if (architecture !== 'x86' || !intelUrl) return;
      for (const a of links) {
        if (a.href === armUrl) {
          a.href = intelUrl;
          if (a.textContent.includes('Apple silicon')) a.textContent = 'Download for Intel Mac';
        } else {
          a.href = armUrl;
          a.textContent = 'Apple silicon build';
        }
      }
    }).catch(() => {});
    return;
  }

  const pageUrl = document.querySelector('link[rel="canonical"]')?.href || location.href;

  const flash = (button, text) => {
    const label = button.textContent;
    button.textContent = text;
    setTimeout(() => { button.textContent = label; }, 2000);
  };

  const sendLink = async (button) => {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Minute for Mac', url: pageUrl });
        window.plausible?.('Send link to Mac', { props: { method: 'share' } });
      } catch {
        // The visitor closed the share sheet. Nothing to do.
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(pageUrl);
      flash(button, 'Link copied');
      window.plausible?.('Send link to Mac', { props: { method: 'copy' } });
    } catch {
      location.href = `mailto:?subject=${encodeURIComponent('Minute for Mac')}&body=${encodeURIComponent(pageUrl)}`;
      window.plausible?.('Send link to Mac', { props: { method: 'email' } });
    }
  };

  for (const a of links) {
    // The Intel button is a second Mac download. One send button is enough.
    if (a.href === intelUrl && a.closest('.actions')) {
      a.remove();
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = a.className;
    button.textContent = a.classList.contains('btn--small') ? 'Send to my Mac' : 'Send the link to my Mac';
    button.addEventListener('click', () => sendLink(button));
    a.replaceWith(button);
  }

  for (const note of document.querySelectorAll('.actions + .hero__note')) {
    note.textContent = 'Minute is a Mac app (macOS 11 or later). Send yourself the link, then download it on your Mac.';
  }
})();
