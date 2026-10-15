# Deploying to a Hugging Face Space

The app ships a `Dockerfile`, so it runs as a **Docker Space**. Read the three
constraints below before you start: two of them change what the deployment is good
for, and one is about who can read your memory.

## Before you deploy — three things that decide whether this is worth it

**1. Docker Spaces need a paid plan.** Hugging Face's own documentation: *"Static
Spaces are free for everyone. Gradio and Docker Spaces run on compute and require a
paid plan to create: PRO for personal accounts, Team or Enterprise for
organizations."* This app is a Next.js server, so it needs the Docker SDK.

**2. The disk is ephemeral.** Every Space gets a scratch disk that *"resets whenever
the Space restarts or is paused."* The memory is a SQLite file under `SB_DATA_DIR`
(`/data` in the image), so on a Space it is wiped on every restart, rebuild and
pause. That is the opposite of what a second brain is for: use a Space to *show* the
app, not to keep your notes. Persistent storage is a separate paid upgrade, or run it
on a host you control — see [deployment.md](deployment.md).

**3. Auth has to be turned off for the UI to work — which opens the API.** The API
trusts loopback callers and refuses everything else, reading the client address from
`x-forwarded-for`. Behind the Space's proxy the request no longer looks local, so
every call from the browser is rejected unless you set `SB_API_DISABLE_AUTH=1`.
The UI has no login screen and sends no token, so there is no middle ground today:

| Setting | Result |
| --- | --- |
| `SB_API_DISABLE_AUTH=1`, **public** Space | Anyone with the URL can read *and write* the entire memory. Only acceptable for a demo holding nothing personal. |
| `SB_API_DISABLE_AUTH=1`, **private** Space | Only you can reach it. The sensible choice if you want data in it at all. |
| `SB_API_REQUIRE_TOKEN=1` | Correct for scripts and the CLI, but the browser UI cannot authenticate, so the pages will show errors. |

## Deploying

```bash
pip install "huggingface_hub[cli]"   # provides the `hf` command
hf auth login                        # paste a token with write access

# Create the Space (private, Docker SDK)
hf repo create <your-user>/second-brain --repo-type space --space_sdk docker --private

# Push this repository to it. The Space repo needs a README.md whose YAML header
# declares the SDK, so deploy from a copy rather than from the project root:
#   ---
#   title: Second Brain
#   emoji: 🧠
#   colorFrom: indigo
#   colorTo: purple
#   sdk: docker
#   app_port: 7860
#   pinned: false
#   ---
git remote add space https://huggingface.co/spaces/<your-user>/second-brain
git push space main
```

The build runs remotely; the Space's **Logs** tab shows it. First boot applies the
database migrations and logs `db:migrate applied migrations: …`.

Set these in the Space's **Settings → Variables and secrets**:

| Name | Value | Why |
| --- | --- | --- |
| `SB_API_DISABLE_AUTH` | `1` | Required: the proxy makes every request non-loopback |
| `SB_PUBLIC_URL` | `https://<your-user>-second-brain.hf.space` | Connector callbacks are built from this |
| `SB_AI_BASE_URL`, `SB_AI_CHAT_MODEL` | e.g. Gemini's OpenAI-compatible endpoint | So the Space has a model without a UI visit |
| `SB_AI_API_KEY` | secret | Your model key — add it as a **secret**, not a variable |

`PORT` is already `7860` in the image, matching the default `app_port`.

## What works and what does not

**Works:** every page, capture, search, the knowledge graph, plays, the API and the
CLI against the Space URL, connectors (with a callback URL the provider can reach).

**Does not work, and cannot:** keeping data across restarts (ephemeral disk), running
with authentication enabled while using the browser UI, and OAuth callbacks on a
free `hf.space` subdomain unless you register that exact URL with the provider.

## A note on the loopback check

`isLoopbackAddress()` returns true when the address is *missing*, so an attacker who
can reach the process directly and strip `x-forwarded-for` looks local. On a normal
local install that is fine (there is nothing in front of it); behind a proxy it means
the header is the only thing standing between the API and the network. If you expose
this app anywhere, set `SB_API_REQUIRE_TOKEN=1` and put a real proxy in front — the
Space path above deliberately trades that away for a working UI.
