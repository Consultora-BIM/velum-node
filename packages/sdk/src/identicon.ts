// Identicono determinista de una dirección (SVG). Mismo dibujo en la web, la app y el explorador.
// Rejilla 5×5 simétrica a partir de sha256(dirección); color por el tono del hash. Sin datos del equipo ni nombres.
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";

export function identiconCells(address: string): boolean[][] {
  const h = sha256(utf8ToBytes(address));
  const rows: boolean[][] = [];
  for (let y = 0; y < 5; y++) {
    const half = [0, 1, 2].map((x) => (h[y * 3 + x]! & 1) === 1);
    rows.push([half[0]!, half[1]!, half[2]!, half[1]!, half[0]!]);
  }
  return rows;
}

export function identiconHue(address: string): number {
  const h = sha256(utf8ToBytes(address));
  return ((h[30]! << 8) | h[31]!) % 360;
}

/** SVG cuadrado de `size` px. `bg` vacío = transparente. */
export function identiconSvg(address: string, size = 40, bg = ""): string {
  const cell = size / 6, pad = cell / 2;
  const fill = `hsl(${identiconHue(address)} 62% 48%)`;
  const rects: string[] = [];
  identiconCells(address).forEach((row, y) => row.forEach((on, x) => {
    if (on) rects.push(`<rect x="${(pad + x * cell).toFixed(2)}" y="${(pad + y * cell).toFixed(2)}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}"/>`);
  }));
  const back = bg ? `<rect width="${size}" height="${size}" fill="${bg}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img">${back}<g fill="${fill}">${rects.join("")}</g></svg>`;
}
