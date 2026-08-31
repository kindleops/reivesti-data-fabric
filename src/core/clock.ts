// Wall-clock time is an injected input, never an ambient dependency: replay must
// reproduce a run without reproducing the moment it happened.
export type Clock = { now(): Date };

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(iso: string): Clock {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) throw new TypeError(`fixedClock: invalid instant ${iso}`);
  return { now: () => new Date(t) };
}
