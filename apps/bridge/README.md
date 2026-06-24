# @meshtastic/bridge — web client + server-side serial

Run the **official Meshtastic web client** in Docker and connect it to a Meshtastic device
plugged into the **Docker host** (e.g. `/dev/ttyACM0`) — instead of a device on the machine
viewing the page.

## Why this exists

The web client's "Serial" option uses **WebSerial** (`navigator.serial`), a browser API that can
only reach serial ports on the machine running the *browser*. It cannot reach a device on the
server. (See [meshtastic/web#373](https://github.com/meshtastic/web/issues/373), closed: the
recommended path is to *"proxy the client API from the serial connection to an HTTP connection."*)

This package is that proxy. A single Node process:

- opens the serial device via [`@meshtastic/transport-node-serial`](../../packages/transport-node-serial),
- re-exposes it as the device **HTTP API** the web client already speaks
  (`GET /api/v1/fromradio`, `PUT /api/v1/toradio`), and
- serves the static web client on the **same origin** (no CORS, no TLS friction).

The web client itself is **not modified** — you connect using its built-in **HTTP** option.

```
Browser (official UI) ──HTTP /api/v1──▶ this bridge ──serial──▶ /dev/ttyACM0 (on the host)
```

## Build & run on the Docker host

> Docker must run on the Linux host where the device is physically attached.
> Run these from the **repo root** (`web/`).

### docker compose (recommended)

```bash
docker compose -f apps/bridge/infra/docker-compose.yml up --build -d
```

### plain docker

```bash
docker build -f apps/bridge/infra/Dockerfile -t meshtastic-web-bridge .

docker run -d --name meshtastic-web-bridge \
  -p 8080:8080 \
  --device=/dev/ttyACM0:/dev/ttyACM0 \
  --group-add="$(getent group dialout | cut -d: -f3)" \
  -e MESHTASTIC_SERIAL_PORT=/dev/ttyACM0 \
  meshtastic-web-bridge:latest
```

## Connect

1. Open `http://<host>:8080` in a browser.
2. **Add Connection → HTTP**.
3. Enter the same address you're viewing, e.g. `<host>:8080` (HTTP, not HTTPS).
4. Connect. Node info, channels, and messages should load.

## Configuration (environment variables)

| Variable                  | Default          | Purpose                                    |
| ------------------------- | ---------------- | ------------------------------------------ |
| `MESHTASTIC_SERIAL_PORT`  | `/dev/ttyACM0`   | Serial device path inside the container    |
| `MESHTASTIC_BAUD_RATE`    | `115200`         | Serial baud rate                           |
| `PORT`                    | `8080`           | HTTP port                                  |
| `HOST`                    | `0.0.0.0`        | Bind address                               |
| `STATIC_DIR`              | `/app/dist`      | Static web client directory                |
| `MESHTASTIC_RECONNECT_MS` | `3000`           | Serial reconnect backoff                   |

## Device path & permissions

- **Stable path:** USB devices can renumber across replugs. Prefer a `by-id` symlink:
  `ls -l /dev/serial/by-id/` then set both the `--device` mapping and `MESHTASTIC_SERIAL_PORT`
  to e.g. `/dev/serial/by-id/usb-...-if00`.
- **Group:** the container runs as the non-root `node` user, which must belong to the device's
  group. On Debian/Ubuntu that's `dialout`. Check with `ls -l /dev/ttyACM0`; if the group differs,
  pass its numeric GID (`group_add: ["<gid>"]` or `--group-add <gid>`).
- **Fallback:** if cgroup rules still block access, `--privileged` works but is broad — use only to
  diagnose.

## Troubleshooting

- **UI says "not reachable":** confirm the container is up and `8080` is published; use plain
  `http://` (the bridge serves HTTP, so the page and API are same-origin — no mixed content).
- **Connects but stuck "configuring":** usually a stale session; reconnect. The bridge flushes its
  queue on each new `want_config`, so a fresh connect recovers.
- **Logs:** `docker logs meshtastic-web-bridge` — look for `serial connected`. `serial open failed`
  means the path/permissions are wrong (see above); the bridge retries every `MESHTASTIC_RECONNECT_MS`.
- **Disconnect on unplug:** expected — the bridge returns HTTP 503 so the UI shows a disconnect,
  then auto-reopens the port when the device returns (reconnect in the UI).

## Security

No authentication — anyone who can reach `:8080` can use the device. Keep it on a trusted LAN, or
put it behind an authenticating reverse proxy. If you terminate TLS at a proxy, the web client must
then use `https://` for the API too (avoid mixed content).

## How it builds (notes for maintainers)

3-stage image (`infra/Dockerfile`): (1) pnpm workspace build of the web `dist` + a tsdown bundle of
this bridge with `serialport` **external**; (2) a separate npm install of `serialport` so its native
binding builds despite the workspace's `allowBuilds: "@serialport/bindings-cpp": false`; (3) a slim
`node:22-bookworm-slim` runtime. Debian (glibc) + Node 22 are required for the serial prebuild ABI.
