---
title: Wind Phase Review Lab
emoji: 🌬️
colorFrom: blue
colorTo: green
sdk: docker
app_port: 7860
pinned: false
license: mit
---

# Wind Phase Review Lab

An interactive wind forecasting application with retrieval-augmented generation
(RAG). It predicts wind patterns, finds similar past conditions, and uses a large
language model (LLM) to explain the results and answer follow-up questions.

[Try the live demo](https://wind-phase-review-demo.onrender.com/)

The public demo uses a fixed KBOS observation snapshot ending on 11 June 2026 at
05:54 UTC. It shows the software's workflow, not current weather forecasts.

## How it works

- Wind observations are compressed into numerical summaries to retrieve similar
  historical windows.
- The forecasting code estimates the next wind pattern from past pattern changes.
- LangGraph manages requests and conversation memory. LangChain passes retrieved
  evidence to the LLM for explanations and follow-up answers.

The LLM is the application's explanation layer. It explains the forecast and its
evidence without changing the predicted wind pattern.

Built with Python, FastAPI, LangChain, LangGraph, scikit-learn, and Docker.

## Example questions

Start with `predict next phase`, `explain current live state`, or
`retrieve similar historical windows`.

After a forecast, ask `why was this phase selected?`. After retrieving past
windows, ask `what does d mean here?`. Use `Now answer it in bengali.` for a
Bengali answer. Suggested questions follow the current conversation.

## Run locally

Use Python 3.10. Configure your LLM provider's API key and model name for
explanations and follow-up answers. From this folder, run in PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
$env:OPENAI_API_KEY = "your-api-key"
$env:SEMANTIC_LLM_MODEL = "your-model-id"
.\.venv\Scripts\python.exe deployment\server.py
```

Open [localhost:7860](http://127.0.0.1:7860). For an OpenAI-compatible provider,
also set `OPENAI_API_BASE` to its API URL before starting the server. Keep API
keys on the server and out of Git.

See [deployment setup](DEPLOYMENT.md) for hosting and [data provenance](DATA_CARD.md)
for the bundled observations. This is a research demo, not an operational weather
service. Code is available under the [MIT License](LICENSE).
