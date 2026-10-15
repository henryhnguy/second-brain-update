# Running it for free

An honest map of what is free in 2026 for an app shaped like this one: a Node server,
a SQLite file that must survive, a background worker, and a browser UI with no login
screen.

## Hugging Face Spaces: not free for this app

Hugging Face's own documentation, *Spaces Overview*:

> Static Spaces are free for everyone. **Gradio and Docker Spaces run on compute and
> require a paid plan to create: PRO for personal accounts, Team or Enterprise for
> organizations.** Free personal accounts in good standing can still host up to 2
> Gradio Spaces running on ZeroGPU.

The only free exception is a Gradio Space on ZeroGPU — a Python UI serving models.
Running a Next.js server inside one would mean abusing that SDK to start a second web
server behind Gradio's port, and it would not fix the two real problems anyway: the
Space disk is *not persistent* (it resets on restart and the app is put to sleep when
idle), and the browser UI cannot authenticate behind the Space proxy. [docs/huggingface.md](huggingface.md)
has the full detail; the short version is that a Space is a demo host, not a home for
your memory.

## The blocker behind every public host: there is no login screen

The API trusts loopback callers and refuses everyone else, and the browser UI sends no
credentials. So on any host reachable from the internet you must either:

- leave the API open (anyone with the URL has full read and write access to the
  memory), or
- require a bearer token, which the UI cannot send — the pages simply error.

Two ways out, both covered below: put the app behind something that authenticates for
you (private network or an identity-aware tunnel), or add a login screen to the app.
The first needs no code. The second is a self-contained feature — say the word.

## Option 1 — Tailscale: free, private, no exposure (recommended)

Keep the app running on the machine it already runs on, and join that machine and your
other devices to a private tailnet. Free for personal use (a handful of devices).

1. Install Tailscale on the machine running the app and on your laptop/phone, sign in
   on both.
2. Note the machine's tailnet name, e.g. `brainbox.tailnet-xxxx.ts.net`.
3. Reopen the app at `http://brainbox:4173`.

Nothing is published to the internet, the API keeps its loopback behaviour, and your
data never leaves your machines. This is the only free option that is also *safer* than
what you have now.

## Option 2 — Cloudflare Tunnel plus Access: a real URL, still free

Use this when you want a stable address like `https://brain.example.com` without
opening a port.

1. Install `cloudflared`, create a named tunnel, point its ingress at
   `http://localhost:4173`.
2. Put Cloudflare Access in front of that hostname and allow only your email address.
   Access authenticates the request before it ever reaches the app, which is what makes
   the missing login screen a non-issue.
3. Set `SB_PUBLIC_URL` to the public hostname so connector callbacks are built
   correctly.

Free tier limits change; check them when you sign up. A quick unnamed tunnel
(`cloudflared tunnel --url http://localhost:4173`) needs no account but publishes a
random URL to the internet with **no authentication** — usable for a five-minute look,
never for a memory store.

## Option 3 — Oracle Cloud Always Free: a real VM, still free

The only mainstream always-free VM with a persistent disk: Ampere A1 capacity (up to 4
OCPU and 24 GB RAM) plus 200 GB of block storage. Signup needs a card for identity
verification even though nothing is charged.

```bash
# on the VM (Ubuntu 24.04, arm64)
sudo apt-get update && sudo apt-get install -y git curl unzip
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs          # Node 24: node:sqlite needs no flag here

git clone https://github.com/<you>/second-brain-update.git
cd second-brain-update && npm ci && npm run build

# keep the memory outside the checkout
export SB_DATA_DIR=/var/lib/second-brain
sudo mkdir -p "$SB_DATA_DIR" && sudo chown "$USER" "$SB_DATA_DIR"
```

Run it under systemd so it survives reboots, with `npm start` as the command and the
environment above. Two things to get right:

- **Put authentication in front.** Either tunnel from the VM through Cloudflare Access
  (Option 2), or set `SB_API_REQUIRE_TOKEN` to `1` and use the token through the CLI and
  scripts — at the cost of the browser UI, which cannot send one.
- **Back up `/var/lib/second-brain`** including the `.secret` file; that directory *is*
  your memory. `docs/deployment.md` covers backups and reverse proxies in more detail.

Capacity is not guaranteed: free ARM instances are often unavailable in popular regions,
and Oracle reclaims idle instances on some free plans. Treat it as a good free host you
may have to retry.

## Option 4 — GitHub Codespaces: free, temporary

Personal accounts get a monthly free core-hour allowance. Useful to try the app from a
different device, or to demo it, without signing up for anything new:

```bash
npm install && npm run dev          # port 4173 is forwarded, private to your account
```

The environment stops when idle and there is no persistent disk, so this is a scratch
pad, not a host.

## What no longer works, and why

| Host | Why not |
| --- | --- |
| Render (free) | Web services sleep, and the free tier has no persistent disk — the database is wiped on every deploy and restart. |
| Vercel, Cloudflare Workers (free) | Serverless: no writable filesystem for SQLite, and no long-running worker. Fitting this app there means replacing the database and the worker — a rewrite, not a deployment. |
| Fly.io, Railway, Heroku | No free tier any more. |
| HF Spaces (free) | Static SDK only; Docker and Gradio Spaces need a paid plan. |

## The bottom line

| You want | Free answer |
| --- | --- |
| Use it on your own devices, anywhere | **Tailscale** (Option 1) |
| A public URL you can bookmark | **Cloudflare Tunnel + Access** (Option 2) |
| A server that is not your machine, with data that survives | **Oracle Always Free** (Option 3), with an auth layer in front |
| A place to show the app | Codespaces (Option 4), or pay for a Space |

Running it locally, as in the README, remains free, private and the only setup where
nothing has to be trusted to a third party.
