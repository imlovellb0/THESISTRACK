// Keeps an open conversation up to date: scrolls to the newest message and fetches new ones every few seconds.
(function () {
  var box = document.getElementById('thread');
  if (!box) return;
  var last = Number(box.getAttribute('data-last')) || 0;
  var timer = null;

  function down() { box.scrollTop = box.scrollHeight; }
  down();

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text; // text only, so a message can never run as markup
    return n;
  }

  function add(m) {
    var empty = document.getElementById('emptynote');
    if (empty) empty.remove();
    var wrap = el('div', 'msg' + (m.mine ? ' mine' : '') + (m.hidden ? ' hidden-msg' : ''));
    wrap.setAttribute('data-id', m.id);
    var meta = el('div', 'meta');
    meta.appendChild(el('b', null, m.sender));
    meta.appendChild(document.createTextNode(' '));
    meta.appendChild(el('span', 'muted', (m.role ? m.role + ' · ' : '') + m.when));
    wrap.appendChild(meta);
    wrap.appendChild(el('div', 'body', m.body));
    if (box.getAttribute('data-admin')) {
      var f = el('form');
      f.method = 'post';
      f.action = box.getAttribute('data-hide') + m.id;
      var t = el('input'); t.type = 'hidden'; t.name = '_csrf'; t.value = box.getAttribute('data-csrf');
      var b = el('button', 'linkbtn small', m.hidden ? 'Show again' : 'Hide'); b.type = 'submit';
      f.appendChild(t); f.appendChild(b);
      wrap.appendChild(f);
    }
    box.appendChild(wrap);
    last = Math.max(last, m.id);
  }

  function poll() {
    if (document.hidden) return;
    fetch(box.getAttribute('data-poll') + '?after=' + last, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : { items: [] }; })
      .then(function (data) {
        if (!data.items.length) return;
        var atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
        data.items.forEach(add);
        if (atBottom) down();
      })
      .catch(function () { /* offline: try again next time */ });
  }
  timer = setInterval(poll, 8000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });

  var ta = document.querySelector('.sendform textarea');
  if (ta) ta.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ta.form.requestSubmit(); }
  });
})();
