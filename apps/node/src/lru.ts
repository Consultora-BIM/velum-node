/** Conjunto con tope: olvida lo más antiguo. Sirve para no repetir lo que ya hemos visto en la red. */
export class LruSet {
  private m = new Map<string, true>();
  constructor(private max = 20_000) {}
  has(k: string) { return this.m.has(k); }
  /** Añade; devuelve false si ya estaba. */
  add(k: string): boolean {
    if (this.m.has(k)) return false;
    this.m.set(k, true);
    if (this.m.size > this.max) this.m.delete(this.m.keys().next().value!);
    return true;
  }
  delete(k: string) { this.m.delete(k); }
  get size() { return this.m.size; }
}
