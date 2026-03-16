'use strict';

const obsidian = require('obsidian');

const VIEW_TYPE = 'event-inline-view';
const EVENT_FOLDER = 'events';
const TASK_RE = /^([\s]*[-*+])\s\[(.)\]\s+(.+)$/;
const FIELD_RE = /\[(\w+)::\s*([^\]]+)\]/g;
const DATE_FIELDS = ['date', 'start', 'end'];
const COMPLETED_DAYS = 7;
const DAY_NAMES = ['\uC77C', '\uC6D4', '\uD654', '\uC218', '\uBAA9', '\uAE08', '\uD1A0'];

// ─── Helpers ────────────────────────────────────────────────

function today() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function getDayName(dateStr) {
  if (!dateStr) return '';
  var parts = dateStr.split('-');
  var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  return DAY_NAMES[d.getDay()];
}

function formatTime(task) {
  var start = task.fields.start;
  var end = task.fields.end;
  if (start && end) return start + ' - ' + end;
  if (start) return start + ' ~';
  return '';
}

function parseTask(line, lineNum, filePath) {
  const m = line.match(TASK_RE);
  if (!m) return null;
  const prefix = m[1];
  const status = m[2];
  const rest = m[3];
  const fields = {};
  let match;
  const re = new RegExp(FIELD_RE.source, 'g');
  while ((match = re.exec(rest)) !== null) {
    fields[match[1]] = match[2].trim();
  }
  const desc = rest.replace(FIELD_RE, '').trim();
  return { prefix, status, desc, fields, filePath, lineNum, raw: line };
}

function parseTasks(content, filePath) {
  const lines = content.split('\n');
  const tasks = [];
  for (let i = 0; i < lines.length; i++) {
    const t = parseTask(lines[i], i, filePath);
    if (t) tasks.push(t);
  }
  return tasks;
}

function taskToLine(task) {
  let line = (task.prefix || '-') + ' [' + task.status + '] ' + task.desc;
  for (const key of DATE_FIELDS) {
    if (task.fields[key]) {
      line += ' [' + key + ':: ' + task.fields[key] + ']';
    }
  }
  for (const key of Object.keys(task.fields)) {
    if (!DATE_FIELDS.includes(key)) {
      line += ' [' + key + ':: ' + task.fields[key] + ']';
    }
  }
  return line;
}

function isWithinDays(dateStr, days) {
  if (!dateStr) return false;
  const parts = dateStr.split('-');
  const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  const now = new Date();
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
  return d >= cutoff;
}

function isOverdue(task) {
  var date = task.fields.date;
  if (!date) return false;
  return date < today();
}

// ─── EventRenderer ──────────────────────────────────────────

class EventRenderer {
  constructor(app) {
    this.app = app;
    this.isUpdating = false;
  }

  async loadAllTasks() {
    const folder = this.app.vault.getAbstractFileByPath(EVENT_FOLDER);
    if (!folder || !(folder instanceof obsidian.TFolder)) return [];
    const files = [];
    obsidian.Vault.recurseChildren(folder, (f) => {
      if (f instanceof obsidian.TFile && f.extension === 'md') {
        files.push(f);
      }
    });
    const allTasks = [];
    for (const file of files) {
      const content = await this.app.vault.cachedRead(file);
      const tasks = parseTasks(content, file.path);
      allTasks.push(...tasks);
    }
    return allTasks;
  }

  async render(container) {
    const allTasks = await this.loadAllTasks();
    const pending = allTasks.filter(function(t) { return t.status === ' '; });
    const done = allTasks.filter(function(t) {
      return t.status === 'x' && isWithinDays(t.fields.date, COMPLETED_DAYS);
    });

    pending.sort(function(a, b) {
      var dateA = a.fields.date || '9999';
      var dateB = b.fields.date || '9999';
      if (dateA !== dateB) return dateA.localeCompare(dateB);
      var startA = a.fields.start || '99:99';
      var startB = b.fields.start || '99:99';
      return startA.localeCompare(startB);
    });

    done.sort(function(a, b) {
      return (b.fields.date || '').localeCompare(a.fields.date || '');
    });

    var scrollTop = container.scrollTop;
    container.empty();
    container.addClass('event-inline-view');

    this.renderGroupedSection(container, '\uC608\uC815', pending);
    this.renderSection(container, '\uC644\uB8CC', done);

    container.scrollTop = scrollTop;
  }

