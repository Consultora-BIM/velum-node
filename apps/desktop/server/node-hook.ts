// Repositorio público: el nodo compila sin la interfaz de escritorio (que es de la app Velum, cerrada).
// Las versiones oficiales firmadas sí la incluyen. El nodo funciona igual sin ella.
type Hooks = Record<string, unknown>;
export type NodeHooks = Hooks;
export type DesktopApi = { hasGui: false; url: string; handle(req: Request, ip?: string | null): Response | undefined };
export async function mountDesktop(_hooks: NodeHooks): Promise<DesktopApi> {
  return { hasGui: false, url: "", handle: () => undefined };
}
export function canOpenBrowser() { return false; }
export function openOnFirstStart(_api: DesktopApi, _dir: string) { return false; }
export async function openCommand(_dir: string, _port: number) {
  return { ok: false, error: "Esta compilación no incluye la app de escritorio. Usa la versión oficial de https://velumprotocol.org/descargar" };
}
