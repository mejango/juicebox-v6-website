// src/components.js
// Style editor for the embeddable Action widgets (live CSS-var tuning + persistence).
// The old COMPONENTS-tab renderer was removed — the Actions tab renders widgets directly.

var STYLE_STORAGE_KEY = 'jb-component-style';

function loadSavedStyle() {
  try {
    var raw = localStorage.getItem(STYLE_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch(e) { return {}; }
}

function saveStyle(vars) {
  try {
    localStorage.setItem(STYLE_STORAGE_KEY, JSON.stringify(vars));
  } catch(e) {}
}

function clearSavedStyle() {
  try { localStorage.removeItem(STYLE_STORAGE_KEY); } catch(e) {}
}

export function renderStyleEditor(target, onClose) {
  var panel = document.createElement('div');
  panel.className = 'style-editor';

  // Close button
  var closeBtn = document.createElement('button');
  closeBtn.className = 'style-editor-close';
  closeBtn.textContent = '\u00d7';
  closeBtn.addEventListener('click', function() {
    if (onClose) onClose();
  });
  panel.appendChild(closeBtn);

  // Track custom values for export — seed from localStorage
  var customVars = loadSavedStyle();

  // Apply any saved vars to target on editor open
  var savedKeys = Object.keys(customVars);
  for (var sk = 0; sk < savedKeys.length; sk++) {
    target.style.setProperty(savedKeys[sk], customVars[savedKeys[sk]]);
  }

  var sections = [
    { heading: 'Typography', controls: [
      { label: 'font',        prop: '--c-font',        type: 'select', options: [
        { label: 'monospace', value: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' },
        { label: 'sans-serif', value: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' },
        { label: 'serif', value: 'Georgia, "Times New Roman", Times, serif' },
        { label: 'comic sans', value: '"Comic Sans MS", "Comic Sans", cursive' },
        { label: 'pixel', value: '"Courier New", Courier, monospace' },
      ], initial: 0 },
      { label: 'label size',  prop: '--c-label-size',  type: 'range', min: 8, max: 18, initial: 12, unit: 'px' },
      { label: 'body size',   prop: '--c-body-size',   type: 'range', min: 8, max: 16, initial: 12, unit: 'px' },
    ]},
    { heading: 'Colors', controls: [
      { label: 'background',  prop: '--c-bg',          type: 'color', initial: '#fcd0c2' },
      { label: 'text',        prop: '--c-text',        type: 'color', initial: '#2c2018' },
      { label: 'accent',      prop: '--c-accent',      type: 'color', initial: '#c43550' },
      { label: 'border',      prop: '--c-border',      type: 'color', initial: '#eda3b0' },
      { label: 'input bg',    prop: '--c-input-bg',    type: 'color', initial: '#f6c9c0' },
    ]},
    { heading: 'Layout', controls: [
      { label: 'radius',      prop: '--c-radius',      type: 'range', min: 0, max: 20, initial: 3, unit: 'px' },
      { label: 'padding',     prop: '--c-padding',     type: 'range', min: 4, max: 32, initial: 14, unit: 'px' },
      { label: 'max width',   prop: '--c-max-width',   type: 'range', min: 280, max: 800, initial: 520, unit: 'px' },
      { label: 'border width',prop: '--c-border-width',type: 'range', min: 0, max: 4, initial: 1, unit: 'px' },
    ]},
  ];

  var grid = document.createElement('div');
  grid.className = 'style-editor-grid';

  function applyVar(prop, val) {
    target.style.setProperty(prop, val);
    customVars[prop] = val;
    saveStyle(customVars);
  }

  for (var s = 0; s < sections.length; s++) {
    var sec = sections[s];
    var secHeading = document.createElement('div');
    secHeading.className = 'style-editor-section';
    secHeading.textContent = sec.heading;
    if (s === 0) secHeading.style.borderTop = 'none';
    grid.appendChild(secHeading);

    for (var i = 0; i < sec.controls.length; i++) {
      (function(ctrl) {
        var row = document.createElement('div');
        row.className = 'style-editor-row';

        var lbl = document.createElement('label');
        lbl.className = 'style-editor-label';
        lbl.textContent = ctrl.label;
        row.appendChild(lbl);

        var savedVal = customVars[ctrl.prop];

        if (ctrl.type === 'color') {
          var group = document.createElement('div');
          group.className = 'style-editor-color-group';

          var colorInit = savedVal || ctrl.initial;
          var picker = document.createElement('input');
          picker.type = 'color';
          picker.className = 'style-editor-color';
          picker.value = colorInit;

          var hex = document.createElement('input');
          hex.type = 'text';
          hex.className = 'style-editor-hex';
          hex.value = colorInit;
          hex.maxLength = 7;
          hex.placeholder = '#000000';

          picker.addEventListener('input', function() {
            hex.value = picker.value;
            applyVar(ctrl.prop, picker.value);
          });
          hex.addEventListener('input', function() {
            var v = hex.value.trim();
            if (/^#[0-9a-fA-F]{6}$/.test(v)) {
              picker.value = v;
              applyVar(ctrl.prop, v);
            }
          });
          hex.addEventListener('blur', function() {
            var v = hex.value.trim();
            if (/^#[0-9a-fA-F]{3}$/.test(v)) {
              var expanded = '#' + v[1]+v[1] + v[2]+v[2] + v[3]+v[3];
              hex.value = expanded;
              picker.value = expanded;
              applyVar(ctrl.prop, expanded);
            }
          });

          group.appendChild(picker);
          group.appendChild(hex);
          row.appendChild(group);
        } else if (ctrl.type === 'range') {
          var rangeInit = savedVal ? parseInt(savedVal) : ctrl.initial;
          var valSpan = document.createElement('span');
          valSpan.className = 'style-editor-value';
          valSpan.textContent = rangeInit + ctrl.unit;

          var slider = document.createElement('input');
          slider.type = 'range';
          slider.className = 'style-editor-range';
          slider.min = ctrl.min;
          slider.max = ctrl.max;
          slider.value = rangeInit;
          slider.addEventListener('input', function() {
            var val = slider.value + ctrl.unit;
            applyVar(ctrl.prop, val);
            valSpan.textContent = val;
          });
          row.appendChild(slider);
          row.appendChild(valSpan);
        } else if (ctrl.type === 'select') {
          var sel = document.createElement('select');
          sel.className = 'style-editor-select';
          for (var j = 0; j < ctrl.options.length; j++) {
            var opt = document.createElement('option');
            opt.value = ctrl.options[j].value;
            opt.textContent = ctrl.options[j].label;
            if (savedVal ? opt.value === savedVal : j === ctrl.initial) opt.selected = true;
            sel.appendChild(opt);
          }
          sel.addEventListener('change', function() {
            applyVar(ctrl.prop, sel.value);
          });
          row.appendChild(sel);
        } else if (ctrl.type === 'text') {
          var textInput = document.createElement('input');
          textInput.type = 'text';
          textInput.className = 'style-editor-hex';
          textInput.value = savedVal || ctrl.initial;
          textInput.placeholder = ctrl.label;
          textInput.style.width = '100px';
          textInput.addEventListener('input', function() {
            applyVar(ctrl.prop, textInput.value);
            // Also update the component title text if it exists
            var titleEl = target.closest('.fn-expanded-content');
            if (titleEl) {
              var titleSpan = titleEl.querySelector('.fn-component-title');
              if (titleSpan && textInput.value) titleSpan.textContent = textInput.value;
            }
          });
          row.appendChild(textInput);
        }

        grid.appendChild(row);
      })(sec.controls[i]);
    }
  }
  panel.appendChild(grid);

  // Reset link
  var resetLink = document.createElement('button');
  resetLink.type = 'button';
  resetLink.className = 'style-editor-reset';
  resetLink.textContent = '[reset]';
  resetLink.addEventListener('click', function(e) {
    e.preventDefault();
    for (var k in customVars) {
      target.style.removeProperty(k);
    }
    customVars = {};
    clearSavedStyle();
    var parent = panel.parentNode;
    var oldClass = panel.className;
    var newEditor = renderStyleEditor(target, onClose);
    newEditor.className = oldClass;
    parent.replaceChild(newEditor, panel);
  });
  panel.appendChild(resetLink);

  return panel;
}
