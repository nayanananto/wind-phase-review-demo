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
const EXPECTED_PROMPTS = ["predict next phase", "explain current live state",
  "retrieve similar historical windows", "why was this phase selected?"];

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

test("suggestions fade through four prompts without modifying input or sending", async () => {
  const { nodes, clock, fetched } = await loadUi();
  const button = nodes.get("promptSuggestion");
  const label = nodes.get("promptSuggestionText");
  const input = nodes.get("question");
  input.value = "An unfinished question";
  assert.equal(button.dataset.prompt, EXPECTED_PROMPTS[0]);
  assert.equal(clock.intervals.size, 1);
  assert.equal([...clock.intervals.values()][0].delay, 4800);
  for (let index = 1; index <= EXPECTED_PROMPTS.length; index += 1) {
    const previous = button.dataset.prompt;
    clock.tick();
    assert.equal(button.dataset.prompt, previous);
    assert.ok(label.classList.contains("is-changing"));
    assert.equal([...clock.timeouts.values()][0].delay, 180);
    clock.finishFade();
    assert.equal(button.dataset.prompt, EXPECTED_PROMPTS[index % EXPECTED_PROMPTS.length]);
    assert.ok(!label.classList.contains("is-changing"));
    assert.equal(input.value, "An unfinished question");
  }
  assert.equal(fetched.length, 1);
});

test("clicking current suggestion fills/focuses input but never submits", async () => {
  const { nodes, document, clock, fetched } = await loadUi();
  clock.tick(); clock.finishFade();
  await emit(nodes.get("promptSuggestion"), "click");
  assert.equal(nodes.get("question").value, EXPECTED_PROMPTS[1]);
  assert.equal(document.activeElement, nodes.get("question"));
  assert.equal(nodes.get("chatForm").submitRequests, 0);
  assert.equal(fetched.length, 1);
  assert.equal(nodes.get("messages").children.length, 1);
});

test("hover, focus and hidden tabs pause rotation and cancel pending fades", async () => {
  const { nodes, document, clock } = await loadUi();
  const button = nodes.get("promptSuggestion");
  const label = nodes.get("promptSuggestionText");
  const initial = button.dataset.prompt;
  clock.tick();
  assert.equal(clock.timeouts.size, 1);
  await emit(button, "mouseenter");
  assert.equal(clock.timeouts.size, 0);
  assert.ok(!label.classList.contains("is-changing"));
  clock.tick(); clock.finishFade();
  assert.equal(button.dataset.prompt, initial);
  await emit(button, "mouseleave");
  for (const focused of [button, nodes.get("question")]) {
    focused.focus(); clock.tick(); clock.finishFade();
    assert.equal(button.dataset.prompt, initial);
  }
  document.activeElement = null;
  clock.tick(); document.hidden = true;
  await emit(document, "visibilitychange");
  assert.equal(clock.timeouts.size, 0);
  clock.tick(); clock.finishFade();
  assert.equal(button.dataset.prompt, initial);
  document.hidden = false;
  await emit(document, "visibilitychange");
  clock.tick(); clock.finishFade();
  assert.equal(button.dataset.prompt, EXPECTED_PROMPTS[1]);
});

test("manual pause/resume is accessible and reduced motion swaps without fading", async () => {
  const { nodes, clock } = await loadUi();
  const pause = nodes.get("pauseSuggestions");
  const suggestion = nodes.get("promptSuggestion");
  await emit(pause, "click");
  assert.equal(pause.getAttribute("aria-pressed"), "true");
  assert.equal(pause.getAttribute("aria-label"), "Resume prompt suggestions");
  clock.tick(); clock.finishFade();
  assert.equal(suggestion.dataset.prompt, EXPECTED_PROMPTS[0]);
  await emit(pause, "click");
  assert.equal(pause.getAttribute("aria-pressed"), "false");
  assert.equal(pause.getAttribute("aria-label"), "Pause prompt suggestions");
  clock.tick(); clock.finishFade();
  assert.equal(suggestion.dataset.prompt, EXPECTED_PROMPTS[1]);
  const reduced = await loadUi({ reducedMotion: true });
  reduced.clock.tick();
  assert.equal(reduced.nodes.get("promptSuggestion").dataset.prompt, EXPECTED_PROMPTS[1]);
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

test("sending pauses suggestions, preserves next draft and prevents duplicate submits", async () => {
  let release;
  const ui = await loadUi({ request: () => new Promise((resolve) => { release = resolve; }) });
  const { nodes, document, clock, fetched } = ui;
  const form = nodes.get("chatForm");
  nodes.get("question").value = "  predict next phase  ";
  const submitting = emit(form, "submit");
  assert.equal(fetched.length, 2);
  assert.equal(fetched[1].options.body, JSON.stringify({ question: EXPECTED_PROMPTS[0] }));
  assert.equal(nodes.get("sendButton").disabled, true);
  assert.equal(form.getAttribute("aria-busy"), "true");
  assert.equal(nodes.get("question").value, "");
  assert.equal(nodes.has("welcomeState"), false);
  assert.equal(nodes.get("messages").children.length, 2);
  nodes.get("question").value = "another question";
  await emit(form, "submit");
  assert.equal(fetched.length, 2);
  assert.equal(nodes.get("question").value, "another question");
  document.activeElement = null;
  clock.tick(); clock.finishFade();
  assert.equal(nodes.get("promptSuggestion").dataset.prompt, EXPECTED_PROMPTS[0]);
  release({ ok: true, json: async () => ({ summary: { mode: "casual_conversation", answer: "Hello!" } }) });
  await submitting;
  assert.equal(nodes.get("sendButton").disabled, false);
  assert.equal(form.getAttribute("aria-busy"), "false");
  clock.tick(); clock.finishFade();
  assert.equal(nodes.get("promptSuggestion").dataset.prompt, EXPECTED_PROMPTS[1]);
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
