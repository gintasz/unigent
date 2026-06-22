// The execution engine: running a VIBEFUNCTION as a subagent, loading/parsing programs, binding args.
export { runThoughtcodeSubagent } from "./subagent.js";
export { loadProgram, type LoadedProgram } from "./program.js";
export { bindAndCheckArgs, type ArgBinding } from "./params.js";
