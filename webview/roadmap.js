/*
 * SprintTrackerNest "Jira Tickets" webview script (view id sprintpulse.roadmap).
 *
 * Plain browser script — runs INSIDE the VS Code webview. Renders:
 *   1. A ticket progress bar (percent = done/total) + one collapsible sub-group
 *      per active-sprint board COLUMN, each listing the connected user's own
 *      tickets as KEY + summary. Driven by {type:"ticketBoard"}.
 *   2. Next Sprint (name + start date, with empty states). Driven by the
 *      {type:"viewModel"} payload.
 * and manages the "Open Board" block (shown only when a board URL is set).
 *
 * The sub-groups are HAND-BUILT collapsibles: a header button with a chevron
 * glyph that rotates, toggling `.sp-collapsed` on the enclosing `.sp-group`.
 * The per-column collapsibles are built at runtime; all start expanded.
 *
 * Messaging protocol:
 *   host → webview:  {type:"viewModel", payload} | {type:"error", message}
 *                    | {type:"boardState", boardUrl}
 *                    | {type:"ticketBoard", payload: TicketBoardData | null}
 *   webview → host:  {type:"ready"} | {type:"openBoard"}
 *
 * "Open Board" posts {type:"openBoard"}; the host opens the board URL. When no
 * board URL is configured ({type:"boardState", boardUrl:null}) the entire Open
 * Board block is hidden.
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

  function numOrZero(v) {
    return typeof v === "number" && isFinite(v) ? v : 0;
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

  // ---- (1) ticket board: progress bar + per-column ticket lists ----------
  //
  // Driven entirely by {type:"ticketBoard", payload: TicketBoardData | null}.
  // The progress bar percent = done/total (0 when total 0). Below it we build
  // one collapsible sub-group per board column, each listing the connected
  // user's tickets as KEY + summary. payload === null clears everything.

  var SUMMARY_MAX = 80;
  var columnSeq = 0; // unique id source for per-column collapsible sections

  // True while the view is showing a calm empty state — EITHER "not connected"
  // OR "connected but no board". The host pushes a null ticketBoard/boardState
  // right after {type:"notConnected"} / {type:"connectedNoBoard"}; this flag
  // lets those null-payload handlers keep the clutter hidden instead of
  // re-revealing an empty progress bar / columns. Cleared as soon as any real
  // viewModel or non-null ticketBoard arrives.
  var isEmptyState = false;

  function applyProgressBar(done, total) {
    var d = numOrZero(done);
    var t = numOrZero(total);
    var pct = t > 0 ? Math.round((d / t) * 100) : 0;
    if (pct < 0) {
      pct = 0;
    }
    if (pct > 100) {
      pct = 100;
    }
    var fill = byId("ticket-progress-fill");
    if (fill) {
      fill.style.width = pct + "%";
    }
    setText("ticket-progress-label", pct + "% (" + d + " / " + t + ")");
  }

  function renderTicketBoard(board) {
    var host = byId("ticket-columns");
    if (!host) {
      return;
    }
    hide("error-card");

    // Clear any previously rendered columns.
    while (host.firstChild) {
      host.removeChild(host.firstChild);
    }

    if (!board || typeof board !== "object") {
      // Null payload: reset the bar. If we are in the disconnected state the
      // whole section stays hidden; otherwise show the "No tickets" empty
      // state within the (visible) section.
      applyProgressBar(0, 0);
      if (isEmptyState) {
        return;
      }
      show("ticket-columns-empty");
      return;
    }

    // A non-null board is real data ⇒ leave the empty state and restore the
    // progress/columns section the normal render path populates.
    isEmptyState = false;
    hide("not-connected");
    show("ticket-progress-section");

    applyProgressBar(board.done, board.total);

    var columns = Array.isArray(board.columns) ? board.columns : [];
    if (columns.length === 0) {
      show("ticket-columns-empty");
      return;
    }
    hide("ticket-columns-empty");

    for (var i = 0; i < columns.length; i++) {
      host.appendChild(buildColumnSection(columns[i]));
    }
    // Newly-created headers need their toggle handlers wired.
    wireCollapsibles();
  }

  // Build one collapsible `.sp-section.sp-group` for a board column. Expanded
  // by default; the header shows the column name + a muted "(n)" count.
  function buildColumnSection(column) {
    var name =
      column && typeof column.name === "string" ? column.name : "Column";
    var tickets =
      column && Array.isArray(column.tickets) ? column.tickets : [];

    var sectionId = "ticket-column-" + columnSeq++;

    var section = document.createElement("section");
    section.className = "sp-section sp-group";
    section.id = sectionId;

    var header = document.createElement("button");
    header.type = "button";
    header.className = "sp-group-header";
    header.setAttribute("aria-expanded", "true");
    header.setAttribute("data-toggle", sectionId);

    var chevron = document.createElement("span");
    chevron.className = "sp-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = "›";

    var title = document.createElement("span");
    title.className = "sp-group-title";
    title.textContent = name;

    var detail = document.createElement("span");
    detail.className = "sp-group-detail";
    detail.textContent = "(" + tickets.length + ")";

    header.appendChild(chevron);
    header.appendChild(title);
    header.appendChild(detail);

    var body = document.createElement("div");
    body.className = "sp-group-body";

    if (tickets.length === 0) {
      var empty = document.createElement("p");
      empty.className = "sp-ticket-empty";
      empty.textContent = "No tickets";
      body.appendChild(empty);
    } else {
      var list = document.createElement("ul");
      list.className = "sp-ticket-list";
      for (var i = 0; i < tickets.length; i++) {
        list.appendChild(buildTicketRow(tickets[i]));
      }
      body.appendChild(list);
    }

    section.appendChild(header);
    section.appendChild(body);
    return section;
  }

  // Build a single ticket row: monospaced KEY + ellipsized summary (with the
  // full summary in a title attribute).
  function buildTicketRow(ticket) {
    var key =
      ticket && typeof ticket.key === "string" ? ticket.key : "";
    var summary =
      ticket && typeof ticket.summary === "string" ? ticket.summary : "";

    var li = document.createElement("li");
    li.className = "sp-ticket-row";

    var keyEl = document.createElement("span");
    keyEl.className = "sp-ticket-key";
    keyEl.textContent = key;

    var summaryEl = document.createElement("span");
    summaryEl.className = "sp-ticket-summary";
    summaryEl.textContent = truncate(summary, SUMMARY_MAX);
    if (summary.length > 0) {
      summaryEl.title = summary;
    }

    li.appendChild(keyEl);
    li.appendChild(summaryEl);
    return li;
  }

  // ---- (2) next sprint ---------------------------------------------------

  function renderNextSprint(vm) {
    var next = vm.nextSprint;

    if (next && typeof next === "object") {
      setText("next-sprint-name", truncate(next.name, 60));
      setText("next-sprint-start", formatLocaleDate(next.startDate));
      setText("next-sprint-detail", truncate(next.name, 24));
      show("next-sprint-content");
      hide("next-sprint-empty");
      return;
    }

    setText("next-sprint-detail", "");
    hide("next-sprint-content");
    // If there IS an active sprint but no next one resolved, it "cannot be
    // determined"; otherwise there is simply nothing scheduled.
    var emptyMsg = vm.currentSprint
      ? "Next sprint cannot be determined."
      : "No next sprint scheduled.";
    setText("next-sprint-empty", emptyMsg);
    show("next-sprint-empty");
  }

  // ---- collapsible sub-groups (MCP-style) --------------------------------

  function toggleGroup(sectionId) {
    var section = byId(sectionId);
    if (!section) {
      return;
    }
    var collapsed = section.classList.toggle("sp-collapsed");
    var header = section.querySelector(".sp-group-header");
    if (header) {
      header.setAttribute("aria-expanded", collapsed ? "false" : "true");
    }
  }

  function wireCollapsibles() {
    var headers = document.querySelectorAll(".sp-group-header");
    for (var i = 0; i < headers.length; i++) {
      (function (header) {
        header.addEventListener("click", function () {
          var target = header.getAttribute("data-toggle");
          if (target) {
            toggleGroup(target);
          }
        });
      })(headers[i]);
    }
  }

  // ---- Open Board block --------------------------------------------------

  // Track whether a board URL is configured so the click handler can no-op when
  // the block is hidden (belt-and-braces alongside the [hidden] attribute).
  var boardConfigured = false;

  function applyBoardState(boardUrl) {
    boardConfigured = typeof boardUrl === "string" && boardUrl.length > 0;
    var btn = byId("open-board-button");
    if (boardConfigured) {
      show("open-board-block");
      if (btn) {
        btn.disabled = false;
        btn.title = "Open the board in your browser";
      }
    } else {
      // Hide the whole block (description + button) when no board URL is set.
      hide("open-board-block");
      if (btn) {
        btn.disabled = true;
      }
    }
  }

  function wireOpenBoard() {
    var btn = byId("open-board-button");
    if (btn) {
      btn.addEventListener("click", function () {
        if (!boardConfigured) {
          return;
        }
        post({ type: "openBoard" });
      });
    }
  }

  // ---- messaging ---------------------------------------------------------

  function renderViewModel(vm) {
    if (!vm || typeof vm !== "object") {
      return;
    }
    hide("error-card");
    // A real view model arrived ⇒ leave the empty state and restore the
    // Next Sprint sub-group the normal render path populates.
    isEmptyState = false;
    hide("not-connected");
    show("next-sprint-section");
    // The progress bar + columns come from {type:"ticketBoard"}; the view model
    // still drives the Next Sprint sub-group.
    renderNextSprint(vm);
  }

  function showError(message) {
    isEmptyState = false;
    hide("not-connected");
    setText("error-message", message || "Sprint data is unavailable.");
    show("error-card");
  }

  // Calm, muted empty state (NOT an error). Reused for BOTH the not-connected
  // and connected-but-no-board signals by swapping the two text lines. Hide the
  // error card and ALL the ticket clutter (progress bar + columns + empty
  // fallback, Next Sprint sub-group, and the Open Board block), then show
  // #not-connected. This clears the stale "0% (0/0)" bar and the leftover
  // "Next Sprint …" line while in the empty state. Sets isEmptyState so the
  // host's subsequent null ticketBoard/boardState pushes don't re-reveal the
  // empty bar.
  function showEmptyState(primary, secondary) {
    isEmptyState = true;
    hide("error-card");
    hide("ticket-progress-section"); // progress bar + #ticket-columns + empty
    hide("next-sprint-section"); // Next Sprint sub-group
    hide("open-board-block"); // Open Board block
    setText("empty-line-primary", primary);
    setText("empty-line-secondary", secondary);
    show("not-connected");
  }

  function showNotConnected() {
    showEmptyState(
      "Not connected to Jira.",
      "Connect in Settings to see your tickets."
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
    } else if (msg.type === "ticketBoard") {
      renderTicketBoard(msg.payload);
    } else if (msg.type === "error") {
      showError(msg.message);
    } else if (msg.type === "notConnected") {
      showNotConnected();
    } else if (msg.type === "connectedNoBoard") {
      showConnectedNoBoard();
    } else if (msg.type === "boardState") {
      applyBoardState(msg.boardUrl);
    } else if (msg.type === "loading") {
      applyLoading(msg.isLoading);
    }
  }

  function init() {
    wireCollapsibles();
    wireOpenBoard();
    window.addEventListener("message", onMessage);
    post({ type: "ready" });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
