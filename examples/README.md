# Examples

## hello

A hello-world microfoom program (`hello.ts`): TypeScript orchestrates, the model
writes a greeting and returns it through the structured channel (FOOMRETURN),
schema-validated.

### Run it

Needs a model + API key configured in `~/.pi` (this example defaults to
`openrouter/deepseek/deepseek-v4-flash`; override with `MICROFOOM_MODEL`).

```bash
pnpm run example            # greets "world"
pnpm run example -- Ada     # greets "Ada"
```

`pnpm run example` runs `examples/run.ts` with `tsx` (which transpiles the
TypeScript + decorators). It opens a pi session, runs the program, and prints the
returned greeting.

To see exactly what the model did each turn (prompt, tools, tool calls, errors),
set a log file:

```bash
MICROFOOM_LOG=/tmp/microfoom/hello.jsonl pnpm run example -- Ada
cat /tmp/microfoom/hello.jsonl   # one JSON record per model turn
```

### Or, via the CLI

The `microfoom run` CLI runs any program file directly — this is how an agent
invokes a program over bash (result on stdout, trace on stderr):

```
microfoom run examples/hello.ts Ada
```

