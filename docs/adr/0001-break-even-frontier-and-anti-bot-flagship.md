# ADR-0001: Reframe from "compute replaces ads" to a break-even frontier, with anti-bot PoW as the flagship

Status: Accepted (2026-08-02)

## Context

The original synopsis's headline claim was that consented, verifiable browser
compute could replace advertising as a web monetisation rail, subject to a
≤5% ambient resource ceiling. Two facts made that framing untenable before any
code was written:

1. **The economics don't close under the stated ceiling.** Pricing browser
   compute against consumer-GPU cloud spot (~$1.0×10⁻⁵/GFLOPS-hour) and
   advertising at realistic CPMs, WASM-on-CPU at 5% share is *worse* than the
   corrected cryptojacking baseline (ADR-0008), and even the best case —
   dGPU-class hardware, cheapest ad inventory, theoretical spot parity, zero
   verification overhead — needs ~6.7% share against a 5% ceiling. See
   `bench/breakeven.py`. A yes/no claim built on this framing resolves to "no."
2. **The threat model the synopsis leaned on for legitimacy (miner detectors
   like MINOS) is broken.** WASM binary diversification evades MINOS in 100%
   of cases (arXiv:2403.15197). A detector a miner escapes completely cannot
   certify that a legitimate workload is *not* a miner — see ADR-0002.

At the same time, a substitution target existed that the original framing had
missed entirely: client-side proof-of-work for bot deterrence (Cloudflare
Turnstile, Anubis, Friendly Captcha, mCaptcha) is *already deployed at internet
scale*, already burns CPU for valueless output — exactly cryptojacking's F2
failure mode, legitimised by convention — and its dominant baseline (SHA-256
hashcash) is independently known to be broken: Tavis Ormandy showed a
free-tier cloud instance can out-mine every Anubis deployment on the internet
in ~6 minutes.

## Decision

Two changes to the project's headline claim:

- **The measurement, not the verdict, is the contribution.** Publish
  `σ*(device, market)` — the break-even resource share as a function of device
  class and ad market — as a surface. A negative point-estimate is a weaker,
  less falsifiable result than a measured frontier that happens to say "not
  yet, and here's by how much."
- **The flagship deployable artifact is useful-PoW as a drop-in replacement
  for anti-bot hash puzzles**, not the ad-barter content gate. It doesn't need
  the 5% ceiling to close (challenge-mode PoW already runs at ~100% CPU for
  1–3s by convention), it has a real deployed buyer, and it needs exactly the
  verification layer (ADR-0002, ADR-0006) this project was already building.

## Consequences

- The barter/content-gate mechanism is **not deleted** — it remains the
  vehicle for the economic measurement in `bench/breakeven.py` and a secondary
  demo, but the project no longer rises or falls on it closing.
- This creates an explicit, load-bearing distinction between two modes with
  different security properties: in challenge mode the client is unpaid, so
  per-request cost asymmetry (deterrence) is preserved; in barter mode the
  client *is* paid, so the SoK's PoUW-undermines-security-budget critique
  applies in full and no anti-abuse claim is made for that mode. Keeping the
  two modes structurally separate (ADR-0006's audit-rate policy differs
  between them) is a correctness requirement, not a presentation choice.
- Outreach targets shift from ad-tech (Google, ad networks) to bot-management
  vendors (Cloudflare, Friendly Captcha, Anubis maintainers) — a smaller,
  more technically legible audience for a first contact.
- Alternative considered and rejected: keep the ad-barter framing and report
  the negative result as-is. Rejected because it forecloses the strongest,
  most deployable part of the design (ADR-0002's declaration-based legitimacy)
  in favour of a claim the project's own numbers don't support.
