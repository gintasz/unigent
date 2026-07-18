import process from "node:process";
import { marker } from "./node_typescript_dependency.js";

const runtime: string = process.versions["bun"] === undefined ? "node" : "bun";
process.stdout.write(`TYPESCRIPT MODULE: ${marker}\nSCRIPT RUNTIME: ${runtime}\n`);
