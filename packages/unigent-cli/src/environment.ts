import process from "node:process";

function environmentVariable(name: string): string | undefined {
  // biome-ignore lint/style/noProcessEnv: This module is the process-environment boundary.
  return process.env[name];
}

function childProcessEnvironment(
  overrides: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  // biome-ignore lint/style/noProcessEnv: This module is the process-environment boundary.
  const environment = { ...process.env };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete environment[name];
    } else {
      environment[name] = value;
    }
  }
  return environment;
}

export { childProcessEnvironment, environmentVariable };
