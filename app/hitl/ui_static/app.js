const $ = (id) => document.getElementById(id);
const messages = $("messages");
let isSending = false;

const PROMPT_SUGGESTIONS = [
  { text: "Predict the next wind phase", prompt: "predict next phase" },
  { text: "Explain the current wind state", prompt: "explain current live state" },
  { text: "Find similar historical windows", prompt: "retrieve similar historical windows" },
  { text: "After a forecast: why was this phase selected?", prompt: "why was this phase selected?" },
];

function esc(value) {
  const normalized = value && typeof value === "object"
    ? JSON.stringify(value, null, 2)
    : String(value ?? "");
  return normalized
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function addMessage(role, html) {
  $("welcomeState")?.remove();
  messages.classList.remove("is-empty");
  const node = document.createElement("article");
  node.className = `message ${role}`;
  node.innerHTML = html;
  messages.appendChild(node);
  messages.scrollTop = messages.scrollHeight;
  return node;
}

function pill(text, className = "") {
  return `<span class="pill ${className}">${esc(text)}</span>`;
}

function renderRows(title, rows, type) {
  if (!rows || rows.length === 0) return "";
  const body = rows.map((row) => {
    if (type === "candidate") {
      const prob = typeof row.probability === "number" ? row.probability.toFixed(3) : row.probability;
      return `<div class="row row--candidate"><strong>Token ${esc(row.token_id)}</strong><span>${esc(row.regime_name)}</span><span>p=${esc(prob)}</span><span>n=${esc(row.count)}</span></div>`;
    }
    if (type === "analog") {
      return `<div class="row row--analog"><strong>${esc(row.evidence_id)}</strong><span>${esc(row.history_tokens)}</span><span>next ${esc(row.next_token_id)}</span><span>${esc(row.future_window_start)}</span></div>`;
    }
    const dist = typeof row.retrieval_distance === "number" ? row.retrieval_distance.toFixed(4) : row.retrieval_distance;
    return `<div class="row row--similar"><strong title="${esc(row.window_id)}">${esc(row.window_id)}</strong><span>${esc(row.regime_name)}</span><span>d=${esc(dist)}</span></div>`;
  }).join("");
  return `<div class="section"><h3>${esc(title)}</h3><div class="rows">${body}</div></div>`;
}

function renderMemoryDebug(debug) {
  if (!debug) return "";
  const chunks = (debug.selected_chunk_ids || []).join(", ");
  const kinds = (debug.selected_chunk_kinds || []).map((item) => pill(item)).join("");
  const blockers = (debug.llm_blockers || []).join(", ");
  return `<div class="diagnostic-section">
    <h4>Memory / LLM trace</h4>
    <div class="meta">
      ${pill(`LLM attempted: ${Boolean(debug.llm_attempted)}`)}
      ${pill(`LLM used: ${Boolean(debug.llm_used)}`)}
      ${debug.llm_output_format ? pill(`format: ${debug.llm_output_format}`) : ""}
    </div>
    ${kinds ? `<div class="meta">${kinds}</div>` : ""}
    ${chunks ? `<div class="answer">Chunks: ${esc(chunks)}</div>` : ""}
    ${blockers ? `<div class="answer">LLM blockers: ${esc(blockers)}</div>` : ""}
    ${debug.llm_fallback_reason ? `<div class="answer">Fallback: ${esc(debug.llm_fallback_reason)}</div>` : ""}
  </div>`;
}

function renderTechnicalDetails(s) {
  const liveState = s.current_live_state || {};
  const details = [
    s.intent ? `intent: ${s.intent}` : null,
    s.confidence != null ? `confidence: ${s.confidence}` : null,
    s.mode ? `mode: ${s.mode}` : null,
    s.live_token_sequence ? `input tokens: ${s.live_token_sequence.join(", ")}` : null,
    liveState.regime_name ? `input regime: ${liveState.regime_name}` : null,
    s.retrieval_context ? `retrieval: ${s.retrieval_context}` : null,
    s.explanation_context ? `explain context: ${s.explanation_context}` : null,
    s.explanation_mode ? `explain mode: ${s.explanation_mode}` : null,
    s.phase_transition_source ? `phase source: ${s.phase_transition_source}` : null,
    s.forecast_model_source ? `model: ${s.forecast_model_source}` : null,
    s.agent_graph ? `agent: ${s.agent_graph.engine}/${s.agent_graph.route}` : null,
    s.router?.source ? `router: ${s.router.source}` : null,
    s.thread_id ? `thread: ${s.thread_id}` : null,
  ].filter(Boolean);
  const analogs = renderRows("Transition analogs", s.transition_analogs, "analog");
  const debug = renderMemoryDebug(s.memory_rag_debug);
  if (!details.length && !analogs && !debug) return "";
  return `<details class="details-box">
    <summary>Run details</summary>
    <div class="details-body">
      ${details.length ? `<div class="meta">${details.map((item) => pill(item)).join("")}</div>` : ""}
      ${analogs}
      ${debug}
    </div>
  </details>`;
}

function renderResponse(payload) {
  const s = payload.summary || {};
  if (s.mode === "casual_conversation") {
    return `<div class="meta">${pill("casual conversation", "strong")}${pill(s.llm_used ? "LLM reply" : "standard reply")}</div>
      <div class="answer">${esc(s.answer || "Hello! Ask me about the wind forecast or its evidence.")}</div>`;
  }
  const route = s.agent_graph?.route || s.intent || "hitl";
  const primaryMeta = [
    pill(`route: ${route}`, "strong"),
    s.window_id ? pill(`input window: ${s.window_id}`, "window-pill") : null,
    s.llm_requested ? pill(`LLM: ${s.llm_available ? "available" : "unavailable"}`) : pill("LLM: off"),
  ].filter(Boolean).join("");
  const warnings = [...new Set([
    ...(s.critic_warnings || []),
    s.phase_low_support ? `low support: n=${s.phase_support}` : null,
    s.model_warning || null,
  ].filter(Boolean))];
  const hasSimilarTable = Array.isArray(s.similar_windows) && s.similar_windows.length > 0;
  const hideRedundantRetrievalAnswer = s.intent === "retrieve_similar" && hasSimilarTable;
  return `
    <div class="meta">${primaryMeta}</div>
    ${warnings.length ? `<div class="meta">${warnings.map((item) => pill(item, "warning")).join("")}</div>` : ""}
    ${hideRedundantRetrievalAnswer ? "" : `<div class="answer">${esc(s.answer || "No answer returned.")}</div>`}
    ${renderRows("Phase candidates", s.top_phase_candidates, "candidate")}
    ${renderRows("Similar historical windows", s.similar_windows, "similar")}
    ${renderTechnicalDetails(s)}
  `;
}

function requestBody(question) {
  // File paths, model settings and session identity are controlled by the server.
  return { question };
}

async function send(question) {
  isSending = true;
  $("sendButton").disabled = true;
  $("chatForm").setAttribute("aria-busy", "true");
  addMessage("user", `<div class="answer">${esc(question)}</div>`);
  const pending = addMessage("assistant", `<div class="answer">Working on it...</div>`);
  try {
    const response = await fetch("/api/hitl", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody(question)),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      pending.innerHTML = `<div class="answer error">${esc(err.detail || response.statusText)}</div>`;
      return;
    }
    pending.innerHTML = renderResponse(await response.json());
  } catch {
    pending.innerHTML = `<div class="answer error">Could not reach the demo. Please try again.</div>`;
  } finally {
    isSending = false;
    $("sendButton").disabled = false;
    $("chatForm").setAttribute("aria-busy", "false");
    messages.scrollTop = messages.scrollHeight;
  }
}

