// Runs once when the server starts, before any request.
import { normalizeEnv } from "./lib/env";

export function register() {
  normalizeEnv();
}
