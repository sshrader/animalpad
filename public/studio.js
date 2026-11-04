/* Animal studio, page side. Describe an animal, get a logo plus a suggested name, ticker and
   description from the server, then accept it or try again. Accepting hands the result to the
   launch step. The OpenAI key never reaches the page. */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  let current = null; // the result being reviewed
  let busy = false;
  let enabled = false;

  const WHY = {
    bad_prompt: 'Describe the animal in a few words, like "a tired heron in a tiny crown".',
    blocked_prompt: 'That names a real character, brand or person. Describe an original animal instead.',
    rate_limited: 'That is a lot of animals for one hour. Take a break and try again soon.',
    daily_limit: 'The studio is out of animals for today. Try again tomorrow.',
    art_unavailable: 'The animal studio is not switched on for this site.',
    generation_failed: 'The studio could not make that one. Try again, or change the description.'
  };

  function say(text, bad) {
    const el = $('a-status');
    el.textContent = text;
    el.className = 'status' + (bad ? ' bad' : '');
  }

  function render() {
    $('studio').hidden = !enabled;
    $('a-gen').disabled = busy;
    $('a-redo').disabled = busy;
    $('a-accept').disabled = busy;
    $('a-card').hidden = !current;
    if (current) {
      $('a-img').src = current.imageUrl;
      $('a-desc').textContent = current.description;
    }
  }

  async function generate() {
    const animal = $('a-prompt').value.trim();
    if (animal.length < 3) { say(WHY.bad_prompt, true); return; }
    busy = true; render();
    say('Drawing your animal. This takes about half a minute…');
    document.dispatchEvent(new CustomEvent('animalpad:reset'));
    try {
      const res = await fetch('/api/art/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ animal: animal })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || typeof data.id !== 'string') {
        say(WHY[data && data.error] || 'Something went wrong. Try again.', true);
      } else {
        current = data;
        $('a-name').value = data.name;
        $('a-sym').value = data.ticker;
        say('Here it is. Accept it, or reject it and try again.');
      }
    } catch (err) {
      say('Could not reach the studio. Try again.', true);
    }
    busy = false; render();
  }

  function accept() {
    if (!current) return;
    const name = $('a-name').value.replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
    const sym = $('a-sym').value.replace(/^\$/, '').trim().toUpperCase();
    if (!name || name.length > 32) { say('Give it a name up to 32 characters.', true); return; }
    if (!/^[A-Z0-9]{1,10}$/.test(sym)) { say('The ticker needs 1 to 10 letters or digits.', true); return; }
    say('Accepted ✓ Next: launch it on devnet.');
    document.dispatchEvent(new CustomEvent('animalpad:staged', { detail: { name: name, symbol: sym, preset: 'standard', art: current.id } }));
    $('launch').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function reject() {
    current = null;
    say('');
    document.dispatchEvent(new CustomEvent('animalpad:reset'));
    render();
    generate();
  }

  $('a-gen').addEventListener('click', generate);
  $('a-prompt').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); generate(); } });
  $('a-accept').addEventListener('click', accept);
  $('a-redo').addEventListener('click', reject);

  fetch('/api/art/config', { headers: { Accept: 'application/json' } })
    .then(r => r.json())
    .then(info => { enabled = Boolean(info && info.enabled); render(); })
    .catch(() => { enabled = false; render(); });
  render();
})();

// Copy buttons on the mint and pool addresses.
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('.ca-copy');
  if (!b) return;
  const text = b.dataset.ca || '';
  const done = ok => { const old = b.textContent; b.textContent = ok ? 'Copied' : 'Select + copy'; setTimeout(() => { b.textContent = 'Copy'; }, 1400); };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => done(true), () => done(false));
  else done(false);
});