function startPromptSuggestions() {
  const button = $("promptSuggestion");
  const label = $("promptSuggestionText");
  const pauseButton = $("pauseSuggestions");
  const input = $("question");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let index = 0;
  let hovered = false;
  let manuallyPaused = false;
  let fadeTimer = null;

  const isPaused = () => manuallyPaused || hovered || document.hidden || isSending
    || document.activeElement === button || document.activeElement === input;
  const render = () => {
    const suggestion = PROMPT_SUGGESTIONS[index];
    label.textContent = suggestion.text;
    button.dataset.prompt = suggestion.prompt;
    button.title = `Use example: ${suggestion.prompt}`;
  };
  const cancelFade = () => {
    if (fadeTimer !== null) clearTimeout(fadeTimer);
    fadeTimer = null;
    label.classList.remove("is-changing");
  };
  const advance = () => {
    index = (index + 1) % PROMPT_SUGGESTIONS.length;
    render();
  };

  button.addEventListener("click", () => {
    cancelFade();
    input.value = PROMPT_SUGGESTIONS[index].prompt;
    input.focus();
  });
  button.addEventListener("mouseenter", () => { hovered = true; cancelFade(); });
  button.addEventListener("mouseleave", () => { hovered = false; });
  button.addEventListener("focus", cancelFade);
  input.addEventListener("focus", cancelFade);
  document.addEventListener("visibilitychange", () => { if (document.hidden) cancelFade(); });
  reducedMotion.addEventListener?.("change", cancelFade);
  pauseButton.addEventListener("click", () => {
    manuallyPaused = !manuallyPaused;
    cancelFade();
    pauseButton.classList.toggle("is-paused", manuallyPaused);
    pauseButton.setAttribute("aria-pressed", String(manuallyPaused));
    pauseButton.setAttribute("aria-label", `${manuallyPaused ? "Resume" : "Pause"} prompt suggestions`);
    pauseButton.title = `${manuallyPaused ? "Resume" : "Pause"} examples`;
  });

  render();
  setInterval(() => {
    if (isPaused()) return;
    if (reducedMotion.matches) { advance(); return; }
    label.classList.add("is-changing");
    fadeTimer = setTimeout(() => {
      fadeTimer = null;
      if (!isPaused()) advance();
      label.classList.remove("is-changing");
    }, 180);
  }, 4800);
}

async function init() {
  const response = await fetch("/api/defaults");
  if (!response.ok) throw new Error("Could not load the observation context. Please refresh to retry.");
  const defaults = await response.json();
  const snapshot = defaults.data_mode === "snapshot" || defaults.data_mode === "snapshot_fallback";
  const modeText = snapshot ? "Observation snapshot" : "Observations refreshed at startup";
  const observedAt = defaults.data_as_of ? new Date(defaults.data_as_of) : null;
  const timestamp = observedAt && !Number.isNaN(observedAt.getTime())
    ? ` · ${new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" }).format(observedAt)} UTC`
    : defaults.data_as_of ? ` · ${defaults.data_as_of}` : "";
  $("metadataStatus").textContent = `${modeText}${timestamp}`;
  $("metadataStatus").title = defaults.data_as_of || modeText;
  $("llmStatus").textContent = defaults.llm_enabled_by_default ? "LLM explanations enabled" : "Deterministic explanations";
}

$("chatForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = $("question").value.trim();
  if (!question || isSending) return;
  $("question").value = "";
  await send(question);
});

$("question").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("chatForm").requestSubmit();
  }
});

startPromptSuggestions();
init().catch((error) => {
  $("metadataStatus").textContent = "Observation context unavailable";
  $("llmStatus").textContent = "Explanation mode unavailable";
  addMessage("assistant", `<div class="answer error">${esc(error.message)}</div>`);
});
