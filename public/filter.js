// Type in a box with data-filter="#table-id" to hide the table rows that do not contain the text.
(function () {
  document.querySelectorAll('input[data-filter]').forEach(function (box) {
    var tables = document.querySelectorAll(box.getAttribute('data-filter'));
    if (!tables.length) return;
    box.addEventListener('input', function () {
      var q = box.value.trim().toLowerCase();
      tables.forEach(function (table) {
        table.querySelectorAll('tbody tr').forEach(function (tr) {
          tr.hidden = q !== '' && tr.textContent.toLowerCase().indexOf(q) === -1;
        });
      });
    });
  });
})();
