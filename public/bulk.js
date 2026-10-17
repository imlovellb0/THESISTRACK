// Tick accounts, then act on all of them at once. The tick boxes stay hidden until Select is tapped.
// A Select button works on its own list (the nearest [data-selscope]), or on the whole page when there is none.
(function () {
  var form = document.getElementById('bulkform');
  if (!form) return;
  var count = document.getElementById('bulkcount');
  var all = function (root) { return Array.prototype.slice.call(root.querySelectorAll('input[name="ids"][form="bulkform"]')); };
  var visible = function (b) { return !b.closest('tr').hidden; };
  var tools = Array.prototype.slice.call(document.querySelectorAll('.seltool')).map(function (t) {
    return { scope: t.closest('[data-selscope]') || document.body, btn: t.querySelector('.selbtn'), allBtn: t.querySelector('.selallbtn') };
  });

  function refresh() {
    var n = all(document).filter(function (b) { return b.checked && visible(b); }).length;
    count.textContent = n + (n === 1 ? ' account' : ' accounts') + ' selected';
    form.hidden = n === 0;
    tools.forEach(function (t) {
      var rows = all(t.scope).filter(visible);
      t.allBtn.textContent = rows.length > 0 && rows.every(function (b) { return b.checked; }) ? 'Clear selection' : 'Select all';
    });
    document.querySelectorAll('.selall').forEach(function (head) {
      var rows = all(head.closest('table')).filter(visible);
      head.checked = rows.length > 0 && rows.every(function (b) { return b.checked; });
    });
  }

  tools.forEach(function (t) {
    t.btn.addEventListener('click', function () {
      var on = !t.scope.classList.contains('selecting');
      t.scope.classList.toggle('selecting', on);
      t.btn.textContent = on ? 'Cancel' : 'Select';
      t.btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      t.allBtn.hidden = !on;
      if (!on) all(t.scope).forEach(function (b) { b.checked = false; });
      refresh();
    });
    t.allBtn.addEventListener('click', function () {
      var rows = all(t.scope).filter(visible);
      var every = rows.length > 0 && rows.every(function (b) { return b.checked; });
      rows.forEach(function (b) { b.checked = !every; });
      refresh();
    });
  });

  document.addEventListener('change', function (e) {
    if (e.target.classList.contains('selall')) {
      all(e.target.closest('table')).forEach(function (b) { if (visible(b)) b.checked = e.target.checked; });
    }
    refresh();
  });
  document.addEventListener('input', function (e) { if (e.target.matches('input[data-filter]')) refresh(); });

  form.addEventListener('submit', function (e) {
    var action = e.submitter && e.submitter.value;
    var n = all(document).filter(function (b) { return b.checked && visible(b); }).length;
    var ask = {
      remove: 'Permanently remove ' + n + ' account(s)? This cannot be undone. Accounts with thesis work are skipped; deactivate those instead.',
      deactivate: 'Deactivate ' + n + ' account(s)? They will not be able to sign in.'
    }[action];
    if (ask && !confirm(ask)) { e.preventDefault(); return; }
    all(document).forEach(function (b) { if (!visible(b)) b.disabled = true; }); // ticked rows hidden by the search are left out
  });
  refresh();
})();