  renderGroupedSection(container, title, tasks) {
    container.createEl('h2', { text: title });
    var self = this;

    if (tasks.length > 0) {
      var groups = {};
      var order = [];
      for (var i = 0; i < tasks.length; i++) {
        var key = tasks[i].fields.date || '';
        if (!groups[key]) {
          groups[key] = [];
          order.push(key);
        }
        groups[key].push(tasks[i]);
      }

      for (var i = 0; i < order.length; i++) {
        var key = order[i];
        var label = key ? key + ' (' + getDayName(key) + ')' : '\uB0A0\uC9DC \uC5C6\uC74C';
        container.createEl('div', { cls: 'event-inline-date-group', text: label });
        var groupTasks = groups[key];
        for (var j = 0; j < groupTasks.length; j++) {
          this.renderEvent(container, groupTasks[j]);
        }
      }
    }

    // Add event row
    var addRow = container.createDiv({ cls: 'event-inline-item event-inline-add-row' });
    addRow.createEl('span', { cls: 'event-inline-status-btn event-inline-add-circle' });
    var addPlaceholder = addRow.createEl('span', {
      cls: 'event-inline-add-placeholder',
      text: '\uC774\uBCA4\uD2B8\uB97C \uC785\uB825\uD558\uC138\uC694...',
    });
    addRow.addEventListener('click', function() {
      if (addRow.querySelector('.event-inline-add-input')) return;
      addPlaceholder.style.display = 'none';
      var input = addRow.createEl('input', {
        cls: 'event-inline-add-input',
        type: 'text',
        attr: { placeholder: '\uC774\uBCA4\uD2B8\uB97C \uC785\uB825\uD558\uC138\uC694...' },
      });
      input.focus();
      var save = function() {
        var desc = input.value.trim();
        input.remove();
        addPlaceholder.style.display = '';
        if (desc) {
          self.addEvent(desc);
        }
      };
      input.addEventListener('blur', save);
      input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { input.value = ''; input.blur(); }
      });
    });
  }

  renderSection(container, title, tasks) {
    container.createEl('h2', { text: title });
    if (tasks.length === 0) return;
    for (var i = 0; i < tasks.length; i++) {
      this.renderEvent(container, tasks[i]);
    }
  }

  renderEvent(container, task) {
    var isDone = task.status === 'x';
    var overdue = !isDone && isOverdue(task);
    var self = this;

    var row = container.createDiv({
      cls: 'event-inline-item'
        + (isDone ? ' is-done' : '')
        + (overdue ? ' event-inline-item-overdue' : '')
    });

    // Status button
    var statusIcons = { ' ': '', 'x': '\u2713' };
    var statusBtn = row.createEl('button', {
      cls: 'event-inline-status-btn',
      text: statusIcons[task.status] || '',
    });
    statusBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      var newStatus = task.status === 'x' ? ' ' : 'x';
      self.updateTaskStatus(task, newStatus);
    });

    // Description
    var descEl = row.createEl('span', {
      cls: 'event-inline-item-desc',
      text: task.desc,
    });
    if (!isDone) {
      descEl.setAttribute('contenteditable', 'true');
    }

    var originalDesc = task.desc;
    descEl.addEventListener('focus', function() { originalDesc = descEl.textContent; });
    descEl.addEventListener('blur', function() {
      var newDesc = descEl.textContent.trim();
      if (newDesc && newDesc !== originalDesc) {
        self.updateTaskDesc(task, newDesc);
      } else if (!newDesc) {
        descEl.textContent = originalDesc;
      }
    });
    descEl.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { e.preventDefault(); descEl.blur(); }
      if (e.key === 'Escape') { descEl.textContent = originalDesc; descEl.blur(); }
    });

    // Right area: time + date
    var datesEl = row.createDiv({ cls: 'event-inline-item-dates' });

    if (isDone) {
      if (task.fields.date) {
        var timeStr = formatTime(task);
        var dateEl = datesEl.createDiv({ cls: 'event-inline-item-date' });
        dateEl.createEl('span', {
          cls: 'event-inline-item-date-value',
          text: task.fields.date + (timeStr ? ' ' + timeStr : ''),
        });
      }
    } else {
      // Time (left of date, clickable)
      var timeText = formatTime(task);
      var timeEl = datesEl.createEl('span', {
        cls: 'event-inline-item-time' + (timeText ? '' : ' is-empty'),
        text: timeText || '+',
      });
      timeEl.addEventListener('click', function(e) {
        e.stopPropagation();
        self.showTimeEditor(timeEl, task);
      });

      // Date
      if (task.fields.date) {
        var dateEl = datesEl.createDiv({ cls: 'event-inline-item-date' });
        var dateVal = dateEl.createEl('span', {
          cls: 'event-inline-item-date-value',
          text: task.fields.date,
        });
        dateVal.addEventListener('click', function() {
          dateVal.style.display = 'none';
          var input = dateEl.createEl('input', {
            cls: 'event-inline-item-date-input',
            type: 'date',
            value: task.fields.date,
          });
          input.focus();
          try { input.showPicker(); } catch(e) {}
          var saveDate = function() {
            var newDate = input.value;
            input.remove();
            dateVal.style.display = '';
            if (newDate && newDate !== task.fields.date) {
              self.updateTaskField(task, 'date', newDate);
            }
          };
          input.addEventListener('blur', saveDate);
          input.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
            if (e.key === 'Escape') { input.value = task.fields.date; input.blur(); }
          });
        });
      }
    }

    // Delete button (far right)
    var deleteBtn = row.createEl('button', {
      cls: 'event-inline-delete-btn',
      text: '\u00D7',
      attr: { 'aria-label': '\uC0AD\uC81C' },
    });
    deleteBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      self.deleteTask(task);
    });
  }

  showTimeEditor(timeEl, task) {
    var self = this;
    var existing = document.querySelector('.event-inline-time-editor');
    if (existing) existing.remove();

    var hours = [];
    for (var h = 0; h < 24; h++) hours.push(String(h).padStart(2, '0'));
    var mins = ['00', '15', '30', '45'];

    function parseTime(str) {
      if (!str) return { h: '', m: '' };
      var parts = str.split(':');
      return { h: parts[0] || '', m: parts[1] || '' };
    }

    var popup = document.createElement('div');
    popup.className = 'event-inline-time-editor';

    // Close any open dropdown when clicking inside popup but outside a dropdown
    popup.addEventListener('click', function() {
      var open = popup.querySelectorAll('.event-inline-dropdown-menu.is-open');
      for (var j = 0; j < open.length; j++) open[j].classList.remove('is-open');
    });

    function createDropdown(options, current, placeholder) {
      var wrapper = document.createElement('div');
      wrapper.className = 'event-inline-dropdown';

      var trigger = document.createElement('button');
      trigger.className = 'event-inline-dropdown-trigger';
      trigger.textContent = current || placeholder;
      if (!current) trigger.classList.add('is-placeholder');
      wrapper.appendChild(trigger);

      var menu = document.createElement('div');
      menu.className = 'event-inline-dropdown-menu';

      var selectedEl = null;

      for (var i = 0; i < options.length; i++) {
        (function(opt) {
          var item = document.createElement('div');
          item.className = 'event-inline-dropdown-item';
          item.textContent = opt;
          if (opt === current) {
            item.classList.add('is-selected');
            selectedEl = item;
          }
          item.addEventListener('click', function(e) {
            e.stopPropagation();
            wrapper._value = opt;
            trigger.textContent = opt;
            trigger.classList.remove('is-placeholder');
            var prev = menu.querySelector('.is-selected');
            if (prev) prev.classList.remove('is-selected');
            item.classList.add('is-selected');
            selectedEl = item;
            menu.classList.remove('is-open');
          });
          menu.appendChild(item);
        })(options[i]);
      }

      wrapper.appendChild(menu);

      trigger.addEventListener('click', function(e) {
        e.stopPropagation();
        // Close other open dropdowns
        var open = popup.querySelectorAll('.event-inline-dropdown-menu.is-open');
        for (var j = 0; j < open.length; j++) {
          if (open[j] !== menu) open[j].classList.remove('is-open');
        }
        var wasOpen = menu.classList.contains('is-open');
        menu.classList.toggle('is-open');
        if (!wasOpen && selectedEl) {
          menu.scrollTop = selectedEl.offsetTop - menu.offsetHeight / 2 + selectedEl.offsetHeight / 2;
        }
      });

      wrapper._value = current || '';
      return wrapper;
    }

    function createTimeRow(label, currentTime) {
      var cur = parseTime(currentTime);
      var rowEl = document.createElement('div');
      rowEl.className = 'event-inline-time-row';

      var lbl = document.createElement('span');
      lbl.className = 'event-inline-time-label';
      lbl.textContent = label;
      rowEl.appendChild(lbl);

      var hourDd = createDropdown(hours, cur.h, '--');
      rowEl.appendChild(hourDd);

      var colon = document.createElement('span');
      colon.className = 'event-inline-time-colon';
      colon.textContent = ':';
      rowEl.appendChild(colon);

      var minDd = createDropdown(mins, cur.m, '--');
      rowEl.appendChild(minDd);

      rowEl._getTime = function() {
        var hv = hourDd._value;
        var mv = minDd._value;
        if (!hv) return '';
        return hv + ':' + (mv || '00');
      };

      return rowEl;
    }

    var startRow = createTimeRow('\uC2DC\uC791', task.fields.start || '');
    var endRow = createTimeRow('\uC885\uB8CC', task.fields.end || '');
    popup.appendChild(startRow);
    popup.appendChild(endRow);

    var clearBtn = document.createElement('button');
    clearBtn.className = 'event-inline-time-clear';
    clearBtn.textContent = '\uC2DC\uAC04 \uC0AD\uC81C';
    var closeHandler = null;
    clearBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      popup.remove();
      if (closeHandler) document.removeEventListener('click', closeHandler);
      self.updateEventTime(task, '', '');
    });
    popup.appendChild(clearBtn);

    // Position below timeEl
    document.body.appendChild(popup);
    var rect = timeEl.getBoundingClientRect();
    popup.style.top = (rect.bottom + 4) + 'px';
    popup.style.left = Math.max(0, rect.right - popup.offsetWidth) + 'px';

    // Close on outside click
    setTimeout(function() {
      closeHandler = function(ev) {
        if (!popup.contains(ev.target)) {
          var newStart = startRow._getTime();
          var newEnd = endRow._getTime();
          popup.remove();
          document.removeEventListener('click', closeHandler);
          if (newStart !== (task.fields.start || '') || newEnd !== (task.fields.end || '')) {
            self.updateEventTime(task, newStart, newEnd);
          }
        }
      };
      document.addEventListener('click', closeHandler);
    }, 0);
  }

  // ─── File Writers ───────────────────────────────────────────

  async updateTaskInFile(task, updatedTask) {
    var file = this.app.vault.getAbstractFileByPath(task.filePath);
    if (!file || !(file instanceof obsidian.TFile)) return;
    var newLine = taskToLine(updatedTask);
    this.isUpdating = true;
    var updated = false;
    try {
      await this.app.vault.process(file, function(data) {
        var lines = data.split('\n');
        var targetIdx = -1;
        if (lines[task.lineNum] === task.raw) {
          targetIdx = task.lineNum;
        } else {
          var closestDist = Infinity;
          for (var i = 0; i < lines.length; i++) {
            if (lines[i] === task.raw) {
              var dist = Math.abs(i - task.lineNum);
              if (dist < closestDist) {
                closestDist = dist;
                targetIdx = i;
              }
            }
          }
        }
        if (targetIdx === -1) {
          new obsidian.Notice('Event not found in file. Refreshing view.');
          return data;
        }
        lines[targetIdx] = newLine;
        updated = true;
        return lines.join('\n');
      });
      if (updated) {
        task.raw = newLine;
        task.prefix = updatedTask.prefix;
        task.status = updatedTask.status;
        task.desc = updatedTask.desc;
        task.fields = updatedTask.fields;
      }
    } finally {
      this.isUpdating = false;
      if (this.onUpdate) this.onUpdate();
    }
  }

  async updateTaskStatus(task, newStatus) {
    var updated = {
      prefix: task.prefix,
      status: newStatus,
      desc: task.desc,
      fields: Object.assign({}, task.fields),
      filePath: task.filePath,
      lineNum: task.lineNum,
      raw: task.raw,
    };
    await this.updateTaskInFile(task, updated);
  }

  async updateTaskDesc(task, newDesc) {
    var updated = {
      prefix: task.prefix,
      status: task.status,
      desc: newDesc,
      fields: Object.assign({}, task.fields),
      filePath: task.filePath,
      lineNum: task.lineNum,
      raw: task.raw,
    };
    await this.updateTaskInFile(task, updated);
  }

  async updateEventTime(task, newStart, newEnd) {
    var updated = {
      prefix: task.prefix,
      status: task.status,
      desc: task.desc,
      fields: Object.assign({}, task.fields),
      filePath: task.filePath,
      lineNum: task.lineNum,
      raw: task.raw,
    };
    if (newStart) {
      updated.fields.start = newStart;
    } else {
      delete updated.fields.start;
    }
    if (newEnd) {
      updated.fields.end = newEnd;
    } else {
      delete updated.fields.end;
    }
    await this.updateTaskInFile(task, updated);
  }

  async addEvent(desc) {
    var filePath = EVENT_FOLDER + '/active.md';
    var file = this.app.vault.getAbstractFileByPath(filePath);
    if (!file || !(file instanceof obsidian.TFile)) {
      new obsidian.Notice('File not found: ' + filePath);
      return;
    }
    var newLine = '- [ ] ' + desc + ' [date:: ' + today() + ']';
    this.isUpdating = true;
    try {
      await this.app.vault.process(file, function(data) {
        return data.trimEnd() + '\n' + newLine + '\n';
      });
    } finally {
      this.isUpdating = false;
      if (this.onUpdate) this.onUpdate();
    }
  }

  async deleteTask(task) {
    var file = this.app.vault.getAbstractFileByPath(task.filePath);
    if (!file || !(file instanceof obsidian.TFile)) return;
    this.isUpdating = true;
    try {
      await this.app.vault.process(file, function(data) {
        var lines = data.split('\n');
        var targetIdx = -1;
        if (lines[task.lineNum] === task.raw) {
          targetIdx = task.lineNum;
        } else {
          var closestDist = Infinity;
          for (var i = 0; i < lines.length; i++) {
            if (lines[i] === task.raw) {
              var dist = Math.abs(i - task.lineNum);
              if (dist < closestDist) {
                closestDist = dist;
                targetIdx = i;
              }
            }
          }
        }
        if (targetIdx === -1) {
          new obsidian.Notice('Event not found in file.');
          return data;
        }
        lines.splice(targetIdx, 1);
        return lines.join('\n');
      });
    } finally {
      this.isUpdating = false;
      if (this.onUpdate) this.onUpdate();
    }
  }

  async updateTaskField(task, field, value) {
    var updated = {
      prefix: task.prefix,
      status: task.status,
      desc: task.desc,
      fields: Object.assign({}, task.fields),
      filePath: task.filePath,
      lineNum: task.lineNum,
      raw: task.raw,
    };
    updated.fields[field] = value;
    await this.updateTaskInFile(task, updated);
  }
}

