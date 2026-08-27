<!-- SEED: re-run $impeccable document once there's code to capture the actual tokens and components. -->
---
name: OPAS
description: A calm, precise help center that teams can theme, deploy, and own.
---

# Design System: OPAS

## Overview

**Creative North Star: "The Release Proof"**

Picture a technical editor at a bright workstation reviewing the final proof before a release: pure white working space, near-black type, and a controlled safelight red reserved for decisions. The product is quiet enough for sustained reading and authoring, but never anonymous. Its confidence comes from sharp hierarchy, responsive feedback, and visible ownership.

The default register is a restrained product interface. Motion acknowledges state changes instead of staging the page. Public content takes cues from the composure of Vercel documentation, the legibility of Notion, and the operational precision of Linear without copying any of their visual identities. Expensive helpdesk-suite clutter and generic AI SaaS marketing are explicitly rejected.

**Key Characteristics:**

- Pure, high-contrast reading surfaces
- One controlled brand color used for decisions and active state
- Compact, familiar admin controls
- Generous article typography and shallow navigation
- Responsive state transitions, never decorative choreography

## Colors

The default palette is restrained: pure neutral surfaces, warm near-black ink, and one crimson anchor that appears on less than 10% of a screen. Exact OKLCH tokens will be resolved during implementation from the required brand seed.

**The Signal Rule.** Saturated color marks primary action, current selection, or meaningful status only. It is never filler decoration.

**The Theme Rule.** Runtime themes may replace token values freely, but every preset must preserve semantic roles and accessible contrast.

## Typography

Use a single technical-humanist sans family across product controls and public content, with a monospace face reserved for code. The exact family and scale will be chosen during implementation. Product UI uses a fixed, compact hierarchy; article prose stays within 65–75 characters per line and opens up in size and leading.

**The Reading Rule.** Article typography may breathe, but buttons, labels, navigation, and data never use display styling.

## Elevation

The system is flat by default. Tonal surface changes, borders, and sticky positioning establish structure; restrained shadows appear only where an element physically overlays another surface. Responsive motion uses 150–250 ms state transitions and has a reduced-motion equivalent.

**The Earned Elevation Rule.** A shadow must explain layering. Decorative ambient glow is forbidden.

## Components

Component geometry, state vocabulary, and exact spacing will be extracted after the first public and admin surfaces exist. Buttons, fields, navigation, article callouts, search results, and feedback controls will share one coherent shape and focus language across every route.

## Do's and Don'ts

### Do:

- **Do** optimize every public screen for finding and reading an answer.
- **Do** use familiar product controls with complete hover, focus, active, disabled, loading, and error states.
- **Do** preserve WCAG 2.2 AA contrast and visible focus in every runtime theme.
- **Do** let theme tokens create brand variety while keeping semantic roles stable.

### Don't:

- **Don't** reproduce expensive helpdesk-suite clutter that makes the knowledge base subordinate to ticketing.
- **Don't** use generic AI SaaS marketing: purple gradients, glass panels, glowing abstractions, or inflated claims.
- **Don't** build endless identical card grids, decorative dashboards, or novelty controls.
- **Don't** use proprietary-looking patterns that obscure content ownership or make customization feel gated.
- **Don't** use colored side-stripe borders, gradient text, decorative glassmorphism, or wide ghost-card shadows.
