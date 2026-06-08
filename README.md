# wt-apimadeeasy

Simple web service to quickly test Watchtower APIs from a browser.

## Run

```bash
node server.js
```

The service starts on `http://localhost:8080` by default.  
Set a different port with `PORT`:

```bash
PORT=3000 node server.js
```

## What it provides

- A browser UI (`/`) to compose Watchtower API calls
- A local proxy endpoint (`/api/request`) to avoid browser CORS limitations
- A health endpoint (`/health`) for quick checks