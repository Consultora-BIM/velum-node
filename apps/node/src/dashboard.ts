// Panel local del nodo (http://localhost:7420). Autocontenido: los colores salen de brand/tokens.css.
export const dashboardHtml = () => HTML;

const HTML = /* html */ `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nodo Velum</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400..800&family=Martian+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{
  color-scheme:dark;
  --bg:#0C1014;--surface:#131A20;--raised:#1B232B;--line:#29333D;--line-strong:#5E6A77;
  --text:#E9EDF1;--muted:#8D99A6;--accent:#FFB224;--on-accent:#1A1206;--accent-soft:#2B2213;
  --pending:#3A4550;--ok:#3DD68C;--danger:#FF6B6B;
  --bronce:#C68A5E;--plata:#AEB8C3;--oro:#F2C94C;--diamante:#8FE3F2;
  --display:"Bricolage Grotesque",ui-sans-serif,system-ui,sans-serif;
  --mono:"Martian Mono",ui-monospace,"SF Mono",monospace;
}
@media (prefers-color-scheme: light){
  :root{color-scheme:light;--bg:#F6F7F8;--surface:#FFFFFF;--raised:#EEF1F3;--line:#D9DEE3;--line-strong:#9AA5B0;
    --text:#10161C;--muted:#5B6672;--accent:#B87400;--on-accent:#FFFFFF;--accent-soft:#FBEFD6;--pending:#C9D1D8;}
}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text)}
body{font:400 16px/24px var(--display);-webkit-font-smoothing:antialiased}
main{max-width:760px;margin:0 auto;padding:40px 16px 64px}
header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:40px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:18px;letter-spacing:-.01em}
.brand svg{width:26px;height:26px}
.net{font:400 12px/16px var(--mono);color:var(--muted)}

.hero{display:grid;grid-template-columns:1fr auto;gap:24px;align-items:end;padding-bottom:32px;border-bottom:1px solid var(--line)}
.hero h1{margin:0;font:800 44px/46px var(--display);letter-spacing:-.025em;max-width:14ch}
.hero p{margin:12px 0 0;color:var(--muted);max-width:46ch}
.switch{appearance:none;border:0;cursor:pointer;display:flex;align-items:center;gap:14px;padding:10px 22px 10px 10px;border-radius:999px;
  font:700 17px/20px var(--display);background:var(--accent);color:var(--on-accent);transition:background .2s,color .2s}
.switch .knob{width:40px;height:40px;border-radius:50%;background:var(--on-accent);display:grid;place-items:center;transition:transform .25s}
.switch .knob i{width:12px;height:12px;border-radius:50%;background:var(--accent)}
.switch[data-on="false"]{background:var(--raised);color:var(--text);box-shadow:inset 0 0 0 1px var(--line-strong)}
.switch[data-on="false"] .knob{background:var(--pending)}
.switch[data-on="false"] .knob i{background:var(--muted)}
.switch:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.switch[disabled]{opacity:.6;cursor:progress}

/* Latido: 4 trozos de datos + 1 de paridad, como una franja de fragmentos. Se enciende con cada bloque. */
.pulse{display:flex;align-items:center;gap:20px;padding:32px 0;border-bottom:1px solid var(--line)}
.height{font:500 56px/56px var(--mono);letter-spacing:-.04em;font-variant-numeric:tabular-nums}
.height small{display:block;font:400 13px/18px var(--display);letter-spacing:0;color:var(--muted);margin-top:8px}
.stripe{display:flex;gap:6px;margin-left:auto}
.stripe span{width:22px;height:44px;border-radius:3px;background:var(--pending)}
.stripe span.parity{width:10px;background:none;box-shadow:inset 0 0 0 1px var(--line-strong)}
.stripe.beat span:not(.parity){animation:lit .9s ease-out both}
.stripe.beat span:nth-child(2){animation-delay:.06s}.stripe.beat span:nth-child(3){animation-delay:.12s}.stripe.beat span:nth-child(4){animation-delay:.18s}
.stripe.beat span.parity{animation:litp .9s .24s ease-out both}
@keyframes lit{0%{background:var(--accent)}100%{background:var(--pending)}}
@keyframes litp{0%{box-shadow:inset 0 0 0 1px var(--accent);background:var(--accent-soft)}100%{box-shadow:inset 0 0 0 1px var(--line-strong)}}
.paused .stripe span:not(.parity){background:var(--raised)}

.figures{display:grid;grid-template-columns:repeat(3,1fr);gap:0;border-bottom:1px solid var(--line)}
.fig{padding:24px 0}
.fig + .fig{padding-left:20px;border-left:1px solid var(--line)}
.fig b{display:block;font:700 26px/30px var(--display);letter-spacing:-.01em;font-variant-numeric:tabular-nums}
.fig > span{color:var(--muted);font-size:14px}
.tier{display:inline-flex;align-items:center;gap:8px}
.tier i{width:10px;height:10px;border-radius:50%;background:var(--bronce)}

dl{margin:0;padding:24px 0 0;display:grid;grid-template-columns:max-content 1fr;gap:12px 24px}
dt{color:var(--muted);font-size:14px}
dd{margin:0;font:400 13px/20px var(--mono);overflow-wrap:anywhere}
dd.plain{font:400 15px/20px var(--display)}
.peers{list-style:none;margin:0;padding:0}
.peers li{display:flex;gap:12px;justify-content:space-between}
.peers li span{color:var(--muted)}
.copy{background:none;border:0;color:var(--accent);font:500 13px/20px var(--display);cursor:pointer;padding:0 0 0 8px}
.copy:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.err{color:var(--danger)}
footer{margin-top:40px;color:var(--muted);font-size:13px}
@media (max-width:600px){
  .hero{grid-template-columns:1fr}.hero h1{font-size:34px;line-height:38px}
  .height{font-size:42px;line-height:44px}
  .figures{grid-template-columns:1fr 1fr}.fig:nth-child(3){grid-column:1/-1;border-left:0;padding-left:0;border-top:1px solid var(--line)}
  dl{grid-template-columns:1fr;gap:4px}dd{margin-bottom:10px}
}
@media (prefers-reduced-motion: reduce){.stripe.beat span{animation:none!important}.switch,.switch .knob{transition:none}}
</style>
</head>
<body>
<main id="app">
  <header>
    <div class="brand">
      <svg viewBox="0 0 32 32" aria-hidden="true"><rect x="3" y="6" width="5" height="20" rx="1" fill="#FFB224"/><rect x="10" y="6" width="5" height="20" rx="1" fill="#FFB224" opacity=".8"/><rect x="17" y="6" width="5" height="20" rx="1" fill="#FFB224" opacity=".6"/><rect x="24.5" y="6" width="4" height="20" rx="1" fill="none" stroke="#FFB224"/></svg>
      Velum
    </div>
    <div class="net" id="net">velum-testnet-1</div>
  </header>

  <section class="hero">
    <div>
      <h1 id="headline">Conectando con tu nodo…</h1>
      <p id="sub">Este panel solo se ve desde este ordenador.</p>
    </div>
    <button class="switch" id="toggle" data-on="true" aria-pressed="true" disabled>
      <span class="knob"><i></i></span><span id="toggleText">Pausar aportación</span>
    </button>
  </section>

  <section class="pulse" aria-live="polite">
    <div class="height"><span id="height">—</span><small>bloque actual de la cadena</small></div>
    <div class="stripe" id="stripe" aria-hidden="true"><span></span><span></span><span></span><span></span><span class="parity"></span></div>
  </section>

  <section class="figures">
    <div class="fig"><b id="earned">—</b><span>VEL descubiertos por este nodo</span></div>
    <div class="fig"><b id="relayed">—</b><span>fragmentos transportados</span></div>
    <div class="fig"><b class="tier"><i id="tierDot"></i><span id="tier">—</span></b><span>nivel del nodo</span></div>
  </section>

  <dl>
    <dt>Nombre</dt><dd class="plain" id="name">—</dd>
    <dt>Dirección del nodo</dt><dd><span id="address">—</span><button class="copy" data-copy="address">Copiar</button></dd>
    <dt>Cartera de cobro</dt><dd><span id="payout">—</span></dd>
    <dt>Saldo de cobro</dt><dd class="plain" id="balance">—</dd>
    <dt>Conexión</dt><dd class="plain" id="conn">—</dd>
    <dt>Nodos vecinos</dt><dd><ul class="peers" id="peers"><li>—</li></ul></dd>
    <dt>Encendido desde hace</dt><dd class="plain" id="uptime">—</dd>
  </dl>
  <footer>Para cambiar el nombre o la cartera: <code>velum start --name … --payout …</code>. Versión <span id="version">—</span>.</footer>
</main>
<script>
const $ = (id) => document.getElementById(id);
const vel = (micro) => (micro / 1e6).toLocaleString("es-ES", { maximumFractionDigits: 3 }) + " VEL";
const int = (n) => Number(n).toLocaleString("es-ES");
const tierName = { bronce: "Bronce", plata: "Plata", oro: "Oro", diamante: "Diamante" };
const tierColor = { bronce: "var(--bronce)", plata: "var(--plata)", oro: "var(--oro)", diamante: "var(--diamante)" };
function dur(s) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return d + " d " + h + " h";
  if (h) return h + " h " + m + " min";
  if (m) return m + " min";
  return s + " s";
}
let last = null, busy = false;
async function refresh() {
  try {
    const r = await fetch("/status", { cache: "no-store" });
    render(await r.json());
  } catch {
    $("headline").textContent = "No hay respuesta del nodo";
    $("sub").innerHTML = '<span class="err">El proceso no está en marcha. Arráncalo con <code>velum start</code>.</span>';
    $("toggle").disabled = true;
  }
}
function render(s) {
  const on = !s.paused;
  document.body.classList.toggle("paused", !on);
  $("headline").textContent = on ? (s.ready ? "Tu nodo está aportando a la red" : "Tu nodo se está poniendo al día") : "Aportación en pausa";
  $("sub").textContent = on
    ? "Transporta fragmentos cifrados de otros, firma bloques y cobra VEL por el trabajo entregado."
    : "El nodo sigue encendido pero no se conecta a nadie ni produce bloques. Enciéndelo cuando quieras.";
  const t = $("toggle");
  t.dataset.on = String(on); t.setAttribute("aria-pressed", String(on)); t.disabled = busy;
  $("toggleText").textContent = on ? "Pausar aportación" : "Encender aportación";
  $("height").textContent = int(s.height);
  if (last && s.height > last.height && on) { const st = $("stripe"); st.classList.remove("beat"); void st.offsetWidth; st.classList.add("beat"); }
  $("earned").textContent = vel(s.earned);
  $("relayed").textContent = int(s.counters.shardsRelayed);
  $("tier").textContent = s.tier ? tierName[s.tier] || s.tier : "Sin alta aún";
  $("tierDot").style.background = tierColor[s.tier] || "var(--pending)";
  $("name").textContent = s.name;
  $("address").textContent = s.address;
  $("payout").textContent = s.payout === s.address ? s.payout + " (la del propio nodo)" : s.payout;
  $("balance").textContent = vel(s.payoutBalance);
  $("conn").textContent = !on ? "Desconectado (en pausa)"
    : (s.gateway ? (s.hubConnected ? "Puerta de entrada conectada" : "Buscando la puerta de entrada…") : "Solo pares directos")
      + (s.registered ? (s.active ? " · produciendo bloques" : " · dado de alta") : " · esperando el alta en la cadena");
  const ul = $("peers"); ul.textContent = "";
  if (!s.peers.length) { const li = document.createElement("li"); li.textContent = on ? "Ninguno todavía" : "—"; ul.append(li); }
  for (const p of s.peers) {
    const li = document.createElement("li");
    li.textContent = (p.name || p.node.slice(0, 10)) + " ";
    const sp = document.createElement("span"); sp.textContent = "#" + int(p.height) + " · " + p.via; li.append(sp); ul.append(li);
  }
  $("uptime").textContent = dur(s.uptime);
  $("version").textContent = s.build ?? ("protocolo " + s.version);
  $("net").textContent = s.chain;
  last = s;
}
$("toggle").addEventListener("click", async () => {
  if (!last || busy) return;
  busy = true; $("toggle").disabled = true;
  try { const r = await fetch(last.paused ? "/resume" : "/pause", { method: "POST" }); render(await r.json()); }
  finally { busy = false; $("toggle").disabled = false; }
});
document.querySelector("[data-copy]").addEventListener("click", (e) => {
  navigator.clipboard?.writeText($("address").textContent).then(() => { e.target.textContent = "Copiada"; setTimeout(() => (e.target.textContent = "Copiar"), 1500); });
});
refresh(); setInterval(refresh, 2000);
</script>
</body>
</html>`;
