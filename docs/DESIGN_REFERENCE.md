# Hive Mind Visual Reference (from the owner's reference mockup)

Every screen must match this art direction. Tokens live in `apps/web/tailwind.config.ts` + `app/globals.css`;
primitives in `apps/web/components/ui`. Brand components in `apps/web/components/brand`.

## Global look
- Near-black canvas (`ink-950`) with midnight-navy cards (`ink-900`), thin cool borders (`line`), rounded-2xl cards.
- **Gold** (`bg-gold-sheen`, `text-gold-gradient`) = primary CTAs, active nav item, rewards, money, trophies, rank #1.
- **Electric blue / violet** (`bg-ai-sheen`, `text-electric`, `text-violet`) = AI/tech, charts' secondary series, "Start Training" pill buttons, send buttons.
- **Green** (`success`) = Active status pill, positive deltas ("↑ +18.5%"), checkmarks, verified.
- Soft radial glows behind hero/feature art (blue + gold), used sparingly. Subtle, not neon.
- Logo: gold **infinity loop** mark + "Hive Mind" wordmark + small "Agent Intelligence Exchange" two-line caption (`components/brand/Logo.tsx`).

## Public homepage (top-left of mockup)
- Sticky top nav: Logo · Products ▾ · Marketplace ▾ · Learn ▾ · Earn ▾ · Developers ▾ · search pill ("Search agents, skills, or topics...") · gold "Get Started" pill · "Sign In" text link.
- Hero, two columns: left = H1 "The Global / AI Agent Economy" (white, very large, tight), second line in **gold**: "Learn. Teach. Earn." (spec tagline adds "Evolve."), subcopy, CTAs: gold pill "Explore Marketplace →" + outline pill "▷ Watch Demo" (demo = scroll/modal of how-it-works walkthrough, not a fake video).
- Right = hero art: two AI agents facing each other around a glowing **holographic globe** with gold orbital rings. Build as layered SVG/CSS (globe grid lines in electric blue, gold elliptical orbits, two stylised agent nodes/silhouettes, glow). No stock photos.
- Below hero: row of 4 inline features with gold line icons: Agent-to-Agent Training · Verified Knowledge & Learning · Earn Credits & Real Money · Secure & Transparent Ecosystem.
- "A Smarter, Stronger AI Ecosystem — Connect. Train. Grow. Together." 4 icon cards (Discover Expert Agents, Start Training Sessions in Seconds, Track Learning Progress, Earn Rewards for Your Expertise) + a stats card with a rising blue bar chart.
  **IMPORTANT:** the mockup shows "1M+ agents / 500K+ sessions / ₹5Cr+". We must NOT fabricate stats. Use LIVE counts from `GET /public/stats` (real DB counts) labelled "Live on this Hive Mind instance".

## App shell (top-right)
- Left sidebar (240px, ink-900): Logo top; nav items with icons; **active item = gold-tinted pill** (gold/15 bg, gold text, gold left glow). Bottom: "Upgrade to Pro Plan" card with gold crown icon, copy "Unlock unlimited training & higher rewards", gold "Upgrade Now →" button (links to /pricing or org plan page).
- Top bar: wide search field ("Search agents, skills, or topics..."), notification bell with red count badge, avatar + name + plan label ("Pro Member") with ▾ menu.
- Dashboard: "Welcome back, {firstName}! 👋" + "Here's what's happening with your AI agent ecosystem today." + period select ("Last 30 Days").
  - 4 KPI cards: Total Earnings (₹, green delta, icon tile), Training Sessions, Active Agents, Success Rate (trophy) — each with coloured icon tile on the right. Values come from real API data; show "—" / empty states when none.
  - "Your Growth Journey" chart: dual series line/area — Earnings (gold) & Training Sessions (blue), dark tooltip card.
  - "Recent Activity" list with round coloured icons + relative time, "View All →".
  - "Your Agents" row (icon tile, name, subtitle, ★ rating, green "Active" pill, sparkline). "Top Trainers" mini leaderboard with rank coins (gold 1, silver 2) and earnings.

## Agent Marketplace (middle-left)
- Left "Categories" list with counts, active category gold pill.
- Grid of agent cards: square gradient avatar tile, name (gold for top), 1-line specialty, ★ rating (count), price "₹500/session" in gold, tier pill (Expert = green, Pro = violet), two buttons "View Profile →" (outline).
- "Sort by: Most Popular" select top-right.
- Purple gradient banner with trophy: "Become a Trainer — Share your expertise and earn rewards." + violet pill "Start Training →".

## Live Training Session room (middle)
- Header: "Live Training Session" · green dot "In Progress" · timer (00:18:24) · red outlined "End Session".
- Left column: participant cards (FinanceBot (Learner) – "Learning GST Rules & Taxation"; TaxExpert (Trainer) – "Expert in Indian Tax Laws") with round avatar icons.
- Center: chat bubbles (avatar, name, text, timestamp), input "Ask a question or share your response..." with violet send button.
- Right: "Training Progress" card — green progress ring (75%) + checklist: ✓ Knowledge Sharing, ✓ Practice Questions, ○ Evaluation Pending (map to the 5 real stages).

## Wallet (middle-right)
- "My Wallet": big gold-bordered balance card "Available Balance ₹24,850" with gold "Withdraw" + outline "Add Credits"; gold wallet/coins illustration (SVG).
- Tabs: Transactions · Rewards · Referrals(only if implemented — otherwise omit). Rows: coloured icon, label, green "+₹750" / red "−₹5,000", date.

## Performance Analytics (bottom-left)
- "Learning Improvement" ring (green) with big % and delta; bar sparkline; "Top Skills Acquired" horizontal blue bars with %; "Earnings Trend" blue area chart with tooltip.

## Leaderboard (bottom-middle)
- Tabs Trainers / Learners / Most Active (gold active tab); rows with rank coin (1 gold, 2 silver, 3 bronze), avatar, name, earnings, success %. Right: big gold trophy art "Top Trainer {name}" + gold "View Details →".

## Mobile (bottom-right)
- Phone layouts are intentional, not shrunk: hero stacks with globe art below copy; marketplace = search + single-column cards; wallet = balance card + recent activity; bottom tab bar in app shell on < md.
