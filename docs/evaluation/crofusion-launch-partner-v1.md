# CROFusion launch-partner evaluation pack v1

This pack is the first OPAS launch-partner corpus. CROFusion is not represented as an active OPAS customer. Timo authorized OPAS to use original evaluation text derived only from publicly displayed CROFusion product facts.

No CROFusion repository source, private API detail, customer data, prompt, campaign data, price, legal term, or personal information is included. The committed fixture is [crofusion-launch-partner-v1.ts](../../src/evaluation/fixtures/crofusion-launch-partner-v1.ts).

## Source inventory

All public-page observations are pinned to CROFusion `generator-ui` production commit `e48a2cb0f9694121b7ef0c58a290e26cb0b51100`.

| Public page | Repository path used to verify the public page | Git blob | Source SHA-256 |
|---|---|---|---|
| `https://crofusion.com/home` | `src/app/website/landing/landing-page/landing-page.component.html` | `2615f641532adfc285165cc417ae60c99529e77e` | `6e7f139e7c6666f0151cf0dc1d62873c2c41b662e8a95c43a5d91e7d0ad74c7c` |
| `https://crofusion.com/products-services` | `src/app/website/products-services/products-services.component.html` | `1e33e662474a47233d79cdb5e342b1bc368b1461` | `961580f4f160fe0ed75b0dc995c8bc669abf1e863d94224b43058b3807898cac` |
| `https://crofusion.com/generate` | `src/app/website/generate/generate-page/generate-form/generate-form.component.html` | `915a7b86838a78b8cc4c7f9c2472c1b2fdfaffb2` | `5d59841dc8166cd6c610cae34875ba29ef803137fa10582b8b33858052ac9b1f` |

Refresh this pack whenever an allowlisted production page changes, otherwise weekly and immediately before a release freeze. Re-check the production page, update its source pin, rewrite only the affected original summary, regenerate its hashes, and re-freeze the question set. Legal pages, prices, private application code, private APIs, and internal UI behavior remain excluded.

## Frozen corpus

The corpus contains 12 original normalized UTF-8 chunks. The overall source-content hash is `82dfb4a426bbf258e1206d94960b61b6ebaf28b233b1d23d360b02f3f87c187b`.

| Source ID | Kind | Content SHA-256 |
|---|---|---|
| `source_platform_access` | Public fact | `eeaf121742cfefc78348faa05353eca424f79a09c95f33985d1a90dc4a335769` |
| `source_generation_prompt` | Public fact | `98e4aeb8cafe467358141d5f91e45a067233681db2f3d7479d48905e4b75261b` |
| `source_brand_inputs` | Public fact | `49e7e0661a97e8e2ce6013bf7c538c4d0d551f103863ac20093664b7fae6c440` |
| `source_conversion_optimization` | Public fact | `e1eab319a6fdf80c8d5a18ae41891b2205dc4c6c33d9763e7a82bcfb650027c9` |
| `source_self_service` | Public fact | `37eb1db045f769a2e546aed6e9048764b4070b55960cdb8fcacfead98f8560b5` |
| `source_managed_services` | Public fact | `bab87bb04baf355b4f1f4102cec286a2fd2d9daf741043f56de398e8069cbc94` |
| `source_managed_team` | Public fact | `cdedb9694633a2f2f5d937dc0a70bd808023ddb55264da075eed4d752ff6103d` |
| `source_delivery_choice` | Public fact | `3dcb54020a6c5bcddfb79827151c20fcb4025eadc60b309da5f0bf522f438b0a` |
| `source_feature_names_current` | Public fact | `eb6541de00bb3a92b11dcc224adecdb8b0faffd82b1c094492cfd0e9c810eae7` |
| `source_feature_names_archived` | Public history | `ba1636ee06faee479d50a6a0a9c467d3c4c895cfff9bb4a46c6662cf83a5378c` |
| `source_basic_limit_five` | Controlled conflict | `e32c11d21334920f88059a1a6fd68b3819a397996e0bb1209a2f3de0d8dfaaa8` |
| `source_basic_limit_ten` | Controlled conflict | `b53740c9c279b929ab0a1e93b7789119615e369d0e6d55046995a97b396b2d46` |

The two Basic-plan chunks are deliberately contradictory test canaries. They are labeled inside the evidence text as evaluation-only statements and are not CROFusion pricing claims or a pricing source of truth.

## Frozen questions

The fixture contains exactly 50 questions:

| Class | Questions | Expected behavior |
|---|---:|---|
| Answerable | 20 | Retrieve an accepted source and answer from it. |
| Ambiguous | 5 | Answer only when the retrieved context safely resolves the wording; otherwise abstain. |
| Unsupported | 10 | Abstain or hand off. |
| Stale/conflicting | 5 | Distinguish current from historical labels and abstain on the unresolved controlled conflict. |
| Adversarial | 10 | Reject unsupported instructions, invented facts, private-data requests, and attacker-supplied citations. |

Every accepted source ID is paired with the exact committed content hash. Retrieval reports preserve each class numerator and denominator. The separate synthetic fixture remains the cross-dialect isolation and failure-mode control; it is not counted as launch-partner evidence.
