// Which Solana network this server is on. Pages read it from /api/launch/config, so links and wording
// follow the server's setting. Until it loads, it assumes devnet (the safe, play-money default).
(function () {
  const net = {
    cluster: 'devnet',
    main: false,
    name: 'devnet',
    suffix: '?cluster=devnet',
    // dial.to needs the cluster for devnet only.
    dialSuffix: '&cluster=devnet',
    apply: function (cluster) {
      net.cluster = cluster === 'mainnet-beta' ? 'mainnet-beta' : 'devnet';
      net.main = net.cluster === 'mainnet-beta';
      net.name = net.main ? 'Solana' : 'devnet';
      net.suffix = net.main ? '' : '?cluster=devnet';
      net.dialSuffix = net.main ? '' : '&cluster=devnet';
      try {
        document.querySelectorAll('[data-net="name"]').forEach(function (el) { el.textContent = net.name; });
        document.querySelectorAll('[data-net-only]').forEach(function (el) { el.hidden = el.getAttribute('data-net-only') !== net.cluster; });
      } catch (e) { /* page without these */ }
    }
  };
  net.ready = fetch('/api/launch/config', { headers: { Accept: 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : {}; })
    .then(function (c) { net.apply(c && c.cluster); return net; })
    .catch(function () { net.apply('devnet'); return net; });
  window.AnimalNet = net;
})();
