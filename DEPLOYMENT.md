# Hosting the demo

The package is prepared for a public interactive demo. Start with the bundled
snapshot to keep startup predictable. Configure optional live refresh and LLM
access only after the basic workflow works on the host.

## Hugging Face Docker Spaces

1. Create a Space in your own account, select **Docker**, and select public
   visibility if visitors should be able to use it. Current creation rules
   require a paid account plan for Docker Spaces; check the account requirements
   before creating the Space. CPU Basic has no separate hourly compute charge.
2. Add the contents of this folder at the Space repository root. `Dockerfile`
   must be at the root. Preserve the README YAML header (`sdk: docker`,
   `app_port: 7860`). Exclude `.env`, `runtime`, caches and virtual environments.
3. Use **Settings → Variables and secrets**. Add `OPENAI_API_KEY` as a **secret**
   only if you want LLM explanations. Set `SEMANTIC_LLM_MODEL=gpt-4o-mini`,
   `WIND_DATA_MODE=snapshot`, and `WIND_SECURE_COOKIES=1` as variables.
4. Optionally set `WIND_SESSION_SECRET` as a secret. Generate a value locally:
   `python -c "import secrets; print(secrets.token_urlsafe(32))"`.
   No Hugging Face access token is needed by the running app. A personal access
   token is only needed if you choose an authenticated Git/upload workflow.
5. Wait for the build, check `/health`, and test the action sequence below.
   Share the Space's app URL only after these checks pass.

References: [Docker Spaces](https://huggingface.co/docs/hub/spaces-sdks-docker),
[account/compute rules](https://huggingface.co/docs/hub/spaces-overview).

## Render

1. Put this package in a Git repository in your account.
2. Create a Render Blueprint using `render.yaml`, or create a **Web Service**
   with Docker runtime and `/health` as the health check path.
3. The Blueprint starts with the Free instance plan. Confirm startup and memory
   usage on the actual instance before relying on this plan; local inference
   tests do not establish that the service fits a host's memory limit.
4. Add the optional `OPENAI_API_KEY` in server-side environment settings.
   The Blueprint generates the session secret; do not publish its value.
5. Free instances sleep after 15 minutes idle and take about one minute to wake.
   Files created by sessions are ephemeral. A paid instance may be preferable
   if startup delays interfere with your intended demo.

References: [FastAPI on Render](https://render.com/docs/deploy-fastapi),
[Free instance limitations](https://render.com/docs/free).

## Check before sharing the URL

Open the app and send these questions in order:

1. `predict next phase`
2. `why was this phase selected?`
3. `retrieve similar historical windows`
4. `Thanks for the forecast`

Confirm that the first three requests still show forecast evidence and historical
examples, and that the last request returns a casual reply. The public interface
does not show accept, flag, note or review-status controls.

Open a separate private browser window and confirm that it starts a fresh
session. Ensure the data timestamp is visible and optional LLM explanations
have the correct availability label. If an API key is configured, test one
explanation and inspect your provider account's usage. Keep secrets out of
screenshots. Link the verified demo from the main research README and CV.

## Storage, traffic and secrets

The adapter uses a single worker because the original memory implementation
writes JSON files. Memory and feedback are separated by a signed session cookie
and stored under `WIND_RUNTIME_DIR`. Hosting restarts may clear them. A stable
`WIND_SESSION_SECRET` preserves cookie validity across restarts but does not
preserve files. Rate limiting uses the connection address; behind a proxy,
multiple visitors may share the same limit. LLM usage allowances reset when the
process restarts and are not a durable spending control.

API keys belong on the server, following the [official OpenAI authentication
guidance](https://developers.openai.com/api/reference/overview#authentication).
Neither a GitHub nor Hugging Face personal access token is an OpenAI API key.
