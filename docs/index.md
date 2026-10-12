---
layout: home

hero:
  name: Freight Delay
  text: A fully-collateralised Anchor program on Solana
  tagline: Parametric freight-delay indemnity for exporters and forwarders — a payout triggers when an attested arrival lands after the quoted SLA plus a grace period.
  actions:
    - theme: brand
      text: Get started
      link: /freight_delay/introduction/overview

features:
  - title: Fully collateralised by construction
    details: total_locked_risk <= total_capital is re-checked at the end of every state-mutating instruction, not just at entry. A payout can never exceed capital that exists.
  - title: Parametric, not discretionary
    details: The policy settles on an attested arrival past an SLA plus grace. No claim forms, no loss adjuster, no subjective vote.
  - title: Permissionless settlement
    details: settle_policy is callable by any signer once a policy matures. The crank has no discretion — it only supplies compute.
  - title: Small, auditable surface
    details: Five instructions, three account types, and one PDA-signed CPI, built on a vault-and-shares skeleton.
---

## One protocol, one skeleton

- **[Freight Delay](/freight_delay/introduction/overview)** — parametric
  freight-delay indemnity for exporters and forwarders. Payouts trigger when an
  attested arrival lands after the quoted SLA plus a grace period.

LPs deposit USDC for shares, buyers pay premiums that lock payout risk, one oracle
authority attests the delivery milestone, and settlement is permissionless. Every
outstanding payout is backed by capital the pool already holds, and that invariant
is re-checked after every state change.
