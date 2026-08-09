const LOCAL = 'local';
const STORAGE_KEY = 'jb-time-zone';
const mountedFields = new Set();

function resolvedLocalTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
  catch (_) { return 'UTC'; }
}

function validTimeZone(value) {
  if (value === LOCAL) return true;
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return true; }
  catch (_) { return false; }
}

function preferredTimeZone() {
  try {
    var stored = localStorage.getItem(STORAGE_KEY);
    return stored && validTimeZone(stored) ? stored : LOCAL;
  } catch (_) { return LOCAL; }
}

function effectiveTimeZone() {
  var preferred = preferredTimeZone();
  return preferred === LOCAL ? resolvedLocalTimeZone() : preferred;
}

function inputParts(value, precision) {
  var match = precision === 'date'
    ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
    : /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  return {
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: precision === 'date' ? 0 : Number(match[4]),
    minute: precision === 'date' ? 0 : Number(match[5]),
  };
}

function partsAsUtc(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
}

function zonedParts(timestampMs, timeZone) {
  try {
    var values = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(timestampMs));
    function part(type) { var found = values.find(function (value) { return value.type === type; }); return Number(found && found.value); }
    var result = { year: part('year'), month: part('month'), day: part('day'), hour: part('hour'), minute: part('minute') };
    return Object.keys(result).every(function (key) { return isFinite(result[key]); }) ? result : null;
  } catch (_) { return null; }
}

function inputFromParts(parts, precision) {
  function pad(value) { return String(value).padStart(2, '0'); }
  var date = parts.year + '-' + pad(parts.month) + '-' + pad(parts.day);
  return precision === 'date' ? date : date + 'T' + pad(parts.hour) + ':' + pad(parts.minute);
}

/** Unix seconds → an input wall clock in the currently selected timezone. */
export function timestampToZonedInput(timestamp, precision) {
  if (!Number(timestamp)) return '';
  var parts = zonedParts(Number(timestamp) * 1000, effectiveTimeZone());
  return parts ? inputFromParts(parts, precision || 'datetime') : '';
}

/** Selected-timezone input wall clock → Unix seconds. */
export function zonedInputToTimestamp(value, precision) {
  var desired = inputParts(value, precision || 'datetime');
  if (!desired) return 0;
  var target = partsAsUtc(desired);
  var candidate = target;
  var timeZone = effectiveTimeZone();
  for (var attempt = 0; attempt < 4; attempt++) {
    var actual = zonedParts(candidate, timeZone);
    if (!actual) return 0;
    var delta = target - partsAsUtc(actual);
    if (delta === 0) return Math.floor(candidate / 1000);
    candidate += delta;
  }
  var finalParts = zonedParts(candidate, timeZone);
  return finalParts && partsAsUtc(finalParts) === target ? Math.floor(candidate / 1000) : 0;
}

function supportedTimeZones() {
  try { return typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []; }
  catch (_) { return []; }
}

function refreshMountedFields() {
  mountedFields.forEach(function (field) {
    if (!field.note.isConnected) { mountedFields.delete(field); return; }
    field.refresh();
  });
}

/**
 * Build the understated timezone subtext for a date/datetime input. The
 * callback keeps the displayed wall clock tied to its underlying Unix instant.
 */
export function timeZoneControl(input, options) {
  options = options || {};
  var precision = options.precision || (input.type === 'date' ? 'date' : 'datetime');
  var note = document.createElement('div'); note.className = 'time-zone-note';
  var text = document.createElement('span'); text.textContent = 'Time shown in'; note.appendChild(text);
  var select = document.createElement('select'); select.className = 'time-zone-select';
  select.setAttribute('aria-label', (options.label || 'Date and time') + ' timezone');
  note.appendChild(select);

  function addOption(value, label) {
    var option = document.createElement('option'); option.value = value; option.textContent = label; select.appendChild(option);
  }
  var local = resolvedLocalTimeZone();
  addOption(LOCAL, local + ' (local)');
  if (local !== 'UTC') addOption('UTC', 'UTC');
  supportedTimeZones().forEach(function (zone) {
    if (zone !== local && zone !== 'UTC') addOption(zone, zone.replaceAll('_', ' '));
  });

  var field = {
    note: note,
    refresh: function () {
      select.value = preferredTimeZone();
      var timestamp = Number(options.getTimestamp && options.getTimestamp());
      if (timestamp > 0) input.value = timestampToZonedInput(timestamp, precision);
      if (options.getMinTimestamp) {
        var minimum = Number(options.getMinTimestamp());
        input.min = minimum > 0 ? timestampToZonedInput(minimum, precision) : '';
      }
    },
  };
  mountedFields.add(field);
  select.addEventListener('change', function () {
    var next = validTimeZone(select.value) ? select.value : LOCAL;
    try { localStorage.setItem(STORAGE_KEY, next); } catch (_) {}
    refreshMountedFields();
  });
  field.refresh();
  return note;
}

export const __test = {
  resolvedLocalTimeZone,
  timestampToZonedInput,
  zonedInputToTimestamp,
};
