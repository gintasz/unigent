import Link from 'next/link';

const features = [
  {
    title: 'Code is in control',
    body: 'Orchestration is ordinary TypeScript. The model is called only for the fuzzy parts and reports back through a typed channel.',
  },
  {
    title: 'Capability security',
    body: 'Methods are unreachable by default. @foom.expose opts a method in — at one of three context-cost tiers.',
  },
  {
    title: 'Schema-validated output',
    body: 'this.agent.value(schema) returns a typed, validated result. Bad output is repaired automatically, then fails loudly.',
  },
  {
    title: 'Typed failures',
    body: 'Every failure is a FoomtimeError subclass — discriminate with instanceof, never parse a string.',
  },
];

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col items-center px-4">
      <section className="flex flex-col items-center gap-6 py-24 text-center">
        <span className="rounded-full border border-fd-primary/30 bg-fd-primary/10 px-3 py-1 text-sm text-fd-primary">
          Coordination engineering for TypeScript
        </span>
        <h1 className="bg-gradient-to-br from-indigo-400 to-indigo-600 bg-clip-text text-5xl font-bold tracking-tight text-transparent sm:text-6xl">
          microfoom
        </h1>
        <p className="max-w-xl text-lg text-fd-muted-foreground">
          Coordination a single prompt can&apos;t express.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/docs"
            className="rounded-lg bg-fd-primary px-5 py-2.5 font-medium text-fd-primary-foreground transition-opacity hover:opacity-90"
          >
            Getting started →
          </Link>
          <Link
            href="https://github.com/gintasz/microfoom"
            className="rounded-lg border border-fd-border px-5 py-2.5 font-medium transition-colors hover:bg-fd-accent"
          >
            View on GitHub
          </Link>
        </div>
      </section>

      <section className="grid w-full max-w-4xl gap-4 pb-24 sm:grid-cols-2">
        {features.map((f) => (
          <div
            key={f.title}
            className="rounded-xl border border-fd-border bg-fd-card p-5 transition-colors hover:border-fd-primary"
          >
            <h2 className="mb-2 font-semibold">{f.title}</h2>
            <p className="text-sm text-fd-muted-foreground">{f.body}</p>
          </div>
        ))}
      </section>
    </main>
  );
}
