#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");

const child = spawn("npm", ["run", "output", "--", ...process.argv.slice(2)], {
  cwd: require("node:path").resolve(__dirname, ".."),
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
