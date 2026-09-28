/*
 * SprintTrackerNest "Settings" webview script.
 *
 * Plain browser script — runs INSIDE the VS Code webview. Drives:
 *   - the account name line (shown only when Jira is connected),
 *   - the "Connect Jira" / "Disconnect Jira" button label,
 *   - the "Set Scrum Board" / "Change Scrum Board" button label,
 *   - the "Refresh" button.
 *
 * Labels + the account line are driven by host state messages. setBoardId /
 * connectJira / disconnectJira are stubbed on the host for now; refresh already
 * causes the host to re-push data.
 *
 * Messaging protocol:
 *   host → webview:  {type:"accountState", connected, displayName}
 *                    | {type:"boardState", boardUrl}
 *                    | {type:"syncState", lastFetchedIso}
 *   webview → host:  {type:"ready"} | {type:"refresh"}
 *                    | {type:"setBoardId"} | {type:"connectJira"}
 *                    | {type:"disconnectJira"}
 *
 * Section visibility:
 *   NOT connected      → jira-section only (connect description + Connect button
 *                        in the same section, so no divider between them).
 *   CONNECTED, no board→ account (name + green check + auth line) + board, then
 *                        jira-section (Disconnect) last. Refresh HIDDEN.
 *   CONNECTED, board   → account + board + refresh, then jira-section last.
 * The Refresh section shows ONLY when connected AND a board is set. When a
 * section is hidden we set its [hidden] attribute so the WHOLE element
 * (including its divider border) is removed, and we mark the last VISIBLE
 * section so no trailing divider shows.
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

  function byId(id) {
    return document.getElementById(id);
  }

  function onClick(id, handler) {
    var el = byId(id);
    if (el) {
      el.addEventListener("click", handler);
    }
  }

  // ---- state -------------------------------------------------------------

  var connected = false;
  var boardConfigured = false;

  function setHidden(id, hidden) {
    var el = byId(id);
    if (el) {
      el.hidden = hidden === true;
    }
  }

  // The section elements in TOP-TO-BOTTOM DOM order. updateSectionDividers
  // walks this to find the last visible one and strip its divider. The former
  // standalone connect-description section is gone — its text now lives inside
  // jira-section (Change 6), so there is no divider between it and the Connect
  // button.
  var SECTION_IDS = [
    "account-section",
    "board-section",
    "refresh-section",
    "jira-section"
  ];

  function applyAccountState(isConnected, displayName) {
    connected = isConnected === true;

    // Account name line (1): shown only when connected (full display name).
    var nameEl = byId("account-name");
    if (nameEl) {
      nameEl.textContent =
        connected && typeof displayName === "string" ? displayName : "";
    }
    // The whole account section (name row + green check + auth line) is shown
    // only when connected. The check + auth line live inside it, so hiding the
    // section hides them too — same visibility rule as the account name.
    setHidden("account-section", !connected);

    // Connect-description (now inside jira-section): shown ONLY when NOT
    // connected; hidden when connected.
    setHidden("connect-desc", connected);

    // Board (2) section (incl. divider) hidden when NOT connected.
    setHidden("board-section", !connected);

    // Refresh (3) visibility also depends on whether a board is set (Change 5).
    updateRefreshVisibility();

    // Connect/Disconnect button (4): ALWAYS shown; label + posted message flip.
    var connectBtn = byId("connect-jira-button");
    if (connectBtn) {
      connectBtn.textContent = connected ? "Disconnect Jira" : "Connect Jira";
    }

    updateSectionDividers();
  }

  // The Refresh section (its whole .sp-section incl. divider + the "Last synced"
  // line) is shown ONLY when connected AND a board is set (Change 5). Not
  // connected, or connected with no board ⇒ hidden.
  function updateRefreshVisibility() {
    setHidden("refresh-section", !(connected && boardConfigured));
  }

  // Strip the divider border from the last VISIBLE section so the bottom of the
  // panel never shows a trailing rule, regardless of which sections are hidden.
  function updateSectionDividers() {
    var lastVisible = null;
    for (var i = 0; i < SECTION_IDS.length; i++) {
      var el = byId(SECTION_IDS[i]);
      if (el) {
        el.classList.remove("sp-section-last");
        if (!el.hidden) {
          lastVisible = el;
        }
      }
    }
    if (lastVisible) {
      lastVisible.classList.add("sp-section-last");
    }
  }

  function applyBoardState(boardUrl) {
    boardConfigured = typeof boardUrl === "string" && boardUrl.length > 0;
    var boardBtn = byId("set-board-id-button");
    if (boardBtn) {
      boardBtn.textContent = boardConfigured ? "Change Scrum Board" : "Set Scrum Board";
    }
    // The Refresh section depends on boardConfigured (Change 5). Re-evaluate its
    // visibility and re-run the last-visible-divider logic after the change.
    updateRefreshVisibility();
    updateSectionDividers();
  }

  // Format an ISO timestamp like "Oct 9, 2026, 2:45 PM", or "Never synced".
  function formatLastSynced(iso) {
    if (typeof iso !== "string" || iso.length === 0) {
      return "Never synced";
    }
    var d = new Date(iso);
    if (isNaN(d.getTime())) {
      return "Never synced";
    }
    var datePart = d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric"
    });
    var timePart = d.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit"
    });
    return "Last synced: " + datePart + ", " + timePart;
  }

  function applySyncState(iso) {
    setText("last-synced", formatLastSynced(iso));
  }

  function setText(id, text) {
    var el = byId(id);
    if (el) {
      el.textContent = text == null ? "" : String(text);
    }
  }

  // ---- wiring ------------------------------------------------------------

  function wireActions() {
    onClick("connect-jira-button", function () {
      post({ type: connected ? "disconnectJira" : "connectJira" });
    });
    onClick("set-board-id-button", function () {
      post({ type: "setBoardId" });
    });
    onClick("refresh-button", function () {
      post({ type: "refresh" });
    });
  }

  // Show/hide the loading spinner overlay. This is an INDICATOR only — it must
  // never clear or replace the currently-rendered content.
  function applyLoading(isLoading) {
    setHidden("loading-indicator", isLoading !== true);
  }

  function onMessage(event) {
    var msg = event && event.data;
    if (!msg || typeof msg !== "object") {
      return;
    }
    if (msg.type === "accountState") {
      applyAccountState(msg.connected, msg.displayName);
    } else if (msg.type === "boardState") {
      applyBoardState(msg.boardUrl);
    } else if (msg.type === "syncState") {
      applySyncState(msg.lastFetchedIso);
    } else if (msg.type === "loading") {
      applyLoading(msg.isLoading);
    }
  }

  function init() {
    // Default to a not-connected / no-board state until the host says otherwise.
    applyAccountState(false, null);
    applyBoardState(null);
    applySyncState(null);
    wireActions();
    window.addEventListener("message", onMessage);
    post({ type: "ready" });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
