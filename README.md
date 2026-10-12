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

An interactive research demo for inspecting wind-regime forecasts, exploring
their evidence, and retrieving similar historical observation windows.
The transition-count predictor produces the forecast. An optional language model
explains the evidence; it does not change the forecast or retrain the predictor.

This standalone deployment package is derived from the existing wind thesis code
repository. It includes the fitted KBOS encoder/tokenizer, historical retrieval
data and index, a dated observation snapshot, and the existing browser interface.
Full experiment scripts and second-station datasets remain in the research repo.
See [the research overview](RESEARCH_README.md) and [data provenance](DATA_CARD.md).
Commands in the research overview that need omitted experiment files should be
run from the original research repository, not this demo package.

## Run locally

Python 3.10 is used for compatibility with the fitted artifacts. From this folder:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe deployment\server.py
```

Open `http://127.0.0.1:7860`. No API key is required for forecasts, historical
examples, deterministic explanations, or standard casual replies. The initial
screen identifies the data mode and observation timestamp. Rotating examples
above the question box suggest forecasts, state explanations, historical
matches, phase comparisons, and simpler, shorter or Bengali explanations of
the previous answer. Click an example to fill the box, then press **Enter** or
the send arrow to submit. Examples keep cycling after a click, while you type,
and while a reply is pending, without changing your draft. Use the pause icon
to stop rotation. Follow-up examples need a previous answer or historical
matches in your session. You can also say hello or thanks.

The default `WIND_DATA_MODE=snapshot` uses observations ending on
2026-06-11 at 05:54 UTC. It is an interactive demo of dated observations, not a
current weather forecast. `WIND_DATA_MODE=live` attempts to refresh METAR data
once at startup, with a labeled snapshot fallback. It is not a continuous feed.
The METAR sampling interval differs from the historical five-minute training
data; see `DATA_CARD.md` and the adapter warning in the saved semantic state.

## Optional LLM explanations

Provide `OPENAI_API_KEY` through a server-side environment variable or your host's
secret settings. Keep `SEMANTIC_LLM_MODEL=gpt-4o-mini` unless you intentionally
choose another compatible model. Never place credentials in this README,
JavaScript, screenshots or Git history. The included `.env.example` contains only
configuration examples. Python does not automatically load `.env`; use shell
environment variables or Docker's `--env-file` option.

If no key is configured, or the daily allowance is exhausted, deterministic
responses remain available. The global `WIND_LLM_REQUESTS_PER_DAY=30` limit is
per process, resets at UTC midnight and after a restart, and counts LLM-enabled
requests rather than individual model calls. It is a demo usage control, not a
guaranteed spending cap. API charges are separate from hosting charges.

## Docker

```powershell
docker build -t wind-review-demo .
docker run --rm -p 7860:7860 wind-review-demo
```

For optional LLM access, copy `.env.example` to a local `.env`, configure it
privately, and run:

```powershell
docker run --rm -p 7860:7860 --env-file .env wind-review-demo
```

The image runs as user ID 1000. `/health` supports host health checks, and `PORT`
can override the default port. See [hosting instructions](DEPLOYMENT.md) for
Hugging Face Docker Spaces and Render.

## Public demo behavior

- Route, input-window and LLM availability labels remain visible in each
  scientific response. Open **Run details** for transition analogs, input tokens
  and memory/LLM diagnostics. Forecast candidates and historical matches stay
  in the main response.
- Feedback controls and review-status panels are hidden from the demo interface.
  The underlying research feedback API remains unchanged.
- A separate, tool-free casual agent handles greetings, thanks and short social
  exchanges. It uses the configured LLM for free-form wording, with standard
  replies if the API is unavailable. Casual replies never alter forecast memory
  or record review feedback. Mixed scientific requests use the existing workflow;
  unsupported turbine/power calculations retain the normal out-of-scope reply.
- The server fixes the forecasting and retrieval configuration. Requests cannot
  supply file paths, model artifacts or another visitor's session identity.
- Signed, HTTP-only cookies select separate session memory and feedback files.
- One worker serializes the original JSON memory writes. Requests are limited to
  1,500 characters and, by default, 20 per connection address per minute.
- Storage is local. Feedback and memory may disappear when a host restarts.
  Do not use this demo as a durable study log or operational weather service.
- The public API returns the interface summary rather than the full internal
  pipeline trace. Training dependencies such as TensorFlow are not required.

## Verification

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
.\.venv\Scripts\python.exe -m compileall -q app scripts deployment
```

Tests use the bundled assets and never call the OpenAI API or live weather API.
If Node.js is installed, also run `node --test tests/test_ui.js` to check the
interface renderer without a browser. Node.js is not required to run the demo.
Docker image execution and the optional authenticated LLM path must also be
checked on the actual host before sharing a public demo link.

To build a clean ZIP without secrets, sessions or caches:

```powershell
python deployment\build_package.py
```

## Screenshots

After starting the app, capture forecast/evidence, historical examples, and
casual conversation using Windows **Win + Shift + S**. Keep the data timestamp
visible.
Store the images under `docs/screenshots/` and add them to your main research
repository README using [the suggested snippet](docs/SCREENSHOTS.md).

## License

Code is released under the [MIT License](LICENSE). Data provenance and source
terms are described in [DATA_CARD.md](DATA_CARD.md).
