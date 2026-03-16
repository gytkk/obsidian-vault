'use strict';

const obsidian = require('obsidian');

const VIEW_TYPE = 'todo-inline-view';
const TODO_FOLDER = 'todos';
const TASK_RE = /^([\s]*[-*+])\s\[(.)\]\s+(.+)$/;
const FIELD_RE = /\[(\w+)::\s*([^\]]+)\]/g;
const DATE_FIELDS = ['due', 'created', 'completion'];
const COMPLETED_DAYS = 7;

// ─── Task Parser ────────────────────────────────────────────────

function today() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
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
  const due = task.fields.due;
  if (!due) return false;
  return due < today();
}

// ─── TodoRenderer (shared rendering + writing) ──────────────────

class TodoRenderer {
  constructor(app) {
    this.app = app;
    this.isUpdating = false;
  }

  async loadAllTasks() {
    const folder = this.app.vault.getAbstractFileByPath(TODO_FOLDER);
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
      return t.status === 'x' && isWithinDays(t.fields.completion, COMPLETED_DAYS);
    });

    pending.sort(function(a, b) { return (a.fields.due || '9999').localeCompare(b.fields.due || '9999'); });
    done.sort(function(a, b) {
      var da = b.fields.completion || '';
      var db = a.fields.completion || '';
      return da.localeCompare(db);
    });

    var scrollTop = container.scrollTop;
    var existingPopup = document.querySelector('.todo-inline-status-popup');
    if (existingPopup) existingPopup.remove();
    container.empty();
    container.addClass('todo-inline-view');

    this.renderGroupedSection(container, '\uC9C4\uD589\uC911', pending);
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
        var key = tasks[i].fields.due || '';
        if (!groups[key]) {
          groups[key] = [];
          order.push(key);
        }
        groups[key].push(tasks[i]);
      }

      for (var i = 0; i < order.length; i++) {
        var key = order[i];
        var label = key || '\uB0A0\uC9DC \uC5C6\uC74C';
        container.createEl('div', { cls: 'todo-inline-date-group', text: label });
        var groupTasks = groups[key];
        for (var j = 0; j < groupTasks.length; j++) {
          this.renderTask(container, groupTasks[j]);
        }
      }
    }

    // Add task row (mimics a real item)
    var addRow = container.createDiv({ cls: 'todo-inline-item todo-inline-add-row' });
    var addCircle = addRow.createEl('span', { cls: 'todo-inline-status-btn todo-inline-add-circle' });
    var addPlaceholder = addRow.createEl('span', {
      cls: 'todo-inline-add-placeholder',
      text: '\uD560 \uC77C\uC744 \uC785\uB825\uD558\uC138\uC694...',
    });
    addRow.addEventListener('click', function() {
      if (addRow.querySelector('.todo-inline-add-input')) return;
      addPlaceholder.style.display = 'none';
      var input = addRow.createEl('input', {
        cls: 'todo-inline-add-input',
        type: 'text',
        attr: { placeholder: '\uD560 \uC77C\uC744 \uC785\uB825\uD558\uC138\uC694...' },
      });
      input.focus();
      var save = function() {
        var desc = input.value.trim();
        input.remove();
        addPlaceholder.style.display = '';
        if (desc) {
          self.addTask(desc);
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
      this.renderTask(container, tasks[i]);
    }
  }

  renderTask(container, task, opts) {
    var isDone = task.status === 'x';
    var overdue = !isDone && isOverdue(task);
    var self = this;

    var row = container.createDiv({
      cls: 'todo-inline-item'
        + (isDone ? ' is-done' : '')
        + (overdue ? ' todo-inline-item-overdue' : '')
    });

    // Status button: click = toggle done, right-click = context menu
    var statusIcons = { ' ': '', 'x': '\u2713' };
    var statusBtn = row.createEl('button', {
      cls: 'todo-inline-status-btn',
      text: statusIcons[task.status] || '',
    });

    // Left click: toggle complete
    statusBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      var newStatus = task.status === 'x' ? ' ' : 'x';
      self.updateTaskStatus(task, newStatus);
    });

    // Right click: context menu with all statuses
    statusBtn.addEventListener('contextmenu', function(e) {
      e.preventDefault();
      e.stopPropagation();
      var existing = document.querySelector('.todo-inline-status-popup');
      if (existing) { existing.remove(); return; }

      var popup = document.createElement('div');
      popup.className = 'todo-inline-status-popup';

      var options = [
        { value: ' ', icon: '\u25CB', label: '\uC9C4\uD589\uC911' },
        { value: 'x', icon: '\u2713', label: '\uC644\uB8CC' },
      ];

      for (var j = 0; j < options.length; j++) {
        (function(opt) {
          var optEl = document.createElement('div');
          optEl.className = 'todo-inline-status-option'
            + (opt.value === task.status ? ' is-active' : '');
          var iconSpan = document.createElement('span');
          iconSpan.className = 'todo-inline-status-option-icon';
          iconSpan.textContent = opt.icon;
          optEl.appendChild(iconSpan);
          var labelSpan = document.createElement('span');
          labelSpan.textContent = opt.label;
          optEl.appendChild(labelSpan);
          optEl.addEventListener('click', function(ev) {
            ev.stopPropagation();
            popup.remove();
            if (opt.value !== task.status) {
              self.updateTaskStatus(task, opt.value);
            }
          });
          popup.appendChild(optEl);
        })(options[j]);
      }

      document.body.appendChild(popup);
      var rect = statusBtn.getBoundingClientRect();
      popup.style.top = (rect.bottom + 4) + 'px';
      popup.style.left = rect.left + 'px';

      setTimeout(function() {
        var closeHandler = function(ev) {
          if (!popup.contains(ev.target)) {
            popup.remove();
            document.removeEventListener('click', closeHandler);
          }
        };
        document.addEventListener('click', closeHandler);
      }, 0);
    });

    // Description (contenteditable)
    var descEl = row.createEl('span', {
      cls: 'todo-inline-item-desc',
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

    // Dates (right-aligned)
    var dates = [];
    if (isDone) {
      if (task.fields.created) dates.push({ key: 'created', label: '', value: task.fields.created, editable: false, cls: 'todo-inline-item-date-created' });
      if (task.fields.completion) dates.push({ key: 'completion', label: '', value: task.fields.completion, editable: false });
    } else {
      if (task.fields.due) dates.push({ key: 'due', label: '', value: task.fields.due, editable: true });
    }

    if (dates.length > 0) {
      var dateWrap = row.createDiv({ cls: 'todo-inline-item-dates' });
      for (var di = 0; di < dates.length; di++) {
        (function(d) {
          var dateCls = 'todo-inline-item-date' + (d.cls ? ' ' + d.cls : '') + (d.key !== 'due' && d.key !== 'created' ? ' todo-inline-item-date-secondary' : '');
          var dateRow = dateWrap.createDiv({ cls: dateCls });
          var dateVal = dateRow.createEl('span', {
            cls: 'todo-inline-item-date-value',
            text: d.value,
          });
          if (d.editable) {
            dateVal.addEventListener('click', function() {
              dateVal.style.display = 'none';
              var input = dateRow.createEl('input', {
                cls: 'todo-inline-item-date-input',
                type: 'date',
                value: d.value,
              });
              input.focus();
              try { input.showPicker(); } catch(e) {}
              var saveDate = function() {
                var newDate = input.value;
                input.remove();
                dateVal.style.display = '';
                if (newDate && newDate !== d.value) {
                  self.updateTaskField(task, d.key, newDate);
                }
              };
              input.addEventListener('blur', saveDate);
              input.addEventListener('keydown', function(e) {
                if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
                if (e.key === 'Escape') { input.value = d.value; input.blur(); }
              });
            });
          }
        })(dates[di]);
      }
    }

    // Delete button (far right)
    var deleteBtn = row.createEl('button', {
      cls: 'todo-inline-delete-btn',
      text: '\u00D7',
      attr: { 'aria-label': '\uC0AD\uC81C' },
    });
    deleteBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      self.deleteTask(task);
    });
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
          new obsidian.Notice('Task not found in file. Refreshing view.');
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
    if (newStatus === 'x') {
      updated.fields.completion = today();
    } else {
      delete updated.fields.completion;
    }
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

  async addTask(desc) {
    var filePath = TODO_FOLDER + '/active.md';
    var file = this.app.vault.getAbstractFileByPath(filePath);
    if (!file || !(file instanceof obsidian.TFile)) {
      new obsidian.Notice('File not found: ' + filePath);
      return;
    }
    var newLine = '- [ ] ' + desc + ' [due:: ' + today() + '] [created:: ' + today() + ']';
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
          new obsidian.Notice('Task not found in file.');
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

// ─── TodoView (sidebar ItemView) ────────────────────────────────

class TodoView extends obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.refreshTimeout = null;
    this.renderer = new TodoRenderer(this.app);
    this.renderer.onUpdate = () => this.scheduleRefresh();
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Todo'; }
  getIcon() { return 'check-square'; }

  async onOpen() {
    await this.refresh();
    var self = this;
    this.registerEvent(
      this.app.vault.on('modify', function(file) {
        if (file.path.startsWith(TODO_FOLDER + '/') && !self.renderer.isUpdating) {
          self.scheduleRefresh();
        }
      })
    );
    this.registerEvent(
      this.app.vault.on('delete', function(file) {
        if (file.path.startsWith(TODO_FOLDER + '/')) self.scheduleRefresh();
      })
    );
    this.registerEvent(
      this.app.vault.on('create', function(file) {
        if (file.path.startsWith(TODO_FOLDER + '/')) self.scheduleRefresh();
      })
    );
    this.registerEvent(
      this.app.vault.on('rename', function(file, oldPath) {
        if (file.path.startsWith(TODO_FOLDER + '/') || oldPath.startsWith(TODO_FOLDER + '/')) {
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

class TodoInlineEditorPlugin extends obsidian.Plugin {
  async onload() {
    var self = this;

    // Sidebar view
    this.registerView(VIEW_TYPE, function(leaf) { return new TodoView(leaf, self); });

    this.addRibbonIcon('check-square', 'Open Todo View', function() {
      self.activateView();
    });

    this.addCommand({
      id: 'open-todo-view',
      name: 'Open Todo View',
      callback: function() { self.activateView(); },
    });

    // Code block processor: ```todo-view```
    this.registerMarkdownCodeBlockProcessor('todo-view', function(source, el, ctx) {
      var renderer = new TodoRenderer(self.app);
      renderer.render(el);

      // Auto-refresh on file changes
      var refreshTimeout = null;
      var scheduleRefresh = function() {
        if (refreshTimeout) clearTimeout(refreshTimeout);
        refreshTimeout = setTimeout(function() { renderer.render(el); }, 300);
      };
      renderer.onUpdate = scheduleRefresh;

      self.registerEvent(
        self.app.vault.on('modify', function(file) {
          if (file.path.startsWith(TODO_FOLDER + '/') && !renderer.isUpdating) {
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

module.exports = TodoInlineEditorPlugin;
