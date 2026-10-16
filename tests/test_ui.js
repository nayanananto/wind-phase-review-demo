"use strict";

// Actual UI code, inert DOM/fetch/timer stubs: no browser or provider requests.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const staticDir = path.resolve(__dirname, "../app/hitl/ui_static");
const html = fs.readFileSync(path.join(staticDir, "index.html"), "utf8");
const source = fs.readFileSync(path.join(staticDir, "app.js"), "utf8");
const css = fs.readFileSync(path.join(staticDir, "styles.css"), "utf8");
const PROMPTS = Object.freeze({
  predictPhase: "predict next phase",
  explainState: "explain current live state",
  retrieveHistory: "retrieve similar historical windows",
  whyPhase: "why was this phase selected?",
  closestWindow: "Which retrieved historical window is most similar to the current window?",
  alternatives: "Why was this phase selected instead of the other candidate phases?",
  bangla: "Explain the previous answer in Bengali using simple language.",
  explainRetrieved: "Explain the data in the retrieved historical windows.",
  retrievalDistance: "Explain what d (retrieval distance) means in the retrieved historical windows.",
  farthestWindow: "Which of the retrieved historical windows is farthest from the current window?",
});
const EXPECTED_PROMPTS = Object.values(PROMPTS);
const STARTER_PROMPTS = [PROMPTS.predictPhase, PROMPTS.explainState, PROMPTS.retrieveHistory];
const STYLE_PROMPTS = [PROMPTS.bangla];
const FORECAST_PROMPTS = [PROMPTS.whyPhase, PROMPTS.alternatives];
const HISTORY_PROMPTS = [PROMPTS.explainRetrieved, PROMPTS.retrievalDistance,
  PROMPTS.closestWindow, PROMPTS.farthestWindow];

const forecastResponse = (thread = "session-one") => ({ summary: {
  intent: "phase_prediction", mode: "deterministic_live_phase_prediction",
  agent_graph: { route: "phase_prediction" }, thread_id: thread,
  answer: "The stored transitions favor this phase.",
  top_phase_candidates: [
    { token_id: 0, regime_name: "SteadyModerate", probability: 0.889, count: 72 },
    { token_id: 7, regime_name: "LightSteady", probability: 0.111, count: 9 },
  ],
} });
const historyResponse = (thread = "session-one") => ({ summary: {
  intent: "retrieve_similar", mode: "retrieve_similar", agent_graph: { route: "retrieve_similar" },
  thread_id: thread, answer: "Retrieved similar historical windows.",
  similar_windows: [{ window_id: "historical-example", retrieval_distance: 0.1427 },
    { window_id: "historical-example-farther", retrieval_distance: 0.3521 }],
} });
const stateResponse = (thread = "session-one") => ({ summary: {
  intent: "explain_state", mode: "explain_window", agent_graph: { route: "explain_state" },
  thread_id: thread, answer: "The current wind state is steady.",
} });
const followupResponse = () => ({ summary: {
  mode: "memory_rag_followup", agent_graph: { route: "memory_followup" },
  thread_id: "session-one", answer: "An explanation based on the previous evidence.",
} });
const availablePrompts = (ui) => JSON.parse(vm.runInContext(
  "JSON.stringify(getPromptSuggestions().map(item => item.prompt))", ui.context));

function element() {
  const attributes = new Map();
  const classes = new Set();
  return {
    innerHTML: "", textContent: "", value: "", className: "", title: "",
    dataset: {}, disabled: false, scrollTop: 0, scrollHeight: 0,
    children: [], listeners: new Map(), submitRequests: 0,
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle(name, force) {
        const present = force === undefined ? !classes.has(name) : force;
        if (present) classes.add(name); else classes.delete(name);
        return present;
      },
    },
    addEventListener(name, callback) {
      const listeners = this.listeners.get(name) || [];
      listeners.push(callback);
      this.listeners.set(name, listeners);
    },
    setAttribute: (name, value) => attributes.set(name, String(value)),
    getAttribute: (name) => attributes.get(name) ?? null,
    appendChild(child) {
      this.children.push(child);
      this.scrollHeight = this.children.length;
    },
    focus() {}, remove() {},
    requestSubmit() { this.submitRequests += 1; },
  };
}

function emit(target, name, properties = {}) {
  const event = { target, preventDefault() {}, ...properties };
  return Promise.all((target.listeners.get(name) || []).map((listener) => listener(event)));
}

