// Local storage for a Kwikset session (Cognito tokens + the account email
// needed to reconstruct a CognitoUser for silent refresh). We never want a
// Kwikset password flowing through an LLM conversation, so login happens
// once, interactively, via `auth-setup.js` (run directly by the user in a
// terminal). That script saves the resulting tokens here. The MCP server
// only ever reads/refreshes tokens from this file - it never asks for or
// handles the raw password.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export const TOKEN_DIR =
  process.env.KWIKSET_MCP_HOME || join(homedir(), ".kwikset-mcp");
export const TOKEN_FILE = join(TOKEN_DIR, "tokens.json");

export function saveTokens(data) {
  if (!existsSync(TOKEN_DIR)) {
    mkdirSync(TOKEN_DIR, { recursive: true });
  }
  writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2));
  try {
    chmodSync(TOKEN_FILE, 0o600);
  } catch {
    // best-effort - not fatal (e.g. unsupported on some Windows filesystems)
  }
}

export function loadTokens() {
  if (!existsSync(TOKEN_FILE)) return null;
  try {
    return JSON.parse(readFileSync(TOKEN_FILE, "utf-8"));
  } catch {
    return null;
  }
}

export function clearTokens() {
  try {
    unlinkSync(TOKEN_FILE);
  } catch {
    // already gone - fine
  }
}