// ─── EventView (sidebar ItemView) ────────────────────────────────

class EventView extends obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.refreshTimeout = null;
    this.renderer = new EventRenderer(this.app);
    this.renderer.onUpdate = () => this.scheduleRefresh();
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Events'; }
  getIcon() { return 'calendar'; }

  async onOpen() {
    await this.refresh();
    var self = this;
    this.registerEvent(
      this.app.vault.on('modify', function(file) {
        if (file.path.startsWith(EVENT_FOLDER + '/') && !self.renderer.isUpdating) {
          self.scheduleRefresh();
        }
      })
    );
    this.registerEvent(
      this.app.vault.on('delete', function(file) {
        if (file.path.startsWith(EVENT_FOLDER + '/')) self.scheduleRefresh();
      })
    );
    this.registerEvent(
      this.app.vault.on('create', function(file) {
        if (file.path.startsWith(EVENT_FOLDER + '/')) self.scheduleRefresh();
      })
    );
    this.registerEvent(
      this.app.vault.on('rename', function(file, oldPath) {
        if (file.path.startsWith(EVENT_FOLDER + '/') || oldPath.startsWith(EVENT_FOLDER + '/')) {
          self.scheduleRefresh();
        }
      })
    );
  }

  scheduleRefresh() {
    if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
    this.refreshTimeout = setTimeout(() => this.refresh(), 300);
  }

  async onClose() {
    if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
  }

  async refresh() {
    await this.renderer.render(this.contentEl);
  }
}