function timers() {
  let sequence = 0;
  const intervals = new Map();
  const timeouts = new Map();
  return {
    intervals, timeouts,
    setInterval(callback, delay) {
      const id = ++sequence;
      intervals.set(id, { callback, delay });
      return id;
    },
    clearInterval: (id) => intervals.delete(id),
    setTimeout(callback, delay) {
      const id = ++sequence;
      timeouts.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => timeouts.delete(id),
    tick() { for (const { callback } of intervals.values()) callback(); },
    finishFade() {
      for (const [id, { callback }] of [...timeouts.entries()]) {
        timeouts.delete(id);
        callback();
      }
    },
  };
}

async function loadUi({ reducedMotion = false, llmEnabled = true, request } = {}) {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  const nodes = new Map(ids.map((id) => [id, element()]));
  const document = Object.assign(element(), {
    hidden: false, activeElement: null,
    getElementById: (id) => nodes.get(id) ?? null,
    createElement: () => element(),
  });
  for (const node of nodes.values()) {
    node.focus = () => {
      document.activeElement = node;
      emit(node, "focus");
    };
  }
  const messages = nodes.get("messages");
  const welcome = nodes.get("welcomeState");
  messages.classList.add("is-empty");
  messages.children.push(welcome);
  welcome.remove = () => {
    nodes.delete("welcomeState");
    messages.children = messages.children.filter((child) => child !== welcome);
  };
  const clock = timers();
  const media = Object.assign(element(), { matches: reducedMotion });
  const fetched = [];
  const context = vm.createContext({
    document,
    window: { matchMedia: (query) => {
      assert.equal(query, "(prefers-reduced-motion: reduce)");
      return media;
    } },
    setInterval: clock.setInterval, clearInterval: clock.clearInterval,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    fetch: async (url, options) => {
      fetched.push({ url, options });
      if (url === "/api/defaults") return {
        ok: true,
        json: async () => ({ data_mode: "snapshot", data_as_of: "2026-06-11T05:54:00+00:00",
          llm_enabled_by_default: llmEnabled }),
      };
      assert.equal(url, "/api/hitl");
      if (request) return request(url, options);
      return { ok: true, json: async () => ({ summary: { answer: "A test reply." } }) };
    },
  });
  vm.runInContext(source, context, { filename: "app.js" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fetched.map(({ url }) => url), ["/api/defaults"]);
  return { context, nodes, document, clock, media, fetched, welcome };
}

test("simplified page offers one suggestion near composer, not action/protocol panels", async () => {
  assert.doesNotMatch(html, /<aside\b|Core Actions|Active Protocol|topbar-meta|data-prompt=/);
  const cssUrl = html.match(/<link\b[^>]*href="(\/static\/styles\.css[^\"]*)"/)?.[1];
  const jsUrl = html.match(/<script\b[^>]*src="(\/static\/app\.js[^\"]*)"/)?.[1];
  assert.ok(cssUrl && jsUrl, "both UI assets must be referenced");
  const cssVersion = new URL(cssUrl, "http://ui.test").searchParams.get("v");
  const jsVersion = new URL(jsUrl, "http://ui.test").searchParams.get("v");
  assert.ok(cssVersion?.trim(), "CSS needs a nonempty cache-busting version");
  assert.equal(jsVersion, cssVersion, "CSS and JS must share one UI version");
  assert.doesNotMatch(html, /(?:href="\/static\/styles\.css"|src="\/static\/app\.js")/);
  const icons = [...html.matchAll(/<svg\b([^>]*)>/g)];
  assert.equal(icons.length, 4);
  for (const [, attributes] of icons) {
    for (const dimension of ["width", "height"]) {
      const value = attributes.match(new RegExp(`\\b${dimension}="(\\d+(?:\\.\\d+)?)"`))?.[1];
      assert.ok(value && Number(value) > 0, `SVG needs a positive intrinsic ${dimension}`);
    }
  }
  const button = html.match(/<button\b[^>]*\bid="promptSuggestion"[^>]*>/)?.[0];
  assert.ok(button);
  assert.match(button, /\btype="button"/);
  assert.equal((html.match(/id="promptSuggestion"/g) || []).length, 1);
  assert.match(html, /id="promptSuggestionText"/);
  assert.match(html, /id="pauseSuggestions"/);
  assert.match(html, /id="question"[^>]*maxlength="1500"/);
  assert.ok(html.indexOf('id="promptSuggestion"') < html.indexOf('id="chatForm"'));
  const visiblePage = html.replace(/<[^>]*>/g, " ");
  assert.doesNotMatch(visiblePage, /\b(?:accept|approve|flag|feedback)\b|\b(?:add|record|save) (?:a )?note\b/i);
  const { context } = await loadUi();
  assert.deepEqual(JSON.parse(vm.runInContext(
    "JSON.stringify(PROMPT_SUGGESTIONS.map(item => item.prompt))", context)), EXPECTED_PROMPTS);
});

test("static welcome stays uncluttered while snapshot and LLM status are accurate", async () => {
  const { nodes, welcome } = await loadUi();
  assert.deepEqual(nodes.get("messages").children, [welcome]);
  assert.match(html, /Explore the next wind phase/);
  assert.match(nodes.get("metadataStatus").textContent, /Observation snapshot/);
  assert.match(nodes.get("metadataStatus").textContent, /11 Jun 2026/);
  assert.match(nodes.get("metadataStatus").textContent, /05:54 UTC/);
  assert.equal(nodes.get("metadataStatus").title, "2026-06-11T05:54:00+00:00");
  assert.equal(nodes.get("llmStatus").textContent, "LLM explanations enabled");
  const disabled = await loadUi({ llmEnabled: false });
  assert.equal(disabled.nodes.get("llmStatus").textContent, "Deterministic explanations");
});

test("suggestion catalog has ten unique actions without repetitive explanation variants", async () => {
  const { context } = await loadUi();
  const catalog = JSON.parse(vm.runInContext("JSON.stringify(PROMPT_SUGGESTIONS)", context));
  assert.equal(catalog.length, 10);
  assert.equal(new Set(catalog.map((item) => item.id)).size, catalog.length);
  const normalize = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  assert.equal(new Set(catalog.map((item) => normalize(item.prompt))).size, catalog.length);
  assert.equal(new Set(catalog.map((item) => normalize(item.text))).size, catalog.length);
  for (const item of catalog) {
    assert.doesNotMatch(`${item.text} ${item.prompt}`,
      /\b(?:technical|jargon|brief(?:ly)?|concise|evidence|confidence|reliable)\b/i);
  }
});

test("startup rotates only three starting actions without modifying a focused draft or sending", async () => {
  const { nodes, clock, fetched } = await loadUi();
  const button = nodes.get("promptSuggestion");
  const label = nodes.get("promptSuggestionText");
  const input = nodes.get("question");
  input.value = "An unfinished question";
  input.focus();
  assert.equal(button.dataset.prompt, PROMPTS.predictPhase);
  assert.equal(clock.intervals.size, 1);
  assert.equal([...clock.intervals.values()][0].delay, 4800);
  for (let index = 1; index <= STARTER_PROMPTS.length * 2; index += 1) {
    const previous = button.dataset.prompt;
    clock.tick();
    assert.equal(button.dataset.prompt, previous);
    assert.ok(label.classList.contains("is-changing"));
    assert.equal([...clock.timeouts.values()][0].delay, 180);
    clock.finishFade();
    assert.equal(button.dataset.prompt, STARTER_PROMPTS[index % STARTER_PROMPTS.length]);
    assert.ok(!label.classList.contains("is-changing"));
    assert.equal(input.value, "An unfinished question");
  }
  assert.equal(fetched.length, 1);
});

test("clicking current suggestion fills/focuses input but never submits", async () => {
  const { nodes, document, clock, fetched } = await loadUi();
  clock.tick(); clock.finishFade();
  await emit(nodes.get("promptSuggestion"), "click");
  assert.equal(nodes.get("question").value, PROMPTS.explainState);
  assert.equal(document.activeElement, nodes.get("question"));
  assert.equal(nodes.get("chatForm").submitRequests, 0);
  assert.equal(fetched.length, 1);
  assert.equal(nodes.get("messages").children.length, 1);
  clock.tick(); clock.finishFade();
  assert.equal(nodes.get("promptSuggestion").dataset.prompt, PROMPTS.retrieveHistory);
  assert.equal(nodes.get("question").value, PROMPTS.explainState);
});

test("every unlocked follow-up fills only its own prompt without submitting or stopping rotation", async () => {
  const ui = await loadUi();
  const { nodes, clock, fetched, context } = ui;
  context.updateSuggestionProgress(PROMPTS.predictPhase, forecastResponse());
  context.updateSuggestionProgress(PROMPTS.explainState, stateResponse());
  context.updateSuggestionProgress(PROMPTS.retrieveHistory, historyResponse());
  context.updateSuggestionProgress("Tell me more about these retrieved windows", followupResponse());
  const pool = availablePrompts(ui);
  assert.deepEqual(pool, [...HISTORY_PROMPTS, ...STYLE_PROMPTS]);
  const button = nodes.get("promptSuggestion");
  const input = nodes.get("question");
  for (const prompt of pool) {
    assert.equal(button.dataset.prompt, prompt);
    await emit(button, "click");
    assert.equal(input.value, prompt);
    clock.tick(); clock.finishFade();
    assert.equal(input.value, prompt);
  }
  assert.equal(nodes.get("chatForm").submitRequests, 0);
  assert.equal(fetched.length, 1);
  assert.equal(nodes.get("messages").children.length, 1);
});

test("successful forecast unlocks why/alternatives first but not historical comparison", async () => {
  const ui = await loadUi();
  assert.deepEqual(availablePrompts(ui), STARTER_PROMPTS);
  await emit(ui.nodes.get("promptSuggestion"), "click");
  assert.deepEqual(availablePrompts(ui), STARTER_PROMPTS);
  ui.context.updateSuggestionProgress("Forecast the next wind regime", forecastResponse());
  assert.deepEqual(availablePrompts(ui), [...FORECAST_PROMPTS, PROMPTS.explainState, PROMPTS.retrieveHistory]);
  assert.equal(ui.nodes.get("promptSuggestion").dataset.prompt, PROMPTS.whyPhase);
});

test("history retrieval offers data, distance and window comparisons in order", async () => {
  const ui = await loadUi();
  ui.context.updateSuggestionProgress(PROMPTS.retrieveHistory, historyResponse());
  assert.deepEqual(availablePrompts(ui), [...HISTORY_PROMPTS, PROMPTS.predictPhase, PROMPTS.explainState]);
  assert.equal(ui.nodes.get("promptSuggestion").dataset.prompt, PROMPTS.explainRetrieved);
});

test("alternative comparisons require more than one returned phase candidate", async () => {
  const ui = await loadUi();
  ui.context.updateSuggestionProgress(PROMPTS.predictPhase, forecastResponse());
  assert.ok(availablePrompts(ui).includes(PROMPTS.alternatives));
  const singleCandidate = forecastResponse();
  singleCandidate.summary.top_phase_candidates = singleCandidate.summary.top_phase_candidates.slice(0, 1);
  ui.context.updateSuggestionProgress(PROMPTS.predictPhase, singleCandidate);
  assert.ok(availablePrompts(ui).includes(PROMPTS.whyPhase));
  assert.ok(!availablePrompts(ui).includes(PROMPTS.alternatives));
});

test("farthest-window comparison requires two retrieved matches", async () => {
  const ui = await loadUi();
  ui.context.updateSuggestionProgress(PROMPTS.retrieveHistory, historyResponse());
  assert.ok(availablePrompts(ui).includes(PROMPTS.farthestWindow));
  const singleMatch = historyResponse();
  singleMatch.summary.similar_windows = singleMatch.summary.similar_windows.slice(0, 1);
  ui.context.updateSuggestionProgress(PROMPTS.retrieveHistory, singleMatch);
  assert.ok(availablePrompts(ui).includes(PROMPTS.closestWindow));
  assert.ok(!availablePrompts(ui).includes(PROMPTS.farthestWindow));
});

test("a retrieval explanation opens the Bangla follow-up and skips only the answered child", async () => {
  const ui = await loadUi();
  ui.context.updateSuggestionProgress(PROMPTS.retrieveHistory, historyResponse());
  assert.ok(!availablePrompts(ui).includes(PROMPTS.bangla));
  ui.context.updateSuggestionProgress(PROMPTS.explainRetrieved, followupResponse());
  assert.deepEqual(availablePrompts(ui), [...HISTORY_PROMPTS.slice(1), ...STYLE_PROMPTS,
    PROMPTS.predictPhase, PROMPTS.explainState]);
  ui.context.updateSuggestionProgress(PROMPTS.retrievalDistance, followupResponse());
  assert.deepEqual(availablePrompts(ui).slice(0, 2), [PROMPTS.closestWindow, PROMPTS.farthestWindow]);
});

test("ordinary manually typed follow-ups are also recorded as answered", async () => {
  const ui = await loadUi();
  ui.context.updateSuggestionProgress(PROMPTS.predictPhase, forecastResponse());
  ui.context.updateSuggestionProgress("why not the other phases?", followupResponse());
  assert.ok(availablePrompts(ui).includes(PROMPTS.whyPhase));
  assert.ok(!availablePrompts(ui).includes(PROMPTS.alternatives));
  ui.context.updateSuggestionProgress("why this phase?", followupResponse());
  assert.ok(!availablePrompts(ui).includes(PROMPTS.whyPhase));
  ui.context.updateSuggestionProgress("Explain in Bangla", followupResponse());
  assert.ok(!availablePrompts(ui).includes(PROMPTS.bangla));
});

test("small talk, blocked questions and failures preserve the active branch and progress", async () => {
  const ui = await loadUi();
  ui.context.updateSuggestionProgress(PROMPTS.retrieveHistory, historyResponse());
  ui.context.updateSuggestionProgress(PROMPTS.explainRetrieved, followupResponse());
  const before = availablePrompts(ui);
  const visible = ui.nodes.get("promptSuggestion").dataset.prompt;
  for (const payload of [null, { summary: {} },
    { summary: { mode: "casual_conversation", answer: "Thanks!" } },
    { summary: { mode: "out_of_scope", answer: "Unsupported question." } },
    { summary: { mode: "out_of_scope", answer: "HITL does not support this request.",
      intent: "memory_followup", agent_graph: { route: "memory_followup" },
      memory_rag_debug: { llm_attempted: true, llm_used: false } } },
    { summary: { mode: "memory_followup_error", intent: "memory_followup",
      agent_graph: { route: "memory_followup" }, answer: "HITL does not support this request." } },
    { summary: { mode: "memory_rag_unavailable", intent: "memory_followup",
      agent_graph: { route: "memory_followup" }, answer: "This HITL system does not support this request." } },
    { summary: { mode: "phase_forecast_error", intent: "phase_prediction", answer: "Failed." } }]) {
    ui.context.updateSuggestionProgress(PROMPTS.retrievalDistance, payload);
    assert.deepEqual(availablePrompts(ui), before);
    assert.equal(ui.nodes.get("promptSuggestion").dataset.prompt, visible);
  }
});

test("state explanation unlocks only answer-style follow-ups and remaining starting actions", async () => {
  const ui = await loadUi();
  ui.context.updateSuggestionProgress(PROMPTS.explainState, stateResponse());
  assert.deepEqual(availablePrompts(ui), [...STYLE_PROMPTS, PROMPTS.predictPhase, PROMPTS.retrieveHistory]);
  ui.context.updateSuggestionProgress("Explain the current wind state in Bangla", stateResponse());
  assert.deepEqual(availablePrompts(ui), [PROMPTS.predictPhase, PROMPTS.retrieveHistory]);
});

test("completed follow-ups are skipped and a fresh core result makes them useful again", async () => {
  const ui = await loadUi();
  ui.context.updateSuggestionProgress(PROMPTS.predictPhase, forecastResponse());
  ui.context.updateSuggestionProgress("  WHY WAS THIS PHASE SELECTED?!  ", followupResponse());
  assert.ok(!availablePrompts(ui).includes(PROMPTS.whyPhase));
  assert.equal(availablePrompts(ui)[0], PROMPTS.alternatives);
  ui.context.updateSuggestionProgress(PROMPTS.bangla, followupResponse());
  assert.ok(!availablePrompts(ui).includes(PROMPTS.bangla));
  ui.context.updateSuggestionProgress(PROMPTS.predictPhase, forecastResponse());
  assert.equal(availablePrompts(ui)[0], PROMPTS.whyPhase);
  assert.ok(!availablePrompts(ui).includes(PROMPTS.bangla));
  ui.context.updateSuggestionProgress(PROMPTS.whyPhase, followupResponse());
  assert.ok(availablePrompts(ui).includes(PROMPTS.bangla));
});

test("switching core actions replaces the branch without leaking old follow-ups", async () => {
  const ui = await loadUi();
  ui.context.updateSuggestionProgress(PROMPTS.predictPhase, forecastResponse());
  ui.context.updateSuggestionProgress(PROMPTS.retrieveHistory, historyResponse());
  assert.deepEqual(availablePrompts(ui), [...HISTORY_PROMPTS, PROMPTS.explainState]);
  assert.ok(!availablePrompts(ui).includes(PROMPTS.whyPhase));
  ui.context.updateSuggestionProgress(PROMPTS.explainState, stateResponse());
  assert.deepEqual(availablePrompts(ui), STYLE_PROMPTS);
  assert.ok(!availablePrompts(ui).includes(PROMPTS.whyPhase));
  assert.ok(!availablePrompts(ui).includes(PROMPTS.closestWindow));
  ui.context.updateSuggestionProgress(PROMPTS.predictPhase, forecastResponse());
  assert.deepEqual(availablePrompts(ui), FORECAST_PROMPTS);
});

test("finishing all eligible questions falls back to a nonempty starting-action carousel", async () => {
  const ui = await loadUi();
  ui.context.updateSuggestionProgress(PROMPTS.predictPhase, forecastResponse());
  ui.context.updateSuggestionProgress(PROMPTS.explainState, stateResponse());
  ui.context.updateSuggestionProgress(PROMPTS.retrieveHistory, historyResponse());
  for (const prompt of [...HISTORY_PROMPTS, ...STYLE_PROMPTS]) ui.context.updateSuggestionProgress(prompt, followupResponse());
  assert.deepEqual(availablePrompts(ui), STARTER_PROMPTS);
  ui.clock.tick(); ui.clock.finishFade();
  assert.ok(STARTER_PROMPTS.includes(ui.nodes.get("promptSuggestion").dataset.prompt));
});

test("casual, blocked, failed, empty and ungrounded replies never unlock dependent prompts", async () => {
  const ui = await loadUi();
  const invalid = [null, { summary: {} },
    { summary: { mode: "casual_conversation", answer: "Hello!", top_phase_candidates: [{ token_id: 0 }] } },
    { summary: { mode: "out_of_scope", answer: "Cannot handle that.", agent_graph: { route: "out_of_scope" }, similar_windows: [{}] } },
    { summary: { mode: "out_of_scope", answer: "HITL does not support this request.",
      intent: "memory_followup", agent_graph: { route: "memory_followup" } } },
    { summary: { mode: "memory_followup_error", intent: "memory_followup",
      agent_graph: { route: "memory_followup" }, answer: "HITL does not support this request." } },
    { summary: { mode: "memory_rag_unavailable", intent: "memory_followup",
      agent_graph: { route: "memory_followup" }, answer: "This HITL system does not support this request." } },
    { summary: { intent: "phase_prediction", answer: "No forecast", top_phase_candidates: [] } },
    { summary: { intent: "retrieve_similar", answer: "No matches", similar_windows: [] } },
    { summary: { intent: "phase_prediction", mode: "phase_forecast_error", answer: "Failed", top_phase_candidates: [{}] } },
    { summary: { intent: "explain_state", answer: "" } },
  ];
  for (const payload of invalid) {
    ui.context.updateSuggestionProgress(PROMPTS.predictPhase, payload);
    assert.deepEqual(availablePrompts(ui), STARTER_PROMPTS);
  }
  // An explanation of an old result is not proof that this page ran a forecast.
  ui.context.updateSuggestionProgress(PROMPTS.whyPhase, followupResponse());
  assert.ok(!availablePrompts(ui).includes(PROMPTS.whyPhase));
  assert.ok(!availablePrompts(ui).includes(PROMPTS.alternatives));
});

test("new session, missing server memory and reload discard stale prerequisites", async () => {
  const ui = await loadUi();
  ui.context.updateSuggestionProgress(PROMPTS.predictPhase, forecastResponse());
  ui.context.updateSuggestionProgress(PROMPTS.retrieveHistory, historyResponse());
  ui.context.updateSuggestionProgress(PROMPTS.explainState, stateResponse("session-two"));
  assert.deepEqual(availablePrompts(ui), [...STYLE_PROMPTS, PROMPTS.predictPhase, PROMPTS.retrieveHistory]);
  ui.context.updateSuggestionProgress("Explain the previous result", { summary: {
    mode: "memory_rag_missing_context", thread_id: "session-two", answer: "Run a core tool first.",
  } });
  assert.deepEqual(availablePrompts(ui), STARTER_PROMPTS);
  assert.equal(ui.nodes.get("promptSuggestion").dataset.prompt, PROMPTS.predictPhase);
  assert.deepEqual(availablePrompts(await loadUi()), STARTER_PROMPTS);
});

test("unrelated small talk does not restart the initial carousel or unlock follow-ups", async () => {
  const ui = await loadUi();
  ui.clock.tick(); ui.clock.finishFade();
  ui.context.updateSuggestionProgress("Hello", { summary: { mode: "casual_conversation", answer: "Hello!" } });
  assert.equal(ui.nodes.get("promptSuggestion").dataset.prompt, PROMPTS.explainState);
  assert.deepEqual(availablePrompts(ui), STARTER_PROMPTS);
  ui.clock.tick(); ui.clock.finishFade();
  assert.equal(ui.nodes.get("promptSuggestion").dataset.prompt, PROMPTS.retrieveHistory);
});

test("response-driven refresh cancels old fades and preserves manual pause and input drafts", async () => {
  const ui = await loadUi();
  const input = ui.nodes.get("question");
  input.value = "Keep this next question";
  ui.clock.tick();
  assert.equal(ui.clock.timeouts.size, 1);
  ui.context.updateSuggestionProgress(PROMPTS.predictPhase, forecastResponse());
  assert.equal(ui.clock.timeouts.size, 0);
  assert.equal(ui.nodes.get("promptSuggestion").dataset.prompt, PROMPTS.whyPhase);
  assert.equal(input.value, "Keep this next question");
  await emit(ui.nodes.get("pauseSuggestions"), "click");
  ui.context.updateSuggestionProgress(PROMPTS.retrieveHistory, historyResponse());
  ui.clock.tick(); ui.clock.finishFade();
  assert.equal(ui.nodes.get("promptSuggestion").dataset.prompt, PROMPTS.explainRetrieved);
  assert.equal(ui.nodes.get("pauseSuggestions").getAttribute("aria-pressed"), "true");
  assert.equal(input.value, "Keep this next question");
});

test("hover and keyboard focus do not stop suggestions or overwrite the draft", async () => {
  const { nodes, clock } = await loadUi();
  const button = nodes.get("promptSuggestion");
  const input = nodes.get("question");
  input.value = "Keep this draft";
  await emit(button, "mouseenter");
  button.focus();
  clock.tick(); clock.finishFade();
  assert.equal(button.dataset.prompt, PROMPTS.explainState);
  input.focus();
  clock.tick(); clock.finishFade();
  assert.equal(button.dataset.prompt, PROMPTS.retrieveHistory);
  assert.equal(input.value, "Keep this draft");
});

test("pressing a suggestion cancels an in-flight fade without stopping later rotation", async () => {
  const { nodes, clock, fetched } = await loadUi();
  const button = nodes.get("promptSuggestion");
  clock.tick();
  assert.equal(clock.timeouts.size, 1);
  await emit(button, "pointerdown");
  assert.equal(clock.timeouts.size, 0);
  await emit(button, "click");
  assert.equal(nodes.get("question").value, PROMPTS.predictPhase);
  clock.tick(); clock.finishFade();
  assert.equal(button.dataset.prompt, PROMPTS.explainState);
  assert.equal(nodes.get("question").value, PROMPTS.predictPhase);
  assert.equal(fetched.length, 1);
});

test("hidden tabs pause rotation and cancel pending fades, then resume when visible", async () => {
  const { nodes, document, clock } = await loadUi();
  const button = nodes.get("promptSuggestion");
  const label = nodes.get("promptSuggestionText");
  const initial = button.dataset.prompt;
  clock.tick();
  assert.equal(clock.timeouts.size, 1);
  document.hidden = true;
  await emit(document, "visibilitychange");
  assert.equal(clock.timeouts.size, 0);
  assert.ok(!label.classList.contains("is-changing"));
  clock.tick(); clock.finishFade();
  assert.equal(button.dataset.prompt, initial);
  document.hidden = false;
  await emit(document, "visibilitychange");
  clock.tick(); clock.finishFade();
  assert.equal(button.dataset.prompt, PROMPTS.explainState);
});

test("manual pause/resume is accessible and reduced motion swaps without fading", async () => {
  const { nodes, clock } = await loadUi();
  const pause = nodes.get("pauseSuggestions");
  const suggestion = nodes.get("promptSuggestion");
  await emit(pause, "click");
  assert.equal(pause.getAttribute("aria-pressed"), "true");
  assert.equal(pause.getAttribute("aria-label"), "Resume prompt suggestions");
  clock.tick(); clock.finishFade();
  assert.equal(suggestion.dataset.prompt, PROMPTS.predictPhase);
  await emit(pause, "click");
  assert.equal(pause.getAttribute("aria-pressed"), "false");
  assert.equal(pause.getAttribute("aria-label"), "Pause prompt suggestions");
  clock.tick(); clock.finishFade();
  assert.equal(suggestion.dataset.prompt, PROMPTS.explainState);
  const reduced = await loadUi({ reducedMotion: true });
  reduced.clock.tick();
  assert.equal(reduced.nodes.get("promptSuggestion").dataset.prompt, PROMPTS.explainState);
  assert.equal(reduced.clock.timeouts.size, 0);
  assert.ok(!reduced.nodes.get("promptSuggestionText").classList.contains("is-changing"));
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  const mobile = css.match(/@media\s*\(max-width:\s*640px\)([\s\S]*?)(?=@media|$)/)?.[1];
  assert.ok(mobile);
  assert.match(mobile, /(?:\.composer )?textarea\s*\{[^}]*font-size:\s*16px/);
  assert.match(mobile, /\.topbar\s*\{[^}]*flex-wrap:\s*wrap/);
});

test("scientific replies keep essential metadata/tables and collapse diagnostic details", async () => {
  const { context } = await loadUi();
  const rendered = context.renderResponse({ summary: {
    intent: "phase_prediction", mode: "phase_forecast", answer: "The snapshot favors this regime.",
    window_id: "live_KBOS_snapshot_window", agent_graph: { engine: "langgraph", route: "phase_prediction" },
    llm_requested: true, llm_available: true, live_token_sequence: [7, 7, 0],
    current_live_state: { regime_name: "SteadyModerate" },
    top_phase_candidates: [{ token_id: 0, regime_name: "SteadyModerate", probability: 0.8889, count: 72 }],
    similar_windows: [{ window_id: "historical-example-one", regime_name: "LightSteady", retrieval_distance: 0.1427 }],
    transition_analogs: [{ evidence_id: "transition-example-one", history_tokens: [7, 7, 0], next_token_id: 0, future_window_start: "historical-observation" }],
    memory_rag_debug: { llm_attempted: true, llm_used: true, selected_chunk_ids: ["scientific-evidence-chunk"] },
    review_state: { status: "UI_SHOULD_HIDE_REVIEW", action: "flag", window_id: "hidden-review-window", model_predicted_token: 999 },
    human_review_prompt: "UI_SHOULD_HIDE_REVIEW_PROMPT",
  } });
  const foreground = rendered.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g, "");
  const details = rendered.match(/<details\b[^>]*>([\s\S]*?)<\/details>/)?.[1];
  assert.match(foreground, /route: phase_prediction/);
  assert.match(foreground, /input window: live_KBOS_snapshot_window/);
  assert.match(foreground, /LLM: available/);
  assert.match(foreground, /The snapshot favors this regime/);
  assert.match(foreground, /Phase candidates/);
  assert.match(foreground, /p=0\.889/);
  assert.match(foreground, /Similar historical windows/);
  assert.match(foreground, /historical-example-one/);
  assert.doesNotMatch(foreground, /input tokens:|input regime:|Transition analogs|Memory \/ LLM trace/);
  assert.equal((rendered.match(/<details\b/g) || []).length, 1);
  assert.doesNotMatch(rendered, /<details\b[^>]*\bopen\b/);
  assert.match(details, /Run details/);
  assert.match(details, /input tokens: 7, 7, 0/);
  assert.match(details, /Transition analogs/);
  assert.match(details, /transition-example-one/);
  assert.match(details, /scientific-evidence-chunk/);
  assert.doesNotMatch(rendered, /Human Review State|UI_SHOULD_HIDE_REVIEW|hidden-review-window|model next token: 999|status:/);
});

test("unsupported replies show only the escaped answer even with malformed diagnostic extras", async () => {
  const { context } = await loadUi();
  const rendered = context.renderResponse({ summary: {
    mode: "out_of_scope", answer: "This HITL system does not support this request.",
    intent: "memory_followup", window_id: "HIDDEN_INPUT_WINDOW",
    llm_requested: true, llm_available: true,
    agent_graph: { engine: "langgraph", route: "memory_followup" },
    critic_warnings: { malformed: "HIDDEN_WARNING" },
    top_phase_candidates: { malformed: "HIDDEN_CANDIDATES" },
    similar_windows: { malformed: "HIDDEN_WINDOWS" },
    transition_analogs: { malformed: "HIDDEN_ANALOGS" },
    memory_rag_debug: { llm_attempted: true, llm_used: false,
      fallback_reason: "HIDDEN_FALLBACK_REASON", selected_chunk_ids: ["HIDDEN_CHUNK"] },
  } });
  assert.equal(rendered, '<div class="answer">This HITL system does not support this request.</div>');
  assert.doesNotMatch(rendered, /route:|LLM|Run details|<details|HIDDEN_|<table|warning|meta/);
  assert.equal(context.renderResponse({ summary: {
    mode: "out_of_scope", answer: '<script>alert("x")</script> & unavailable',
  } }), '<div class="answer">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; unavailable</div>');
});

test("casual replies remain isolated, label LLM use and escape generated text", async () => {
  const { context } = await loadUi();
  const rendered = context.renderResponse({ summary: {
    mode: "casual_conversation", answer: '<img src=x onerror="alert(1)"> You\'re welcome & happy to help!',
    llm_used: true, review_state: { status: "UI_SHOULD_HIDE_REVIEW" },
    top_phase_candidates: [{ token_id: 999, regime_name: "SHOULD_NOT_APPEAR" }],
  } });
  assert.match(rendered, /casual conversation/);
  assert.match(rendered, /LLM reply/);
  assert.match(rendered, /&lt;img/);
  assert.match(rendered, /&quot;alert\(1\)&quot;/);
  assert.match(rendered, /&amp; happy to help/);
  assert.doesNotMatch(rendered, /<img|Human Review State|UI_SHOULD_HIDE_REVIEW|SHOULD_NOT_APPEAR|Phase candidates|<details/);
  assert.match(context.renderResponse({ summary: {
    mode: "casual_conversation", answer: "Hello!", llm_used: false,
  } }), /standard reply/);
});

test("suggestions keep rotating while sending, preserve next draft and prevent duplicate submits", async () => {
  let release;
  const ui = await loadUi({ request: () => new Promise((resolve) => { release = resolve; }) });
  const { nodes, clock, fetched } = ui;
  const form = nodes.get("chatForm");
  nodes.get("question").value = "  predict next phase  ";
  const submitting = emit(form, "submit");
  assert.equal(fetched.length, 2);
  assert.equal(fetched[1].options.body, JSON.stringify({ question: PROMPTS.predictPhase }));
  assert.equal(nodes.get("sendButton").disabled, true);
  assert.equal(form.getAttribute("aria-busy"), "true");
  assert.equal(nodes.get("question").value, "");
  assert.equal(nodes.has("welcomeState"), false);
  assert.equal(nodes.get("messages").children.length, 2);
  assert.deepEqual(availablePrompts(ui), STARTER_PROMPTS);
  nodes.get("question").value = "another question";
  nodes.get("question").focus();
  await emit(form, "submit");
  assert.equal(fetched.length, 2);
  assert.equal(nodes.get("question").value, "another question");
  clock.tick(); clock.finishFade();
  assert.equal(nodes.get("promptSuggestion").dataset.prompt, PROMPTS.explainState);
  assert.equal(nodes.get("question").value, "another question");
  release({ ok: true, json: async () => forecastResponse() });
  await submitting;
  assert.equal(nodes.get("sendButton").disabled, false);
  assert.equal(form.getAttribute("aria-busy"), "false");
  assert.equal(nodes.get("promptSuggestion").dataset.prompt, PROMPTS.whyPhase);
  clock.tick(); clock.finishFade();
  assert.equal(nodes.get("promptSuggestion").dataset.prompt, PROMPTS.alternatives);
  assert.equal(nodes.get("question").value, "another question");
});

test("HTTP/network failures restore sending, user HTML is escaped, Enter handles Shift/IME", async () => {
  for (const failure of [
    () => { throw new Error("Test offline"); },
    () => ({ ok: false, statusText: "Test error", json: async () => ({ detail: "Test rate limit" }) }),
  ]) {
    const { nodes } = await loadUi({ request: failure });
    const form = nodes.get("chatForm");
    nodes.get("question").value = '<img src=x onerror="alert(1)">';
    await emit(form, "submit");
    assert.equal(nodes.get("sendButton").disabled, false);
    assert.equal(form.getAttribute("aria-busy"), "false");
    assert.match(nodes.get("messages").children[0].innerHTML, /&lt;img/);
    assert.doesNotMatch(nodes.get("messages").children[0].innerHTML, /<img/);
    assert.match(nodes.get("messages").children[1].innerHTML, /Could not reach the demo|Test rate limit/);
    await emit(nodes.get("question"), "keydown", { key: "Enter", shiftKey: true });
    await emit(nodes.get("question"), "keydown", { key: "Enter", isComposing: true });
    assert.equal(form.submitRequests, 0);
    await emit(nodes.get("question"), "keydown", { key: "Enter", shiftKey: false, isComposing: false });
    assert.equal(form.submitRequests, 1);
  }
});
