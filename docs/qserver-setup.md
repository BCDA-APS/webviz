# Connecting Webviz to an Existing Bluesky Queue Server

Webviz communicates with the Bluesky Queue Server via **bluesky-httpserver**, an HTTP REST API layer that sits in front of the ZMQ-based `bluesky-queueserver`. Browsers cannot speak ZMQ directly, so this HTTP layer is required.

---

## Prerequisites

- A running `bluesky-queueserver` (ZMQ sockets, typically on ports 60615 and 60625)
- A conda environment with compatible package versions (see below)

---

## 1. Install bluesky-httpserver

Compatible versions (tested):

```bash
pip install "bluesky-httpserver==0.0.13" "bluesky-queueserver-api==0.0.12"
```

> **Note:** bluesky-httpserver 0.0.14 requires bluesky-queueserver-api >= 0.0.13, which in turn requires bluesky-queueserver >= 0.0.23. If your queueserver is older (e.g. 0.0.22), use the versions above.

---

## 2. Create a startup script

Create a script (e.g. `scripts/qs_http.sh`) in your instrument directory:

```bash
#!/bin/bash
CONDA_ENV=your_env_name
export CONDA_PREFIX=${HOME}/.conda/envs/${CONDA_ENV}
export LD_LIBRARY_PATH="${CONDA_PREFIX}/lib"

# Allow connections without an API key
export QSERVER_HTTP_SERVER_ALLOW_ANONYMOUS_ACCESS=1

# ZMQ addresses of the running queueserver
export QSERVER_ZMQ_CONTROL_ADDRESS="tcp://localhost:60615"
export QSERVER_ZMQ_INFO_ADDRESS="tcp://localhost:60625"

uvicorn bluesky_httpserver.server:app --host 0.0.0.0 --port 60610
```

Make it executable:

```bash
chmod +x scripts/qs_http.sh
```

### Key environment variables

| Variable | Value | Purpose |
|---|---|---|
| `QSERVER_HTTP_SERVER_ALLOW_ANONYMOUS_ACCESS` | `1` | Disable API key requirement |
| `QSERVER_ZMQ_CONTROL_ADDRESS` | `tcp://localhost:60615` | ZMQ control socket of queueserver |
| `QSERVER_ZMQ_INFO_ADDRESS` | `tcp://localhost:60625` | ZMQ info socket of queueserver |

> **Important:** The env var name is `QSERVER_HTTP_SERVER_ALLOW_ANONYMOUS_ACCESS` (not `QSERVER_ALLOW_ANONYMOUS_ACCESS`). The value must be `1`, not `true`.

---

## 3. Start the HTTP server

On the machine running the queueserver:

```bash
conda activate your_env_name
./scripts/qs_http.sh
```

Confirm the startup log shows:

```
'allow_anonymous_access': True,
```

and:

```
The server is running in 'public' mode, permitting open, anonymous access
```

The server listens on port **60610**.

---

## 4. Connect from Webviz

1. Open the **Queue Server** tab in Webviz
2. Set the HTTP URL to `http://<hostname>:60610` (e.g. `http://nefarian.xray.aps.anl.gov:60610`)
3. Leave the API Key field empty
4. Click **Connect**

The status bar should show the Manager state, RE state, and queue count.

---

## How it works

Webviz cannot fetch directly from the remote httpserver due to browser CORS restrictions. Instead, the Vite dev server acts as a CORS proxy:

```
Browser → /qs-proxy/http/<host>:<port>/api/... → Vite proxy → http://<host>:<port>/api/...
```

This proxy is configured in `vite.config.ts` and requires no additional setup.
