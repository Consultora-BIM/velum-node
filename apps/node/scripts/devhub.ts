// Puerta de entrada local para desarrollo y pruebas (sin Cloudflare): HubRouter del núcleo sobre Bun.serve.
//   bun apps/node/scripts/devhub.ts [puerto]      → ws://localhost:<puerto>/hub
// Enruta igual que la puerta del Worker (nodos completos y ligeros, clientes, gossip, RPC, push, directos),
// pero sin indexador. Sirve además /download/* desde una carpeta (para probar el manifiesto OTA).
import { HubRouter, type HubHandle } from "@velum/core";
import { join } from "node:path";

export function startDevHub(port = 0, downloadDir?: string) {
  const router = new HubRouter();
  const server = Bun.serve<{ role: "node" | "client" | "watch"; h?: HubHandle }>({
    port,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/hub") {
        const role = url.searchParams.get("role");
        if (role !== "node" && role !== "client" && role !== "watch") return new Response("role debe ser node, client o watch", { status: 400 });
        return srv.upgrade(req, { data: { role } }) ? undefined : new Response("Se esperaba WebSocket", { status: 426 });
      }
      if (downloadDir && url.pathname.startsWith("/download/")) {
        const f = Bun.file(join(downloadDir, decodeURIComponent(url.pathname.slice("/download/".length)).replace(/\.\./g, "")));
        return f.size ? new Response(f) : new Response("No encontrado", { status: 404 });
      }
      return new Response("Puerta local de Velum", { status: 200 });
    },
    websocket: {
      maxPayloadLength: 16 * 1024 * 1024,
      open(ws) { ws.data.h = router.open({ send: (d) => { ws.send(d); }, close: (c, r) => ws.close(c, r) }, ws.data.role); },
      message(ws, m) { if (ws.data.h) router.message(ws.data.h, typeof m === "string" ? m : new TextDecoder().decode(m)); },
      close(ws) { if (ws.data.h) router.close(ws.data.h); },
    },
  });
  return { url: `ws://localhost:${server.port}/hub`, http: `http://localhost:${server.port}`, router, stop: () => server.stop(true) };
}

if (import.meta.main) {
  const h = startDevHub(Number(process.argv[2] ?? 8790));
  console.log(`puerta local en ${h.url}`);
}
