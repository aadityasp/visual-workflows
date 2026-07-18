/** Type surface for the dependency-free forwarder's testable pure helpers. */
export interface EventClass {
  isSessionStart: boolean;
  isSpawn: boolean;
}
export function classifyEvent(payload: unknown): EventClass;
export function redactString(input: string): string;
export function redactDeep(value: unknown): unknown;
export function runAutoOpen(payload: unknown): void;
