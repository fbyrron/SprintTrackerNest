/*
 * SprintPulse "Current Sprint" webview script.
 *
 * Plain browser script — runs INSIDE the VS Code webview. No modules, no
 * imports. Uses acquireVsCodeApi() for postMessage.
 *
 * Renders two sub-sections from the single SprintViewModel payload:
 *   (a) current sprint  (b) sprint health
 * (Ticket progress moved to the "Jira Tickets" view.)
 *
 * Messaging protocol:
 *   - On DOMContentLoaded, post {type:"ready"} to the host.
 *   - Listen for {type:"viewModel", payload} → render; {type:"error", message}
 *     → show the error card.
 */
(function () {
  "use strict";

  var vscode =
    typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;

  function post(message) {
    if (vscode && typeof vscode.postMessage === "function") {
      vscode.postMessage(message);
    }
  }

  // ---- small DOM/util helpers -------------------------------------------

  function byId(id) {
    return document.getElementById(id);
  }

  function setText(id, text) {
    var el = byId(id);
    if (el) {
      el.textContent = text == null ? "" : String(text);
    }
  }

  function show(id) {
    var el = byId(id);
    if (el) {
      el.hidden = false;
    }
  }

  function hide(id) {
    var el = byId(id);
    if (el) {
      el.hidden = true;
    }
  }

  function truncate(str, max) {
    var s = str == null ? "" : String(str);
    if (s.length <= max) {
      return s;
    }
    if (max <= 1) {
      return s.slice(0, max);
    }
    return s.slice(0, max - 1) + "…";
  }

  var ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  function formatLocaleDate(iso) {
    if (typeof iso !== "string" || !ISO_DATE_RE.test(iso)) {
      return typeof iso === "string" ? iso : "";
    }
    var parts = iso.split("-");
    var year = parseInt(parts[0], 10);
    var month = parseInt(parts[1], 10);
    var day = parseInt(parts[2], 10);
    var d = new Date(year, month - 1, day);
    if (isNaN(d.getTime())) {
      return iso;
    }
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric"
    });
  }

  function toPercent(fraction) {
    var n = typeof fraction === "number" && isFinite(fraction) ? fraction : 0;
    var pct = Math.round(n * 100);
    if (pct < 0) {
      return 0;
    }
    if (pct > 100) {
      return 100;
    }
    return pct;
  }

  // ---- section renderers -------------------------------------------------

  // (a) CURRENT SPRINT
  function renderCurrentSprint(vm) {
    var sprint = vm.currentSprint;
    var timeline = vm.timeline;

    if (!sprint) {
      hide("current-sprint-content");
      show("current-sprint-empty");
      return;
    }

    show("current-sprint-content");
    hide("current-sprint-empty");

    setText("current-sprint-name", truncate(sprint.name, 60));
    setText("current-sprint-start", formatLocaleDate(sprint.startDate));
    setText("current-sprint-end", formatLocaleDate(sprint.endDate));

    var remaining =
      timeline && typeof timeline.remainingBusinessDays === "number"
        ? Math.max(0, Math.round(timeline.remainingBusinessDays))
        : 0;
    setText("current-sprint-remaining", remaining);

    var pct = timeline ? toPercent(timeline.timelineProgress) : 0;
    var fill = byId("timeline-progress-fill");
    if (fill) {
      fill.style.width = pct + "%";
    }
    setText("timeline-progress-label", pct + "%");
  }

  // (b) HEALTH
  var HEALTH_ICONS = {
    ahead: "✅",
    onTrack: "✅",
    behind: "⚠",
    atRisk: "🔴"
  };
  var HEALTH_COLOR_CLASSES = ["health-green", "health-yellow", "health-red"];

  function renderHealth(vm) {
    var health = vm.health;

    if (!health) {
      hide("sprint-health-content");
      var emptyMsg = vm.currentSprint
        ? "Health cannot be computed."
        : "Health unavailable — no active sprint.";
      setText("sprint-health-empty", emptyMsg);
      show("sprint-health-empty");
      return;
    }

    show("sprint-health-content");
    hide("sprint-health-empty");

    setText("health-label", health.label);
    setText("health-icon", HEALTH_ICONS[health.band] || "");

    var badge = byId("health-badge");
    if (badge) {
      for (var i = 0; i < HEALTH_COLOR_CLASSES.length; i++) {
        badge.classList.remove(HEALTH_COLOR_CLASSES[i]);
      }
      var colorClass =
        health.color === "green"
          ? "health-green"
          : health.color === "yellow"
          ? "health-yellow"
          : health.color === "red"
          ? "health-red"
          : null;
      if (colorClass) {
        badge.classList.add(colorClass);
      }
    }
  }

  // ---- top-level render + messaging --------------------------------------

  function renderViewModel(vm) {
    if (!vm || typeof vm !== "object") {
      return;
    }
    hide("error-card");
    hide("not-connected");
    renderCurrentSprint(vm);
    renderHealth(vm);
  }

  function showError(message) {
    hide("not-connected");
    setText("error-message", message || "Sprint data is unavailable.");
    show("error-card");
  }

  // Calm, muted empty state (NOT an error). Reused for BOTH the not-connected
  // and connected-but-no-board signals by swapping the two text lines. Hide the
  // error card and the sprint + health content, then show #not-connected.
  function showEmptyState(primary, secondary) {
    hide("error-card");
    hide("current-sprint-content");
    hide("current-sprint-empty");
    hide("sprint-health-content");
    hide("sprint-health-empty");
    setText("empty-line-primary", primary);
    setText("empty-line-secondary", secondary);
    show("not-connected");
  }

  function showNotConnected() {
    showEmptyState(
      "Not connected to Jira.",
      "Connect in Settings to see your sprint."
    );
  }

  function showConnectedNoBoard() {
    showEmptyState(
      "Jira Connected.",
      "Set scrum board id in Settings to see your current sprint."
    );
  }

  // Show/hide the loading spinner overlay. This is an INDICATOR only — it must
  // never clear or replace the currently-rendered content.
  function applyLoading(isLoading) {
    if (isLoading === true) {
      show("loading-indicator");
    } else {
      hide("loading-indicator");
    }
  }

  function onMessage(event) {
    var msg = event && event.data;
    if (!msg || typeof msg !== "object") {
      return;
    }
    if (msg.type === "viewModel") {
      renderViewModel(msg.payload);
    } else if (msg.type === "error") {
      showError(msg.message);
    } else if (msg.type === "notConnected") {
      showNotConnected();
    } else if (msg.type === "connectedNoBoard") {
      showConnectedNoBoard();
    } else if (msg.type === "loading") {
      applyLoading(msg.isLoading);
    }
  }

  function init() {
    window.addEventListener("message", onMessage);
    post({ type: "ready" });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
