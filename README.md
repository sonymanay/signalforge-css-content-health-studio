# SignalForge CSS Content Health Studio

Private MCP-powered dashboard for reviewing CSS content health across source systems.

## Run locally

```powershell
npm start
```

Open `http://127.0.0.1:8787/`.

## Optional telemetry

The dashboard can display real article page views when provided through `content-health-telemetry.json` or `CONTENT_HEALTH_TELEMETRY_FILE`. Without telemetry, it labels page-view values as an MCP relevance proxy.

