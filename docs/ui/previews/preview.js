/*
 * PREVIEW ONLY. Tiny helpers for the static design previews:
 * icons, dark/light theme, panel width, state switcher, and a few clicks that move
 * between states so a flow can be walked through. Not application code.
 */
(function () {
  "use strict";

  var THEME_KEY = "dl-preview-theme";
  var WIDTH_KEY = "dl-preview-width";
  var STATUS_CYCLE_MS = 1800;
  var CLOCK_TICK_MS = 1000;

  /* Codicon-like icons, drawn on a 16x16 grid. */
  var DOT = 'fill="currentColor" stroke="none"';
  var ICONS = {
    person: '<circle cx="8" cy="5" r="2.75"/><path d="M2.75 14c0-2.9 2.35-4.75 5.25-4.75s5.25 1.85 5.25 4.75"/>',
    hubot: '<rect x="2.5" y="5" width="11" height="8.5" rx="2"/><path d="M8 5V2.75M6 11.25h4"/><circle cx="8" cy="2.25" r=".75" ' + DOT + '/><circle cx="5.75" cy="8.75" r="1" ' + DOT + '/><circle cx="10.25" cy="8.75" r="1" ' + DOT + "/>",
    "git-commit": '<circle cx="8" cy="8" r="2.5"/><path d="M1.5 8h4M10.5 8h4"/>',
    file: '<path d="M4 1.5h5l3.5 3.5v9.5h-8.5z"/><path d="M9 1.5V5h3.5"/>',
    "file-diff": '<path d="M4 1.5h5l3.5 3.5v9.5h-8.5z"/><path d="M9 1.5V5h3.5M8.25 6.75v3.5M6.5 8.5h3.5M6.5 12h3.5"/>',
    chevron: '<path d="M6 3.5 10.5 8 6 12.5"/>',
    "chevron-up": '<path d="M3.5 10 8 5.5 12.5 10"/>',
    "chevron-left": '<path d="M10 3.5 5.5 8 10 12.5"/>',
    stop: '<rect x="4" y="4" width="8" height="8" rx="1" ' + DOT + "/>",
    send: '<path d="M2 2.5 14 8 2 13.5l2-5.5z"/><path d="M4 8h5"/>',
    question: '<circle cx="8" cy="8" r="6.5"/><path d="M6.1 6.2a1.95 1.95 0 1 1 2.7 1.8c-.5.2-.8.6-.8 1.1v.4"/><circle cx="8" cy="11.6" r=".75" ' + DOT + "/>",
    shield: '<path d="M8 1.5 13.5 3.5v4c0 3.4-2.3 5.9-5.5 7-3.2-1.1-5.5-3.6-5.5-7v-4z"/>',
    warning: '<path d="M8 1.75 14.75 13.75H1.25z"/><path d="M8 6v3.75"/><circle cx="8" cy="11.75" r=".75" ' + DOT + "/>",
    error: '<circle cx="8" cy="8" r="6.5"/><path d="m5.75 5.75 4.5 4.5M10.25 5.75l-4.5 4.5"/>',
    check: '<path d="M3 8.5 6.5 12 13 4.5"/>',
    loading: '<path d="M14.5 8A6.5 6.5 0 1 1 8 1.5"/>',
    add: '<path d="M8 2.5v11M2.5 8h11"/>',
    "link-external": '<path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5"/><path d="M12 9.5v4H2.5V4h4"/>',
    copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M10.5 5.5v-3h-8v8h3"/>',
    terminal: '<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="m4.5 6 2.5 2-2.5 2M8.5 10.5h3"/>',
    pencil: '<path d="M10.5 2.5 13.5 5.5 6 13H3v-3z"/><path d="m9 4 3 3"/>',
    search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3.5 3.5"/>',
    "arrow-down": '<path d="M8 2.5v11M3.5 9 8 13.5 12.5 9"/>',
    refresh: '<path d="M13.5 8A5.5 5.5 0 1 1 11.9 4.1"/><path d="M13.5 2v3.5H10"/>',
    key: '<circle cx="5" cy="11" r="2.75"/><path d="m7 9 6.5-6.5M11 4.5l2 2"/>',
    info: '<circle cx="8" cy="8" r="6.5"/><path d="M8 7.25v4"/><circle cx="8" cy="4.9" r=".75" ' + DOT + "/>",
    ellipsis: '<circle cx="3.5" cy="8" r="1" ' + DOT + '/><circle cx="8" cy="8" r="1" ' + DOT + '/><circle cx="12.5" cy="8" r="1" ' + DOT + "/>",
    "sign-in": '<path d="M7 2.5h6.5v11H7"/><path d="M1.5 8h8M7 5.5 9.5 8 7 10.5"/>',
    replace: '<path d="M2.5 5.5h9M9 3l2.5 2.5L9 8M13.5 10.5h-9M7 8l-2.5 2.5L7 13"/>',
    text: '<path d="M2.5 4h11M2.5 8h11M2.5 12h7"/>',
    ledger: { viewBox: "0 0 24 24", strokeWidth: "1.6", body: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 7v10"/><path d="M6 10c0 2 2 2 4 2h6"/>' }
  };

  applyTheme(readSetting(THEME_KEY, "theme", "dark"));
  document.addEventListener("DOMContentLoaded", init);

  function init() {
    expandIncludes(document);
    renderIcons(document);
    wireToggleGroup("[data-set-theme]", "setTheme", applyTheme, readSetting(THEME_KEY, "theme", "dark"));
    wireToggleGroup("[data-set-width]", "setWidth", applyWidth, readSetting(WIDTH_KEY, "width", "narrow"));
    wireStates();
    wireInteractions();
    startLiveDemo();
  }

  /* ---------- settings ---------- */

  function readSetting(storageKey, queryName, fallback) {
    var fromQuery = new URLSearchParams(location.search).get(queryName);
    if (fromQuery) return fromQuery;
    try { return localStorage.getItem(storageKey) || fallback; } catch (e) { return fallback; }
  }

  function saveSetting(storageKey, value) {
    try { localStorage.setItem(storageKey, value); } catch (e) { /* file:// storage can be blocked; the toggle still works for this page */ }
  }

  function applyTheme(theme) {
    var root = document.documentElement;
    root.classList.remove("theme-dark", "theme-light");
    root.classList.add(theme === "light" ? "theme-light" : "theme-dark");
    saveSetting(THEME_KEY, theme);
  }

  function applyWidth(width) {
    document.querySelectorAll(".pv-frame").forEach(function (frame) { frame.dataset.width = width; });
    saveSetting(WIDTH_KEY, width);
  }

  function wireToggleGroup(selector, dataKey, apply, initial) {
    var buttons = Array.prototype.slice.call(document.querySelectorAll(selector));
    if (!buttons.length) return;
    function select(value) {
      apply(value);
      buttons.forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset[dataKey] === value)); });
    }
    buttons.forEach(function (b) { b.addEventListener("click", function () { select(b.dataset[dataKey]); }); });
    select(initial);
  }

  /* ---------- templates and icons ---------- */

  function expandIncludes(root) {
    var placeholder;
    while ((placeholder = root.querySelector("[data-include]"))) {
      var template = document.getElementById(placeholder.dataset.include);
      placeholder.replaceWith(template.content.cloneNode(true));
    }
  }

  function renderIcons(root) {
    root.querySelectorAll("[data-icon]").forEach(function (el) {
      var icon = ICONS[el.dataset.icon];
      if (!icon) return;
      var body = typeof icon === "string" ? icon : icon.body;
      var viewBox = icon.viewBox || "0 0 16 16";
      var strokeWidth = icon.strokeWidth || "1.2";
      el.innerHTML = '<svg viewBox="' + viewBox + '" fill="none" stroke="currentColor" stroke-width="' + strokeWidth +
        '" stroke-linecap="round" stroke-linejoin="round" focusable="false">' + body + "</svg>";
      el.setAttribute("aria-hidden", "true");
    });
  }

  /* ---------- state switcher ---------- */

  function wireStates() {
    var states = Array.prototype.slice.call(document.querySelectorAll(".pv-state"));
    var select = document.getElementById("pv-state-select");
    if (!states.length || !select) return;
    states.forEach(function (s) {
      var option = document.createElement("option");
      option.value = s.dataset.state;
      option.textContent = s.dataset.label;
      select.appendChild(option);
    });
    select.addEventListener("change", function () { location.hash = select.value; });
    document.querySelectorAll("[data-step-state]").forEach(function (button) {
      button.addEventListener("click", function () {
        var index = states.findIndex(function (s) { return !s.hidden; });
        var next = states[(index + Number(button.dataset.stepState) + states.length) % states.length];
        location.hash = next.dataset.state;
      });
    });
    window.addEventListener("hashchange", function () { showState(states, select); });
    showState(states, select);
  }

  function showState(states, select) {
    var id = decodeURIComponent(location.hash.slice(1));
    var current = states.find(function (s) { return s.dataset.state === id; }) || states[0];
    states.forEach(function (s) { s.hidden = s !== current; });
    select.value = current.dataset.state;
    document.querySelectorAll(".pv-frame").forEach(function (f) { f.dataset.waiting = String(current.dataset.waiting === "true"); });
    document.title = current.dataset.label + " · Chat panel preview";
    current.querySelectorAll("[data-open-on-show]").forEach(function (d) { d.open = true; });
    scrollTranscript(current);
    focusComposerIfAsked(current);
  }

  function scrollTranscript(state) {
    var transcript = state.querySelector(".chat__transcript");
    if (!transcript) return;
    var anchor = state.querySelector("[data-scroll-anchor]");
    if (anchor) anchor.scrollIntoView({ block: "start" });
    else transcript.scrollTop = transcript.scrollHeight;
  }

  function focusComposerIfAsked(state) {
    if (state.dataset.focus !== "composer") return;
    if (!window.matchMedia("(pointer: fine)").matches) return; // don't pop the phone keyboard on load
    var textarea = state.querySelector(".composer textarea");
    if (textarea) textarea.focus({ preventScroll: true });
  }

  /* ---------- clicks that walk through the flow ---------- */

  function wireInteractions() {
    document.addEventListener("click", function (event) {
      var goto = event.target.closest("[data-goto]");
      if (goto && goto.tagName !== "FORM") { event.preventDefault(); location.hash = goto.dataset.goto; return; }
      var closer = event.target.closest("[data-close-details]");
      if (closer) { closeDetails(closer); return; }
      var copy = event.target.closest("[data-copy]");
      if (copy) copyCode(copy);
    });
    document.addEventListener("submit", function (event) {
      var form = event.target;
      event.preventDefault();
      if (form.dataset.goto) location.hash = form.dataset.goto;
    });
    document.addEventListener("keydown", function (event) {
      var inComposer = event.target.closest && event.target.closest(".composer");
      if (event.key === "Enter" && !event.shiftKey && inComposer && event.target.tagName === "TEXTAREA") {
        event.preventDefault();
        var submit = inComposer.querySelector('button[type="submit"]:not([aria-disabled="true"])');
        if (submit) inComposer.requestSubmit(submit);
      }
      if (event.key === "Escape") {
        var visible = document.querySelector(".pv-state:not([hidden]) [data-escape]");
        if (visible) location.hash = visible.dataset.escape;
      }
    });
  }

  function closeDetails(button) {
    var details = button.closest("details");
    if (!details) return;
    details.open = false;
    var summary = details.querySelector("summary");
    summary.scrollIntoView({ block: "nearest" });
    summary.focus();
  }

  function copyCode(button) {
    var code = button.closest(".codeblock").querySelector("code").textContent;
    var label = button.getAttribute("aria-label");
    function done() {
      button.setAttribute("aria-label", "Copied");
      button.title = "Copied";
      setTimeout(function () { button.setAttribute("aria-label", label); button.title = label; }, STATUS_CYCLE_MS);
    }
    if (navigator.clipboard) navigator.clipboard.writeText(code).then(done, done);
    else done();
  }

  /* ---------- live status line demo ---------- */

  function startLiveDemo() {
    document.querySelectorAll("[data-cycle]").forEach(function (el) {
      var lines = el.dataset.cycle.split("|");
      var index = 0;
      setInterval(function () {
        index = (index + 1) % lines.length;
        el.textContent = lines[index];
        el.title = lines[index];
      }, STATUS_CYCLE_MS);
    });
    document.querySelectorAll("[data-clock]").forEach(function (el) {
      var seconds = Number(el.dataset.clock);
      setInterval(function () {
        seconds += 1;
        el.textContent = Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
      }, CLOCK_TICK_MS);
    });
  }
})();
