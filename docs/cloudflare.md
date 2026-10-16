# Exposing it through Cloudflare (free)

What you get: a hostname such as `brain.example.com` that only you can open, served from the
machine already running the app, with no port opened on your router and no public IP needed.
Cloudflare Tunnel makes the outbound connection; Cloudflare Access does the login.

## What you need

- **A domain in your Cloudflare account.** The tunnel publishes a hostname inside one of your
  zones, and an Access policy attaches to that hostname. Any registrar works; Cloudflare Registrar
  sells at cost.
- **A Cloudflare account.** Zero Trust's free plan is `$0` and sized for teams under 50 users,
  which is the tier this uses.
- **The app running** on the machine (see *Keep it running*).

Without a domain only Cloudflare's *quick tunnel* is available (`*.trycloudflare.com`), and that
URL **cannot** be protected by Access. For a no-domain setup use the private-network option in
[free-hosting.md](free-hosting.md) instead — do not put your memory behind an unprotected quick
tunnel.

## Read this before you start: why the app runs with auth off

Cloudflare terminates the public connection and forwards to the app with `X-Forwarded-For` set to
the visitor's address. The app treats that as a non-local caller and refuses the request, so it has
to be started with its own API auth disabled. That is safe **only because Access rejects
unauthenticated visitors before they reach the app** — by the time a request arrives, it is your own
signed-in browser. So:

- add the Access policy **before** you share the hostname with anyone;
- never point a quick tunnel at this app.

## Path A — tunnel managed in the dashboard (recommended)

1. Zero Trust dashboard → **Networks → Tunnels → Create a tunnel** → *Cloudflared* → name it
   `second-brain`.
2. The wizard offers a connector install command that carries a token. Run the one for Windows —
   either elevated (`cloudflared service install <token>`) to register it as a service, or as
   yourself (`cloudflared tunnel run --token <token>`) to run it in the foreground.
3. In the same wizard, add a **Public hostname**:
   - Subdomain/Domain: `brain` + your domain
   - Service: `HTTP` → `localhost:4173`
4. Continue to *Secure it with Access* in the next section.

No config file, and the token can be re-issued from the dashboard if you ever need to.

## Path B — tunnel defined locally

```powershell
# 1. sign in; pick the zone when the browser opens (writes a certificate under ~\.cloudflared)
& "$env:USERPROFILE\cloudflared\cloudflared.exe" tunnel login

# 2. create the tunnel, then give it a hostname in that zone
& "$env:USERPROFILE\cloudflared\cloudflared.exe" tunnel create second-brain
& "$env:USERPROFILE\cloudflared\cloudflared.exe" tunnel route dns second-brain brain.example.com
```

Then a config file at `%USERPROFILE%\.cloudflared\config.yml` describing where to forward:

```yaml
tunnel: second-brain
credentials-file: C:\Users\<you>\.cloudflared\<tunnel-id>.json
ingress:
  - hostname: brain.example.com
    service: http://localhost:4173
  - service: http_status:404
```

Run it with `cloudflared tunnel run second-brain`, or `cloudflared service install` to keep it
running after a reboot.

## Lock it with Access (either path)

Zero Trust dashboard → **Access → Applications → Add an application → Self-hosted**:

- Application domain: the hostname you created;
- Policy: **Allow**, action *Emails*, containing your address (add a second address if you want
  another device or person in);
- Identity: the built-in one-time PIN is enough — no external identity provider needed.

Visit the hostname in a private window: Cloudflare asks for your email, sends a code, and only then
reaches the app. That login is what stands in for the login screen the app does not have.

## App-side settings

Put these in `.env` next to the project, then restart the app:

| Setting | Value | Why |
| --- | --- | --- |
| `SB_PUBLIC_URL` | `https://brain.example.com` | Connector callbacks are built from it; it must match the public hostname exactly |
| `SB_API_DISABLE_AUTH` | `1` | Required behind the proxy — Access is the gate instead |

Connectors need the matching redirect URI registered with each provider:
`https://brain.example.com/api/v1/connectors/<provider>/callback`.

## Keep it running

The hostname only works while both the app and the tunnel are up.

- Run the app in production rather than as a dev server: `npm run build`, then `npm start`.
- Make it survive reboots: on Windows, Task Scheduler with a *At startup* trigger running
  `npm start` in the project folder, or wrap the Node process with NSSM as a service.
- **A detached background process is not a service.** A dev server started that way was gone by
  the next check here, with nothing in its log — the process had been reaped, not crashed. Use the
  scheduler or NSSM if you want it always available.

## Verify

1. `https://brain.example.com/api/v1/health` from a signed-in browser → `"ok": true`.
2. The dashboard renders and its counters match your data.
3. In a private window, the same URL asks for the Access login.
4. `npm run cli -- ask "..."` still works against your local instance.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Cloudflare returns **502** | nothing is listening on 4173 — the app is stopped, or it is on another port |
| Page loads, every panel shows an error | `SB_API_DISABLE_AUTH` is not set, so the proxied request is refused |
| Login prompt never appears | no Access policy on that hostname yet |
| Connector authorization fails | `SB_PUBLIC_URL` does not match the public hostname, or the provider has a different redirect URI registered |
| Tunnel runs but the hostname is dead | the DNS route was never created (`tunnel route dns`), or you are running a different tunnel than the one that owns the hostname |

## Cost and what Cloudflare sees

`cloudflared`, the tunnel and the Zero Trust free plan cost nothing at this scale. Cloudflare does
terminate TLS, so it handles your traffic in transit — the memory itself never leaves your machine,
and the database, its key and the background worker all stay local.
