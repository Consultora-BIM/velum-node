// Registro en una línea, en castellano. VELUM_LOG=debug para ver todo; VELUM_LOG=quiet para callar.
const LEVEL = (process.env.VELUM_LOG ?? "info").toLowerCase();
const debugOn = LEVEL === "debug";
const quiet = LEVEL === "quiet" || LEVEL === "silent";

let tag = "";
export const setLogTag = (t: string) => { tag = t ? `[${t}] ` : ""; };

const stamp = () => new Date().toISOString().slice(11, 19);

export const log = {
  info: (...a: unknown[]) => { if (!quiet) console.log(stamp(), tag + a.map(String).join(" ")); },
  warn: (...a: unknown[]) => { if (!quiet) console.warn(stamp(), tag + "aviso: " + a.map(String).join(" ")); },
  error: (...a: unknown[]) => console.error(stamp(), tag + "error: " + a.map(String).join(" ")),
  debug: (...a: unknown[]) => { if (debugOn) console.log(stamp(), tag + "· " + a.map(String).join(" ")); },
  isDebug: debugOn,
};
