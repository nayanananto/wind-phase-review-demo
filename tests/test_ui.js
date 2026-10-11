"use strict";

// Exercise the actual renderer with minimal inert DOM stubs, not a browser.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const staticDir = path.resolve(__dirname, "../app/hitl/ui_static");
const html = fs.readFileSync(path.join(staticDir, "index.html"), "utf8");
const source = fs.readFileSync(path.join(staticDir, "app.js"), "utf8");

function element() {
  return {
    innerHTML: "",
    textContent: "",
    value: "",
    className: "",
    scrollTop: 0,
    scrollHeight: 0,
    children: [],
    listeners: new Map(),
    addEventListener(name, callback) {
      this.listeners.set(name, callback);
    },
    appendChild(child) {
      this.children.push(child);
      this.scrollHeight = this.children.length;
    },
    focus() {},
    requestSubmit() {},
  };
}

function actionButtons() {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    .map((match) => ({
      attributes: match[1],
      label: match[2].replace(/<[^>]*>/g, "").trim(),
      prompt: match[1].match(/\bdata-prompt="([^"]+)"/)?.[1],
    }))
    .filter((button) => button.prompt !== undefined);
}

async function loadUi() {
  const ids = ["messages", "question", "chatForm", "metadataStatus", "llmStatus", "dataStatus"];
  const nodes = new Map(ids.map((id) => [id, element()]));
  const buttons = actionButtons().map(({ prompt }) => ({
    ...element(), dataset: { prompt },
  }));
  const storage = new Map();
  const fetched = [];
  const context = vm.createContext({
    document: {
      getElementById: (id) => nodes.get(id) ?? null,
      createElement: () => element(),
      querySelectorAll: (selector) => {
        assert.equal(selector, "[data-prompt]");
        return buttons;
      },
    },
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    crypto: { randomUUID: () => "ui-test-session" },
    fetch: async (url) => {
      fetched.push(url);
      assert.equal(url, "/api/defaults");
      return {
        json: async () => ({
          data_mode: "snapshot",
          data_as_of: "2026-06-11T05:54:00+00:00",
          llm_enabled_by_default: true,
          live_sync: { message: "Using the bundled dated observation snapshot." },
        }),
      };
    },
    URLSearchParams,
  });
  vm.runInContext(source, context, { filename: "app.js" });
  // Let the existing async init() settle; no network or application requests.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fetched, ["/api/defaults"]);
  return { context, nodes, buttons };
}

test("the page advertises exactly four scientific quick actions, no feedback controls", async () => {
  const actions = actionButtons();
  assert.deepEqual(actions.map(({ label }) => label), [
    "Predict Phase", "Explain State", "Similar Windows", "Why This Phase?",
  ]);
  assert.deepEqual(actions.map(({ prompt }) => prompt), [
    "predict next phase",
    "explain current live state",
    "retrieve similar historical windows",
    "why was this phase selected?",
  ]);
  const visiblePage = html.replace(/<[^>]*>/g, " ");
  const placeholder = html.match(/\bplaceholder="([^"]+)"/)?.[1];
  assert.ok(placeholder, "the composer should keep helpful example prompts");
  assert.doesNotMatch(visiblePage + " " + placeholder, /\b(?:accept|approve|flag|feedback)\b|\b(?:add|record|save) (?:a )?note\b/i);

  const { buttons, nodes } = await loadUi();
  for (const button of buttons) {
    button.listeners.get("click")();
    assert.equal(nodes.get("question").value, button.dataset.prompt);
  }
});

test("startup welcome advertises forecast, evidence and memory, not review actions", async () => {
  const { nodes } = await loadUi();
  assert.equal(nodes.get("messages").children.length, 1);
  const welcome = nodes.get("messages").children[0].innerHTML;
  assert.match(welcome, /Predict Phase/);
  assert.match(welcome, /historical|Similar Windows/i);
  assert.match(welcome, /session/i);
  assert.doesNotMatch(welcome, /\b(?:accept|approve|flag|feedback)\b|\b(?:add|record|save) (?:a )?note\b/i);
  assert.match(nodes.get("metadataStatus").textContent, /Observation snapshot/);
  assert.match(nodes.get("metadataStatus").textContent, /2026-06-11T05:54:00\+00:00/);
});

test("scientific replies retain forecast and history tables without a review-state panel", async () => {
  const { context } = await loadUi();
  const rendered = context.renderResponse({
    summary: {
      intent: "phase_prediction",
      mode: "phase_forecast",
      answer: "The snapshot favors this regime.",
      llm_requested: true,
      llm_available: true,
      live_token_sequence: [7, 7, 0],
      current_live_state: { regime_name: "SteadyModerate" },
      top_phase_candidates: [{ token_id: 0, regime_name: "SteadyModerate", probability: 0.8889, count: 72 }],
      similar_windows: [{ window_id: "historical-example-one", regime_name: "LightSteady", retrieval_distance: 0.1427 }],
      transition_analogs: [{ evidence_id: "transition-example-one", history_tokens: [7, 7, 0], next_token_id: 0, future_window_start: "historical-observation" }],
      review_state: {
        status: "UI_SHOULD_HIDE_REVIEW",
        action: "flag",
        window_id: "hidden-review-window",
        model_predicted_token: 999,
      },
      human_review_prompt: "UI_SHOULD_HIDE_REVIEW_PROMPT",
    },
  });
  assert.match(rendered, /The snapshot favors this regime/);
  assert.match(rendered, /Phase candidates/);
  assert.match(rendered, /SteadyModerate/);
  assert.match(rendered, /p=0\.889/);
  assert.match(rendered, /Similar historical windows/);
  assert.match(rendered, /historical-example-one/);
  assert.match(rendered, /Transition analogs/);
  assert.match(rendered, /transition-example-one/);
  assert.doesNotMatch(rendered, /Human Review State|UI_SHOULD_HIDE_REVIEW|hidden-review-window|model next token: 999|status:/);
});

test("casual replies remain isolated, label actual LLM use and escape generated text", async () => {
  const { context } = await loadUi();
  const rendered = context.renderResponse({
    summary: {
      mode: "casual_conversation",
      answer: '<img src=x onerror="alert(1)"> You\'re welcome & happy to help!',
      llm_used: true,
      review_state: { status: "UI_SHOULD_HIDE_REVIEW" },
      top_phase_candidates: [{ token_id: 999, regime_name: "SHOULD_NOT_APPEAR" }],
    },
  });
  assert.match(rendered, /casual conversation/);
  assert.match(rendered, /LLM reply/);
  assert.match(rendered, /&lt;img/);
  assert.match(rendered, /&quot;alert\(1\)&quot;/);
  assert.match(rendered, /&amp; happy to help/);
  assert.doesNotMatch(rendered, /<img|Human Review State|UI_SHOULD_HIDE_REVIEW|SHOULD_NOT_APPEAR|Phase candidates/);
  const fallback = context.renderResponse({
    summary: { mode: "casual_conversation", answer: "Hello!", llm_used: false },
  });
  assert.match(fallback, /standard reply/);
  assert.doesNotMatch(fallback, /LLM reply/);
});
