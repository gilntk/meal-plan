// Meal Plan: plain JavaScript, no libraries.
// Data model (two tables, stored in IndexedDB on the phone):
//   foods: { id, name }
//   plans: { date: "YYYY-MM-DD", foodIds: [id, ...], note: "eggs, butter" }

const PAST_DAYS = 2;     // compact rows shown above today
const AHEAD_DAYS = 3;    // full days shown after today (today + 3 = 4 days)
const MAX_AHEAD = 6;     // most days a list can show after today (a week in all)
const MOVE_RANGE = 14;   // how far ahead "Move to" offers days

// ---------- Storage (IndexedDB, with an in-memory fallback) ----------

const DB_NAME = 'meal-plan';
const DB_VERSION = 2; // v2 adds the 'meta' store for items added straight to the shopping list
let db = null;

function openDb() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('foods')) d.createObjectStore('foods', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('plans')) d.createObjectStore('plans', { keyPath: 'date' });
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null); // storage blocked: app still works for this session
    }
  });
}

function readAll(store) {
  if (!db) return Promise.resolve([]);
  return new Promise((resolve) => {
    const req = db.transaction(store).objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
}

// Apply a set of writes in one transaction: [{ store, put: obj } | { store, del: key } | { store, clear: true }]
function write(ops) {
  if (!db) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const stores = [...new Set(ops.map((o) => o.store))];
    const tx = db.transaction(stores, 'readwrite');
    for (const op of ops) {
      const s = tx.objectStore(op.store);
      if (op.clear) s.clear();
      else if (op.put) s.put(op.put);
      else s.delete(op.del);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- In-memory state ----------

const foods = new Map(); // id -> food
const plans = new Map(); // date -> plan
let extras = [];         // shopping items added directly, not tied to a day
let extraCalendarDays = 0;
let extraPlannerDays = 0;

const newId = () =>
  (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

const sortedFoods = () =>
  [...foods.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

function getPlan(date) {
  return plans.get(date) || { date, foodIds: [], note: '' };
}
const isEmpty = (p) => !p.foodIds.length && !p.note.trim();

async function savePlan(plan) {
  plan.foodIds = plan.foodIds.filter((id) => foods.has(id));
  plan.note = plan.note.trim();
  if (isEmpty(plan)) {
    plans.delete(plan.date);
    await write([{ store: 'plans', del: plan.date }]);
  } else {
    plans.set(plan.date, plan);
    await write([{ store: 'plans', put: plan }]);
  }
}

// ---------- Dates ----------

function dateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function fromKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function addDays(key, n) {
  const d = fromKey(key);
  d.setDate(d.getDate() + n);
  return dateKey(d);
}
const todayKey = () => dateKey(new Date());

function dayName(key) {
  return fromKey(key).toLocaleDateString(undefined, { weekday: 'long' });
}
const shortDate = (key) => fromKey(key).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const weekdayDate = (key) => fromKey(key).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const shareLabel = (key) => fromKey(key).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

// The last day to show: default window, plus any extra days the person added,
// stretched to include anything already planned further out, capped at a week.
const capDay = () => addDays(todayKey(), MAX_AHEAD);
function lastDay(extra) {
  const cap = capDay();
  let last = addDays(todayKey(), Math.min(AHEAD_DAYS + extra, MAX_AHEAD));
  for (const date of plans.keys()) if (date > last && date <= cap) last = date;
  return last;
}

// At the cap, "show another day" gives way to "Plan a later date",
// and any days planned past the cap are listed so they aren't forgotten.
function renderLaterControls(moreBtn, laterBtn, note, extra) {
  const full = lastDay(extra) >= capDay();
  moreBtn.hidden = full;
  laterBtn.hidden = !full;
  const later = [...plans.keys()].filter((d) => d > capDay()).sort();
  note.hidden = later.length === 0;
  note.textContent = later.length ? `Also planned later: ${later.map(shareLabel).join('; ')}` : '';
}

function openLater() {
  const input = $('#later-date');
  input.min = addDays(capDay(), 1);
  if (!input.value || input.value < input.min) input.value = input.min;
  $('#later').returnValue = '';
  $('#later').showModal();
}
function range(from, to) {
  const out = [];
  for (let k = from; k <= to; k = addDays(k, 1)) out.push(k);
  return out;
}

const matchesText = (f, text) => !text || f.name.toLowerCase().includes(text.trim().toLowerCase());
const foodNames = (plan) => plan.foodIds.map((id) => foods.get(id)?.name).filter(Boolean);

// ---------- Tags ----------

const tagsOf = (f) => f.tags || [];
const sameTag = (a, b) => a.toLowerCase() === b.toLowerCase();
const hasTag = (f, tag) => !tag || tagsOf(f).some((t) => sameTag(t, tag));
function cleanTag(t) { return t.trim().replace(/\s+/g, ' ').slice(0, 24); }

function allTags() {
  const byKey = new Map();
  for (const f of foods.values()) for (const t of tagsOf(f)) if (!byKey.has(t.toLowerCase())) byKey.set(t.toLowerCase(), t);
  return [...byKey.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

// Draws the swipeable chip row. Returns the filter still in effect (null if its tag is gone).
// How often each tag is tapped in Plan meals, so the most-used tags sit first there.
let tagCounts = {}; // lowercased tag -> taps
const saveTagCounts = () => write([{ store: 'meta', put: { key: 'tagCounts', counts: tagCounts } }]);
function countTagTap(tag) {
  const k = tag.toLowerCase();
  tagCounts[k] = (tagCounts[k] || 0) + 1;
  saveTagCounts();
}
// Most-used first, alphabetical for ties (so new and unused tags line up at the end).
const byUse = (tags) => [...tags].sort((a, b) =>
  (tagCounts[b.toLowerCase()] || 0) - (tagCounts[a.toLowerCase()] || 0) ||
  a.localeCompare(b, undefined, { sensitivity: 'base' }));

function renderTagRow(container, current, onPick, order = null) {
  // order: a fixed list to sort by; tags not in it go at the end alphabetically
  let tags = allTags();
  if (order) {
    const rank = new Map(order.map((t, i) => [t.toLowerCase(), i]));
    tags = [...tags].sort((a, b) => (rank.get(a.toLowerCase()) ?? 1e9) - (rank.get(b.toLowerCase()) ?? 1e9) ||
      a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }
  if (current && !tags.some((t) => sameTag(t, current))) current = null;
  container.hidden = tags.length === 0;
  const chip = (label, value) => el('button', {
    type: 'button', class: 'tag-chip',
    'aria-pressed': String(value === null ? current === null : current !== null && sameTag(value, current)),
    text: label, onclick: () => onPick(value),
  });
  container.replaceChildren(chip('All', null), ...tags.map((t) => chip(t, t)));
  return current;
}

// ---------- Helpers ----------

const $ = (sel) => document.querySelector(sel);
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function confirmDialog(title, message, okLabel = 'Delete') {
  const dlg = $('#confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-msg').textContent = message;
  $('#confirm-ok').textContent = okLabel;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
  });
}

// ---------- Calendar tab (read-only) ----------

function renderCalendar() {
  const list = $('#calendar-days');
  list.replaceChildren();
  const today = todayKey();

  // Past days: compact rows
  const pastKeys = range(addDays(today, -PAST_DAYS), addDays(today, -1));
  pastKeys.forEach((key, i) => {
    const plan = getPlan(key);
    const names = foodNames(plan);
    const summary = names.length ? names.join(', ') : 'Nothing planned';
    const item = el('li', { class: 'day past', 'aria-label': `${weekdayDate(key)}, past: ${summary}` },
      el('h2', {}, el('span', { text: dayName(key) }), el('span', { class: 'date', text: shortDate(key) })),
      el('span', { class: 'summary', 'aria-hidden': 'true', text: summary }));
    if (i === 0) list.append(el('li', { class: 'past-divider', 'aria-hidden': 'true', text: 'Earlier' }));
    list.append(item);
  });

  // Today and ahead: full cells
  for (const key of range(today, lastDay(extraCalendarDays))) {
    const plan = getPlan(key);
    const names = foodNames(plan);
    const heading = el('h2', { id: `cal-${key}` },
      key === today ? el('span', { class: 'visually-hidden', text: 'Today, ' }) : null, // screen readers still hear it
      el('span', { text: dayName(key) }),
      el('span', { class: 'date', text: shortDate(key) }));
    const body = names.length
      ? el('ul', { class: 'meals' }, ...names.map((n) => el('li', { text: n })))
      : el('p', { class: 'nothing', text: 'Nothing planned' });
    list.append(el('li', { class: `day${key === today ? ' today' : ''}`, 'aria-labelledby': `cal-${key}` }, heading, body));
  }
  renderLaterControls($('#calendar-more'), $('#calendar-later'), $('#calendar-later-note'), extraCalendarDays);
}

function scrollToToday() {
  const todayCell = document.querySelector('.day.today');
  if (!todayCell) return;
  // Anchor today about 20% down the screen
  const y = todayCell.getBoundingClientRect().top + window.scrollY - window.innerHeight * 0.2;
  window.scrollTo({ top: Math.max(0, y) });
}

// ---------- Share ----------

async function sharePlan() {
  const lines = [];
  for (const key of [...plans.keys()].filter((d) => d >= todayKey()).sort()) {
    const names = foodNames(getPlan(key));
    if (names.length) lines.push(`${shareLabel(key)}: ${names.join(', ')}`);
  }
  if (!lines.length) {
    toast('Nothing planned yet to share');
    return;
  }
  const text = `Dinner plan\n${lines.join('\n')}`;
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Dinner plan', text });
      return;
    }
  } catch (err) {
    if (err.name === 'AbortError') return; // person closed the share sheet
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('Plan copied. Paste it into a message.');
  } catch {
    toast('Sharing isn’t available here');
  }
}

// ---------- Planner (all changes happen here) ----------

function renderPlanner() {
  const list = $('#planner-days');
  list.replaceChildren();
  for (const key of range(todayKey(), lastDay(extraPlannerDays))) {
    const plan = getPlan(key);
    const names = foodNames(plan);
    const label = `${dayName(key)}, ${shortDate(key)}`;
    const headingId = `plan-${key}`;

    const actions = el('div', { class: 'planner-actions' },
      el('button', {
        type: 'button', class: 'primary-button',
        'aria-describedby': headingId,
        text: names.length ? 'Edit' : 'Add',
        onclick: () => openPicker(key),
      }));
    if (!isEmpty(plan)) {
      actions.append(
        el('button', { type: 'button', class: 'danger-button', 'aria-describedby': headingId, text: 'Clear', onclick: () => clearDay(key) }),
        el('button', { type: 'button', class: 'secondary-button', 'aria-describedby': headingId, text: 'Move', onclick: () => openMover(key) }));
    }

    list.append(el('li', { class: 'planner-day' },
      el('div', { class: 'planner-info' },
        el('h3', { id: headingId, text: label }),
        names.length
          ? el('ul', { class: 'meals' }, ...names.map((n) => el('li', { text: n })))
          : el('p', { class: 'nothing', text: 'Nothing planned' }),
        plan.note ? el('p', { class: 'note', text: `Missing: ${plan.note}` }) : null),
      actions));
  }
  renderLaterControls($('#planner-more'), $('#planner-later'), $('#planner-later-note'), extraPlannerDays);
}

function openPlanner() {
  extraPlannerDays = Math.max(extraPlannerDays, extraCalendarDays);
  renderPlanner();
  $('#planner').showModal();
}

async function clearDay(key) {
  const ok = await confirmDialog(`Clear ${dayName(key)}?`, 'This removes its foods and any missing items from your shopping list.', 'Clear');
  if (!ok) return;
  await savePlan({ date: key, foodIds: [], note: '' });
  renderAll();
  toast(`${dayName(key)} cleared`);
}

// ---------- Picker: choose foods for one day ----------

let pickerDate = null;
let pickerChecked = new Set(); // foods chosen for the day, kept even when a tag filter hides them
let pickerFilter = null;
let pickerTagOrder = null; // set when the picker opens, so chips don't jump around mid-use

function renderPickerFoods() {
  const box = $('#picker-foods');
  box.replaceChildren();
  const all = sortedFoods();
  $('#picker-empty').hidden = all.length > 0;
  pickerFilter = renderTagRow($('#picker-tags'), pickerFilter, (t) => {
    if (t && !(pickerFilter && sameTag(t, pickerFilter))) countTagTap(t);
    pickerFilter = t;
    renderPickerFoods();
  }, pickerTagOrder);
  const text = $('#picker-new-food').value;
  const shown = all.filter((x) => hasTag(x, pickerFilter) && matchesText(x, text));
  noMatchMessage($('#picker-nomatch'), all.length > 0 && shown.length === 0, text);
  for (const f of shown) {
    const id = `pick-${f.id}`;
    const box_ = el('input', Object.assign({ type: 'checkbox', id, value: f.id }, pickerChecked.has(f.id) ? { checked: '' } : {}));
    box_.addEventListener('change', () => { if (box_.checked) pickerChecked.add(f.id); else pickerChecked.delete(f.id); });
    box.append(el('label', { class: 'pick', for: id }, box_, el('span', { text: f.name })));
  }
}

function setNoteOpen(open) {
  $('#note-toggle').setAttribute('aria-expanded', String(open));
  $('#note-area').hidden = !open;
}

function openPicker(key) {
  pickerDate = key;
  const plan = getPlan(key);
  $('#picker-title').textContent = dayName(key);
  $('#picker-save').textContent = `Save to ${dayName(key)}`;
  pickerChecked = new Set(plan.foodIds);
  pickerFilter = null;
  pickerTagOrder = byUse(allTags());
  renderPickerFoods();
  $('#picker-note').value = plan.note;
  $('#picker-new-food').value = '';
  setNoteOpen(Boolean(plan.note));
  $('#picker').showModal();
}

function checkedPickerIds() {
  return [...pickerChecked];
}

async function addFood(name, tags = []) {
  name = name.trim().replace(/\s+/g, ' ');
  if (!name) return null;
  const existing = [...foods.values()].find((f) => f.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing;
  const food = { id: newId(), name, tags };
  foods.set(food.id, food);
  await write([{ store: 'foods', put: food }]);
  return food;
}

async function pickerAddFood() {
  const input = $('#picker-new-food');
  // A food added while a tag is selected gets that tag
  const food = await addFood(input.value, pickerFilter ? [pickerFilter] : []);
  if (!food) return;
  pickerChecked.add(food.id);
  input.value = '';
  renderPickerFoods();
  renderFood();
  toast(`Added ${food.name}`);
}

async function savePicker() {
  const plan = getPlan(pickerDate);
  // Keep the order foods were first added to the day; append new picks alphabetically.
  const chosen = new Set(checkedPickerIds());
  const kept = plan.foodIds.filter((id) => chosen.has(id));
  const added = [...chosen].filter((id) => !kept.includes(id));
  await savePlan({ date: pickerDate, foodIds: [...kept, ...added], note: $('#picker-note').value });
  renderAll();
  toast(`Saved to ${dayName(pickerDate)}`);
}

// ---------- Mover: move a whole day ----------

function openMover(fromKeyStr) {
  const list = $('#mover-days');
  list.replaceChildren();
  $('#mover-desc').textContent = `Move everything planned for ${dayName(fromKeyStr)}. If the new day already has dinner planned, both are kept.`;
  const today = todayKey();
  for (const key of range(today, addDays(today, MOVE_RANGE - 1))) {
    if (key === fromKeyStr) continue;
    const names = foodNames(getPlan(key));
    list.append(el('li', {},
      el('button', { type: 'button', onclick: () => moveDay(fromKeyStr, key) },
        el('span', { text: `${dayName(key)}, ${shortDate(key)}` }),
        el('span', { class: 'sub', text: names.length ? `Has: ${names.join(', ')}` : 'Nothing planned' }))));
  }
  $('#mover').showModal();
}

async function moveDay(from, to) {
  const src = getPlan(from);
  const dst = getPlan(to);
  const merged = {
    date: to,
    foodIds: [...new Set([...dst.foodIds, ...src.foodIds])],
    note: [dst.note, src.note].filter((n) => n.trim()).join(', '),
  };
  await savePlan(merged);
  await savePlan({ date: from, foodIds: [], note: '' });
  $('#mover').close();
  renderAll();
  toast(`Moved to ${dayName(to)}`);
}

// ---------- Food tab ----------

function noMatchMessage(node, show, text) {
  node.hidden = !show;
  if (show) node.textContent = text.trim() ? `No foods match \u201c${text.trim()}\u201d. Tap Add to add it.` : 'No foods with this tag.';
}

function renderFood() {
  const list = $('#food-list');
  list.replaceChildren();
  const all = sortedFoods();
  $('#food-empty').hidden = all.length > 0;
  list.hidden = all.length === 0;
  foodFilter = renderTagRow($('#food-tags'), foodFilter, (t) => { foodFilter = t; renderFood(); });
  const text = $('#new-food-name').value;
  const shown = all.filter((x) => hasTag(x, foodFilter) && matchesText(x, text));
  noMatchMessage($('#food-nomatch'), all.length > 0 && shown.length === 0, text);
  for (const f of shown) {
    list.append(el('li', {},
      el('span', { class: 'name' }, f.name,
        tagsOf(f).length ? el('span', { class: 'food-tag-list', text: tagsOf(f).join(', ') }) : null),
      el('button', { type: 'button', class: 'text-button', 'aria-label': `Edit ${f.name}`, text: 'Edit', onclick: () => openFoodEditor(f.id) })));
  }
}

let foodFilter = null;
let editingFoodId = null;
let editingTags = [];
// One dialog for both: id = edit that food; no id = add a new one.
function openFoodEditor(id = null) {
  editingFoodId = id;
  const isNew = id === null;
  $('#food-editor-title').textContent = isNew ? 'New food' : 'Edit food';
  $('#food-editor-delete').hidden = isNew;
  $('#food-editor-save').textContent = isNew ? 'Add' : 'Save';
  // A new food starts from whatever is in the search box, and the selected tag
  $('#food-editor-name').value = isNew ? $('#new-food-name').value.trim() : foods.get(id).name;
  editingTags = isNew ? (foodFilter ? [foodFilter] : []) : [...tagsOf(foods.get(id))];
  $('#food-editor-new-tag').value = '';
  renderEditorTags();
  $('#food-editor').returnValue = '';
  $('#food-editor').showModal();
}

async function saveFoodEdit() {
  const name = $('#food-editor-name').value.trim().replace(/\s+/g, ' ');
  if (editingFoodId === null) {
    if (!name) return;
    const exists = [...foods.values()].find((f) => f.name.toLowerCase() === name.toLowerCase());
    if (exists) { toast(`${exists.name} is already on your list`); return; }
    const added = await addFood(name, editingTags);
    $('#new-food-name').value = '';
    renderAll();
    toast(`Added ${added.name}`);
    return;
  }
  const food = foods.get(editingFoodId);
  if (!food || !name) return;
  const tagsChanged = editingTags.join('|') !== tagsOf(food).join('|');
  if (name === food.name && !tagsChanged) return;
  food.name = name;
  food.tags = editingTags;
  await write([{ store: 'foods', put: food }]);
  renderAll();
  toast('Saved');
}

// Tags inside the Edit food dialog: this food's tags as chips (tap to remove),
// and suggestions from tags already in use, narrowed by what's typed.
function renderEditorTags() {
  $('#food-editor-tags').replaceChildren(...editingTags.map((t) => el('button', {
    type: 'button', class: 'tag-chip', 'aria-pressed': 'true', 'aria-label': `Remove tag ${t}`, text: t,
    onclick: () => { editingTags = editingTags.filter((x) => !sameTag(x, t)); renderEditorTags(); },
  })));
  $('#food-editor-tags-empty').hidden = editingTags.length > 0;

  const typed = cleanTag($('#food-editor-new-tag').value).toLowerCase();
  const unused = allTags().filter((t) => !editingTags.some((x) => sameTag(x, t)));
  const starts = unused.filter((t) => t.toLowerCase().startsWith(typed));
  const contains = typed ? unused.filter((t) => !starts.includes(t) && t.toLowerCase().includes(typed)) : [];
  const matches = [...starts, ...contains];
  const box = $('#food-editor-suggest');
  box.hidden = matches.length === 0;
  box.replaceChildren(...matches.map((t) => el('button', {
    type: 'button', class: 'tag-chip suggestion', 'aria-label': `Add tag ${t}`, text: t,
    onclick: () => {
      editingTags.push(t);
      $('#food-editor-new-tag').value = '';
      renderEditorTags();
      $('#food-editor-new-tag').focus();
    },
  })));
}

function addEditorTag() {
  const input = $('#food-editor-new-tag');
  const t = cleanTag(input.value);
  input.value = '';
  if (!t) return;
  // Reuse the existing spelling if this tag is already in use
  const existing = allTags().find((x) => sameTag(x, t));
  if (!editingTags.some((x) => sameTag(x, t))) editingTags.push(existing || t);
  renderEditorTags();
  input.focus();
}

async function deleteFood() {
  const food = foods.get(editingFoodId);
  if (!food) return;
  $('#food-editor').close();
  const ok = await confirmDialog(`Delete ${food.name}?`, 'It will also be removed from any days it’s planned on.');
  if (!ok) return;
  foods.delete(food.id);
  const ops = [{ store: 'foods', del: food.id }];
  for (const plan of plans.values()) {
    if (plan.foodIds.includes(food.id)) {
      plan.foodIds = plan.foodIds.filter((id) => id !== food.id);
      if (isEmpty(plan)) { plans.delete(plan.date); ops.push({ store: 'plans', del: plan.date }); }
      else ops.push({ store: 'plans', put: plan });
    }
  }
  await write(ops);
  renderAll();
  toast(`Deleted ${food.name}`);
}

// ---------- Shopping tab ----------

const splitItems = (text) => text.split(/[,;\n]+/).map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);

function shoppingItems() {
  const today = todayKey();
  const seen = new Set();
  const items = [];
  const add = (item) => { const k = item.toLowerCase(); if (!seen.has(k)) { seen.add(k); items.push(item); } };
  for (const d of [...plans.keys()].filter((x) => x >= today).sort()) splitItems(plans.get(d).note).forEach(add);
  extras.forEach(add);
  return items;
}

const saveExtras = () => write([{ store: 'meta', put: { key: 'shoppingExtras', items: extras } }]);

function setShoppingAddOpen(open) {
  $('#shopping-add-toggle').setAttribute('aria-expanded', String(open));
  $('#shopping-add-form').hidden = !open;
  if (open) $('#shopping-new-item').focus();
}

async function addShoppingItems(e) {
  e.preventDefault();
  const input = $('#shopping-new-item');
  const have = new Set(shoppingItems().map((i) => i.toLowerCase()));
  const fresh = splitItems(input.value).map((i) => i.slice(0, 80)).filter((i) => !have.has(i.toLowerCase()));
  input.value = '';
  if (!fresh.length) { toast('Already on the list'); return; }
  extras.push(...fresh);
  await saveExtras();
  renderShopping();
  toast(fresh.length === 1 ? `Added ${fresh[0]}` : `Added ${fresh.length} items`);
}

async function clearShopping() {
  const ok = await confirmDialog('Clear the shopping list?', 'This removes items you added here and the missing-items notes on today and later days. Your planned foods stay.', 'Clear');
  if (!ok) return;
  extras = [];
  const ops = [{ store: 'meta', put: { key: 'shoppingExtras', items: [] } }];
  for (const plan of [...plans.values()]) {
    if (plan.date >= todayKey() && plan.note) {
      plan.note = '';
      if (isEmpty(plan)) { plans.delete(plan.date); ops.push({ store: 'plans', del: plan.date }); }
      else ops.push({ store: 'plans', put: plan });
    }
  }
  await write(ops);
  renderAll();
  toast('Shopping list cleared');
}

function renderShopping() {
  const items = shoppingItems();
  const list = $('#shopping-list');
  list.replaceChildren(...items.map((i) => el('li', { text: i })));
  list.hidden = items.length === 0;
  $('#shopping-empty').hidden = items.length > 0;
  $('#shopping-clear').hidden = items.length === 0;
  const tab = $('#tab-shopping span');
  tab.textContent = 'Shopping';
  $('#tab-shopping').setAttribute('aria-label', items.length ? `Shopping, ${items.length} item${items.length === 1 ? '' : 's'}` : 'Shopping');
}

// ---------- Backup ----------

async function exportData() {
  const data = {
    app: 'meal-plan',
    version: 1,
    exportedAt: new Date().toISOString(),
    foods: sortedFoods(),
    plans: [...plans.values()].sort((a, b) => a.date.localeCompare(b.date)),
    shoppingExtras: extras,
    tagCounts,
  };
  const json = JSON.stringify(data, null, 2);
  const name = `meal-plan-backup-${todayKey()}.json`;
  const file = new File([json], name, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Meal Plan backup' });
      return;
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
  }
  const url = URL.createObjectURL(file);
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Backup saved');
}

async function importData(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    toast('That file isn’t a Meal Plan backup');
    return;
  }
  const valid = data && data.app === 'meal-plan' && Array.isArray(data.foods) && Array.isArray(data.plans);
  if (!valid) {
    toast('That file isn’t a Meal Plan backup');
    return;
  }
  const ok = await confirmDialog('Replace your data?', `This replaces everything on this phone with the backup (${data.foods.length} foods).`, 'Replace');
  if (!ok) return;

  const cleanFoods = data.foods
    .filter((f) => f && typeof f.id === 'string' && typeof f.name === 'string' && f.name.trim())
    .map((f) => ({
      id: f.id,
      name: f.name.trim().slice(0, 80),
      tags: Array.isArray(f.tags) ? f.tags.filter((t) => typeof t === 'string' && t.trim()).map(cleanTag) : [],
    }));
  const ids = new Set(cleanFoods.map((f) => f.id));
  const cleanPlans = data.plans
    .filter((p) => p && /^\d{4}-\d{2}-\d{2}$/.test(p.date))
    .map((p) => ({
      date: p.date,
      foodIds: Array.isArray(p.foodIds) ? p.foodIds.filter((id) => ids.has(id)) : [],
      note: typeof p.note === 'string' ? p.note.slice(0, 400) : '',
    }))
    .filter((p) => !isEmpty(p));

  const cleanCounts = {};
  if (data.tagCounts && typeof data.tagCounts === 'object') {
    for (const [k, v] of Object.entries(data.tagCounts)) if (Number.isFinite(v) && v > 0) cleanCounts[k.toLowerCase().slice(0, 24)] = Math.floor(v);
  }
  const cleanExtras = Array.isArray(data.shoppingExtras)
    ? data.shoppingExtras.filter((i) => typeof i === 'string' && i.trim()).map((i) => i.trim().slice(0, 80))
    : [];
  await write([
    { store: 'foods', clear: true },
    { store: 'plans', clear: true },
    { store: 'meta', put: { key: 'shoppingExtras', items: cleanExtras } },
    { store: 'meta', put: { key: 'tagCounts', counts: cleanCounts } },
    ...cleanFoods.map((f) => ({ store: 'foods', put: f })),
    ...cleanPlans.map((p) => ({ store: 'plans', put: p })),
  ]);
  foods.clear(); plans.clear();
  cleanFoods.forEach((f) => foods.set(f.id, f));
  cleanPlans.forEach((p) => plans.set(p.date, p));
  extras = cleanExtras;
  tagCounts = cleanCounts;
  renderAll();
  toast('Backup restored');
}

// ---------- Tabs ----------

const TABS = [
  { tab: 'tab-calendar', panel: 'panel-calendar', title: 'Calendar' },
  { tab: 'tab-food', panel: 'panel-food', title: 'Food' },
  { tab: 'tab-shopping', panel: 'panel-shopping', title: 'Shopping' },
];

function selectTab(index, focus = false) {
  TABS.forEach((t, i) => {
    const on = i === index;
    const btn = document.getElementById(t.tab);
    btn.setAttribute('aria-selected', String(on));
    btn.tabIndex = on ? 0 : -1;
    document.getElementById(t.panel).hidden = !on;
    if (on && focus) btn.focus();
  });
  $('#screen-title').textContent = TABS[index].title;
  document.querySelectorAll('.header-actions').forEach((g) => { g.hidden = Number(g.dataset.tab) !== index; });
  if (index !== 2) setShoppingAddOpen(false);
  document.title = `${TABS[index].title} · Meal Plan`;
  window.scrollTo({ top: 0 });
  if (index === 0) requestAnimationFrame(scrollToToday);
}

function setupTabs() {
  TABS.forEach((t, i) => {
    const btn = document.getElementById(t.tab);
    btn.addEventListener('click', () => selectTab(i));
    btn.addEventListener('keydown', (e) => {
      const keys = { ArrowRight: 1, ArrowLeft: -1 };
      if (e.key in keys) { e.preventDefault(); selectTab((i + keys[e.key] + TABS.length) % TABS.length, true); }
      if (e.key === 'Home') { e.preventDefault(); selectTab(0, true); }
      if (e.key === 'End') { e.preventDefault(); selectTab(TABS.length - 1, true); }
    });
  });
}

// ---------- Wiring ----------

function renderAll() {
  renderCalendar();
  renderFood();
  renderShopping();
  if ($('#planner').open) renderPlanner();
}

function setupEvents() {
  document.querySelectorAll('[data-close]').forEach((b) =>
    b.addEventListener('click', () => b.closest('dialog').close()));

  // Tap outside a sheet to close it
  document.querySelectorAll('dialog').forEach((d) =>
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

  $('#open-planner').addEventListener('click', openPlanner);
  $('#share-plan').addEventListener('click', sharePlan);
  $('#calendar-more').addEventListener('click', () => { extraCalendarDays++; renderCalendar(); });
  $('#calendar-later').addEventListener('click', openLater);
  $('#planner-later').addEventListener('click', openLater);
  $('#later').addEventListener('close', () => {
    const date = $('#later-date').value;
    if ($('#later').returnValue === 'ok' && /^\d{4}-\d{2}-\d{2}$/.test(date)) openPicker(date);
  });
  $('#planner-more').addEventListener('click', () => {
    extraPlannerDays++;
    renderPlanner();
    const last = document.querySelector('#planner-days li:last-child button');
    if (last) last.focus();
  });

  $('#add-food-form').addEventListener('submit', (e) => { e.preventDefault(); $('#new-food-name').blur(); });
  $('#add-food-open').addEventListener('click', () => openFoodEditor());

  $('#picker-add-food').addEventListener('click', pickerAddFood);
  $('#picker-new-food').addEventListener('input', renderPickerFoods);
  $('#new-food-name').addEventListener('input', renderFood);
  $('#picker-new-food').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); pickerAddFood(); }
  });
  $('#note-toggle').addEventListener('click', () => {
    const open = $('#note-toggle').getAttribute('aria-expanded') !== 'true';
    setNoteOpen(open);
    if (open) $('#picker-note').focus();
  });
  $('#picker-form').addEventListener('submit', (e) => {
    if (e.submitter && e.submitter.id === 'picker-save') savePicker();
  });

  $('#food-editor').addEventListener('close', () => {
    if ($('#food-editor').returnValue === 'save') saveFoodEdit();
  });
  $('#food-editor-delete').addEventListener('click', deleteFood);
  $('#food-editor-add-tag').addEventListener('click', addEditorTag);
  $('#food-editor-new-tag').addEventListener('input', renderEditorTags);
  $('#food-editor-new-tag').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addEditorTag(); }
  });

  $('#export-data').addEventListener('click', exportData);
  $('#shopping-add-toggle').addEventListener('click', () =>
    setShoppingAddOpen($('#shopping-add-toggle').getAttribute('aria-expanded') !== 'true'));
  $('#shopping-add-form').addEventListener('submit', addShoppingItems);
  $('#shopping-clear').addEventListener('click', clearShopping);
  $('#import-data').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) importData(file);
  });

  // When the day rolls over (app left open overnight), refresh the view.
  let shownDay = todayKey();
  const checkDay = () => {
    if (todayKey() !== shownDay) {
      shownDay = todayKey();
      extraCalendarDays = 0;
      extraPlannerDays = 0;
      renderAll();
    }
  };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkDay(); });
  setInterval(checkDay, 60_000);
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  if (location.protocol !== 'https:' && !local) return;
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
}

async function init() {
  setupTabs();
  setupEvents();
  db = await openDb();
  const [f, p, meta] = await Promise.all([readAll('foods'), readAll('plans'), readAll('meta')]);
  extras = meta.find((m) => m.key === 'shoppingExtras')?.items || [];
  tagCounts = meta.find((m) => m.key === 'tagCounts')?.counts || {};
  f.forEach((x) => foods.set(x.id, x));
  p.forEach((x) => plans.set(x.date, x));
  renderAll();
  requestAnimationFrame(scrollToToday);
  registerServiceWorker();
}

init();
