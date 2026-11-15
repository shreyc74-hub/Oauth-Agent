// Shared wording for run results, used by the run page, the runs list, the log and the sheet.
import type { Run } from "./types";

/** Verified, but nobody said what the app is for: only sign-in was proven, not the scopes. */
export const signInOnly = (r: Pick<Run, "status" | "scopePlan">) => r.status === "verified" && !r.scopePlan;

export const SIGN_IN_ONLY = "Verified for sign-in only";
export const SIGN_IN_ONLY_WHY = "No use case was given, so the scopes were taken from the plan and not checked against what the app will do. The credentials work; they may be too narrow for the toolkit.";
