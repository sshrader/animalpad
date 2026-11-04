/* Page chrome: the step rail, example prompts, and tinting the stage with the animal's own colour.
   Nothing here talks to the server or the wallet. */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);

  // Dark is the default. The switch remembers the choice on this device when the browser allows it.
  const root = document.documentElement;
  function setTheme(light) {
    if (light) root.dataset.theme = 'light'; else delete root.dataset.theme;
    $('theme').setAttribute('aria-label', light ? 'Switch to dark mode' : 'Switch to light mode');
    $('theme').setAttribute('aria-pressed', light ? 'true' : 'false');
    try { localStorage.setItem('animalpad-theme', light ? 'light' : 'dark'); } catch (e) { /* not saved, still works */ }
  }
  $('theme').addEventListener('click', () => setTheme(root.dataset.theme !== 'light'));
  $('theme').setAttribute('aria-pressed', root.dataset.theme === 'light' ? 'true' : 'false');
  if (root.dataset.theme === 'light') $('theme').setAttribute('aria-label', 'Switch to dark mode');

  function step(n) { document.body.dataset.step = String(n); }
  document.addEventListener('animalpad:staged', () => step(2));
  document.addEventListener('animalpad:launched', () => step(3));
  document.addEventListener('animalpad:reset', () => step(1));

  // Example prompts fill the box so a new visitor does not face a blank field.
  $('examples').addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('.eg');
    if (!b) return;
    $('a-prompt').value = b.textContent;
    $('a-prompt').focus();
  });

  // Picks a hue from the picture: the average hue of its colourful pixels, ignoring greys, whites and darks.
  function hueOf(img) {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 48;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0, 48, 48);
      const d = g.getImageData(0, 0, 48, 48).data;
      let x = 0, y = 0, w = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i] / 255, gr = d[i + 1] / 255, b = d[i + 2] / 255;
        const max = Math.max(r, gr, b), min = Math.min(r, gr, b), l = (max + min) / 2, ch = max - min;
        if (ch < 0.18 || l < 0.15 || l > 0.9) continue;
        let h = max === r ? ((gr - b) / ch) % 6 : max === gr ? (b - r) / ch + 2 : (r - gr) / ch + 4;
        h *= 60; if (h < 0) h += 360;
        const wt = ch; // more colourful pixels count more
        x += Math.cos(h * Math.PI / 180) * wt; y += Math.sin(h * Math.PI / 180) * wt; w += wt;
      }
      if (w < 3) return null;
      let hue = Math.atan2(y, x) * 180 / Math.PI;
      if (hue < 0) hue += 360;
      return Math.round(hue);
    } catch (err) { return null; } // a picture that cannot be read just keeps the default colour
  }

  const img = $('a-img');
  img.addEventListener('load', () => {
    const h = hueOf(img);
    if (h === null) $('stage').style.removeProperty('--hue'); else $('stage').style.setProperty('--hue', String(h));
  });
})();
