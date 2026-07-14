#!/usr/bin/env bun

const runtime = process.versions["bun"] === undefined ? "node" : "bun";
process.stdout.write(`SCRIPT RUNTIME: ${runtime}\n`);
