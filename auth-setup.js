#!/usr/bin/env node
// One-time login for kwikset-mcp.
//
// Run this yourself from a terminal - NOT through Claude - before wiring
// the MCP server up:
//
//     npm install
//     node auth-setup.js
//
// Credentials can be supplied three ways, checked in this order:
//   1. CLI flags:   node auth-setup.js --email you@example.com --password 'hunter2'
//   2. Env vars:    KWIKSET_EMAIL=... KWIKSET_PASSWORD=... node auth-setup.js
//   3. Interactive prompt (default, if neither of the above is given)
//
// Prefer env vars over --password when you can - command-line arguments
// are visible to other processes/users on the machine and get written to
// shell history.
//
// Your password is sent directly to Kwikset's own Cognito login endpoint
// and is never written to disk or logged. Only the resulting session
// tokens (id/access/refresh) are saved locally, to ~/.kwikset-mcp/tokens.json,
// so the MCP server can use and silently refresh them later without ever
// needing your password again.
//
// If your account requires phone verification, this script will prompt
// for the code Kwikset texts you.

import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { login } from "./src/cognito.js";
import { saveTokens, TOKEN_FILE } from "./src/auth.js";

const CTRL_C_CODE = 3; // ASCII ETX
const BACKSPACE_CODES = new Set([8, 127]); // \b and DEL

function parseCliArgs() {
  const { values } = parseArgs({
    options: {
      email: { type: "string", short: "e" },
      username: { type: "string" }, // alias for --email
      password: { type: "string", short: "p" },
      "mfa-code": { type: "string" },
    },
    strict: false,
  });
  return {
    email: values.email || values.username || null,
    password: values.password || null,
    mfaCode: values["mfa-code"] || null,
  };
}

/** Plain, visible prompt using Node's readline. */
async function promptVisible(question) {
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

/** Prompt for input without echoing it to the terminal (for the password).
 * Falls back to a visible prompt if stdin isn't an interactive TTY (e.g.
 * input is piped in), since raw mode isn't available there. */
async function promptHidden(question) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    return promptVisible(question);
  }

  stdout.write(question);

  return new Promise((resolve, reject) => {
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
    };

    const onData = (chunk) => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (ch === "\n" || ch === "\r") {
          cleanup();
          stdout.write("\n");
          resolve(value);
          return;
        }
        if (code === CTRL_C_CODE) {
          cleanup();
          stdout.write("\n");
          reject(new Error("Cancelled."));
          return;
        }
        if (BACKSPACE_CODES.has(code)) {
          value = value.slice(0, -1);
        } else {
          value += ch;
        }
      }
    };

    stdin.on("data", onData);
  });
}

async function resolveEmail(args) {
  return args.email || process.env.KWIKSET_EMAIL || (await promptVisible("Kwikset account email: "));
}

async function resolvePassword(args) {
  return (
    args.password ||
    process.env.KWIKSET_PASSWORD ||
    (await promptHidden("Kwikset account password: "))
  );
}

async function resolveMfaCode(args) {
  return (
    args.mfaCode ||
    process.env.KWIKSET_MFA_CODE ||
    (await promptVisible("Enter the verification code texted to you: "))
  );
}

async function main() {
  const args = parseCliArgs();

  console.log("Kwikset MCP - login\n");
  console.log(`Session tokens will be saved to: ${TOKEN_FILE}\n`);

  const email = await resolveEmail(args);
  const password = await resolvePassword(args);

  let mfaPromptShown = false;
  let tokens;
  try {
    tokens = await login(email, password, {
      getVerificationCode: async () => {
        if (!mfaPromptShown) {
          console.log("\nThis account requires phone verification.");
          mfaPromptShown = true;
        }
        return resolveMfaCode(args);
      },
    });
  } catch (err) {
    console.error(`\nLogin failed: ${err.message || err}`);
    process.exit(1);
  }

  saveTokens(tokens);
  console.log(`\nLogged in as ${email}.`);
  console.log("Session saved. The MCP server is ready to use from Claude.");
}

main();
