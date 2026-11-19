# Replica for DSH

One skill, `replica`, that carries the eleven stages of the Replica pack
([Jakeschincariol/replica-skill](https://github.com/Jakeschincariol/replica-skill),
MIT) adapted to DeepSeek Harness.

## What it does

The model loads `replica` when a request is about cloning, replicating or
reverse-engineering an app or site, then reads the stage file it needs from
`stages/` and follows it. Stage files and the pack's Python utilities sit next
to the skill, so no other installation step is required.

Stages: recon, architect, design, build, backend, test, diff, entrepreneur,
brand, launch, deploy.

## How to use it

Ask in plain language — "clone this app", "разбери, как работает этот сервис,
и сделай мою версию" — or name a stage explicitly, for example "run
replica-recon on https://example.com". Every stage writes into `replica/` in
the current project, so the stages chain.

The six utilities are plain `python3`, standard library only:

```bash
python3 stages/replica-diff/parity.py replica/features.csv
python3 stages/replica-diff/imgdiff.py original.png clone.png --out diff.png
python3 stages/replica-entrepreneur/reviews.py replica/reviews.csv
python3 stages/replica-design/contrast.py replica/design/tokens.json
python3 stages/replica-brand/sweep.py . --avoid "Original App"
python3 stages/replica-launch/listing.py replica/launch/listing.json
```

## What it deliberately does not do

Clean-room only: functionality and flows, never the target's source code,
assets, logo, trademark, copy or private APIs. Public pages and the user's own
account only — no paywall bypass, no other people's accounts. Deploy refuses to
run until `sweep.py` reports the original's name and colours are gone.

## Known limits

Binding is read-only at the model level: the skill instructs, the model does the
work. Whether the model picks it up depends on the request wording, so a stage
can always be invoked by name.