// ─── Plugin ─────────────────────────────────────────────────────

class EventInlineEditorPlugin extends obsidian.Plugin {
  async onload() {
    var self = this;

    this.registerView(VIEW_TYPE, function(leaf) { return new EventView(leaf, self); });

    this.addRibbonIcon('calendar', 'Open Event View', function() {
      self.activateView();
    });

    this.addCommand({
      id: 'open-event-view',
      name: 'Open Event View',
      callback: function() { self.activateView(); },
    });

    this.registerMarkdownCodeBlockProcessor('event-view', function(source, el, ctx) {
      var renderer = new EventRenderer(self.app);
      renderer.render(el);

      var refreshTimeout = null;
      var scheduleRefresh = function() {
        if (refreshTimeout) clearTimeout(refreshTimeout);
        refreshTimeout = setTimeout(function() { renderer.render(el); }, 300);
      };
      renderer.onUpdate = scheduleRefresh;

      self.registerEvent(
        self.app.vault.on('modify', function(file) {
          if (file.path.startsWith(EVENT_FOLDER + '/') && !renderer.isUpdating) {
            scheduleRefresh();
          }
        })
      );
    });
  }

  async onunload() {}

  async activateView() {
    var workspace = this.app.workspace;
    var leaf = null;
    var leaves = workspace.getLeavesOfType(VIEW_TYPE);
    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }
}

module.exports = EventInlineEditorPlugin;
