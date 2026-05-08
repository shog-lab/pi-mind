# pi-mind

Give pi a mind: portable memory and self-evolution as a drop-in [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent) extension.

## What this is

A pi extension package that adds:

- **Persistent memory** — episodic logs (sessions, observations) + distilled knowledge + relational graph
- **Self-evolution** — daily-audit, wiki-lint, and meta-triage skills that let the agent improve its own knowledge over time
- **Schema-driven** — frontmatter validation, lossy-migration tooling, lint loop

Drop into any repo as a `devDependency`; pi running in that repo automatically gains memory and self-evolution.

## Memory model

```
.pi-mind/
  episodic/    — what happened (sessions, observations, compactions)
  knowledge/   — what's true (compiled facts and concepts)
  graph/       — how it's connected (entities, relations, triples)
```

Three layers map to cognitive science: episodic / semantic / relational. Markdown wiki is one possible rendering of `knowledge/`, not memory itself.

## Install

```bash
npm i -D pi-mind
```

`postinstall` creates a project-local `.pi/` with extensions and skills symlinked from the package, plus the `episodic/`, `knowledge/`, `graph/` directories.

## Use

```bash
pi              # interactive — pi loads memory extension automatically
pi -p "run daily-audit skill"   # cron use
```

## Status

Early. APIs may change.
