// Lectura y escritura directa en la terminal (/dev/tty). Para secretos: sin eco, sin registros, sin disco.
// Escribir en /dev/tty (y no en stdout) evita que la frase acabe en un archivo si alguien redirige la salida.
import { closeSync, openSync, readSync, writeSync } from "node:fs";

const TTY = "/dev/tty";

export function hasTty(): boolean {
  try { closeSync(openSync(TTY, "r+")); return true; } catch { return false; }
}

function stty(arg: string) {
  Bun.spawnSync(["sh", "-c", `stty ${arg} < ${TTY}`], { stdout: "ignore", stderr: "ignore" });
}

/** Escribe en la terminal, nunca en stdout. */
export function ttyWrite(text: string) {
  const fd = openSync(TTY, "w");
  try { writeSync(fd, text); } finally { closeSync(fd); }
}

/** Borra la pantalla y el historial de desplazamiento de la terminal. */
export function ttyClear() {
  ttyWrite("\x1b[2J\x1b[3J\x1b[H");
}

function readLineFd(fd: number): string {
  const buf = new Uint8Array(1);
  const bytes: number[] = [];
  for (;;) {
    let n = 0;
    try { n = readSync(fd, buf, 0, 1, null); } catch (e: any) { if (e?.code === "EAGAIN") { Bun.sleepSync(20); continue; } throw e; }
    if (n === 0) break;
    if (buf[0] === 10) break;
    if (buf[0] !== 13) bytes.push(buf[0]!);
  }
  const out = new TextDecoder().decode(new Uint8Array(bytes));
  bytes.fill(0);
  return out;
}

/** Lee una línea de la terminal. `secret` = sin eco (no se ve lo que se escribe). */
export function ttyReadLine(prompt: string, secret = false): string {
  ttyWrite(prompt);
  const fd = openSync(TTY, "r");
  const restore = () => { if (secret) stty("echo"); };
  const onSig = () => { restore(); process.exit(130); };
  if (secret) { stty("-echo"); process.once("SIGINT", onSig); }
  try {
    return readLineFd(fd);
  } finally {
    restore();
    if (secret) { process.off("SIGINT", onSig); ttyWrite("\n"); }
    closeSync(fd);
  }
}

/**
 * Lee un secreto: de la terminal sin eco si la hay; si no (tubería), de stdin.
 * La segunda vía existe para automatizar pruebas: avisa por stderr.
 */
export function readSecret(prompt: string): string {
  if (hasTty() && process.stdin.isTTY) return ttyReadLine(prompt, true);
  process.stderr.write("Aviso: sin terminal; leo el secreto de la entrada estándar.\n");
  return readLineFd(0);
}

/** Lee una línea normal (con eco): terminal o stdin. */
export function readLine(prompt: string): string {
  if (hasTty() && process.stdin.isTTY) return ttyReadLine(prompt, false);
  process.stderr.write(prompt);
  return readLineFd(0);
}
