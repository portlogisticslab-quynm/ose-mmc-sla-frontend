# OSE M/M/c + SLA Frontend

Static browser frontend for the M/M/c queue simulator. It contains the interface, charts, animation, CSV/ZIP export, and video export. The queue algorithm is not included here; it is called through the FastAPI backend.

## Configure backend URL

Edit `public/config.js` and replace:

```text
https://REPLACE-WITH-YOUR-RENDER-URL.onrender.com
```

with the actual Render backend URL.

## Local run

```powershell
cd C:\ose-mmc-sla-frontend\public
python -m http.server 5500
```

Open `http://127.0.0.1:5500`.

## Cloudflare Workers static assets

The repository includes `wrangler.jsonc`:

- Build command: `exit 0`
- Deploy command: `npx wrangler deploy`
- Root directory: blank
- Static assets directory: `./public`

After deployment, add a custom domain such as `mmc.ose.vn`, then update `ALLOWED_ORIGINS` in Render.
