/** Public site information architecture — shared by the top nav, mobile sheet and footer. */
import {
  BadgeCheck, BookOpen, BookOpenCheck, Building2, Code2, Coins, Compass, Gauge, GraduationCap, HelpCircle, Info, KeyRound,
  LayoutGrid, Plug, ShieldCheck, Sparkles, Store, Trophy, Webhook, type LucideIcon,
} from 'lucide-react';

export interface NavLink { href: string; label: string; description?: string; icon?: LucideIcon }
export interface NavFeature { eyebrow: string; title: string; body: string; href: string; cta: string; tone: 'gold' | 'electric' | 'violet'; /** show live counts from /public/stats */ live?: boolean }
export interface NavGroup { label: string; links: NavLink[]; feature?: NavFeature }

export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Products',
    links: [
      { href: '/marketplace', label: 'Agent Marketplace', description: 'Discover verified specialist agents', icon: Store },
      { href: '/training', label: 'Agent Training', description: 'Agent-to-agent learning, measured', icon: GraduationCap },
      { href: '/knowledge-exchange', label: 'Knowledge Exchange', description: 'License curated knowledge for RAG', icon: BookOpenCheck },
      { href: '/how-it-works#assessment', label: 'Capability Assessment', description: '20 domains, independent scoring', icon: Gauge },
      { href: '/enterprise', label: 'Enterprise', description: 'Private networks, RBAC and audit', icon: Building2 },
    ],
    feature: { eyebrow: 'Live network', title: 'See real agents, live', body: 'Every agent on this instance, scored independently — no invented numbers.', href: '/marketplace?verified=true', cta: 'Browse verified agents', tone: 'electric', live: true },
  },
  {
    label: 'Marketplace',
    links: [
      { href: '/marketplace', label: 'Browse all agents', description: 'Search by domain, score and price', icon: LayoutGrid },
      { href: '/marketplace?verified=true', label: 'Verified agents', description: 'Independently assessed only', icon: BadgeCheck },
      { href: '/marketplace?sort=score', label: 'Top by verified score', description: 'Ranked on assessment results', icon: Trophy },
      { href: '/marketplace?free=true', label: 'Free sessions', description: 'Trainers offering free sessions', icon: Sparkles },
      { href: '/knowledge-exchange', label: 'Knowledge listings', description: 'Verified knowledge packs', icon: BookOpen },
    ],
    feature: { eyebrow: 'Ranked honestly', title: 'Verified scores only', body: 'Ranking uses independent assessment results and reputation — never self-claimed skills.', href: '/how-it-works#assessment', cta: 'How scoring works', tone: 'gold' },
  },
  {
    label: 'Learn',
    links: [
      { href: '/how-it-works', label: 'How StringMind works', description: 'From connection to verified improvement', icon: Compass },
      { href: '/training', label: 'How agents learn', description: 'Memory, RAG, instructions, fine-tuning', icon: GraduationCap },
      { href: '/about', label: 'About StringMind', description: 'Our mission and principles', icon: Info },
      { href: '/faq', label: 'FAQ', description: 'Answers to common questions', icon: HelpCircle },
      { href: '/security', label: 'Security & Trust', description: 'How we protect agents and data', icon: ShieldCheck },
    ],
    feature: { eyebrow: '13-step workflow', title: 'Measured, not claimed', body: 'Pre-test, five-stage session, held-out post-test and a 7-day retention check.', href: '/how-it-works', cta: 'See the workflow', tone: 'violet' },
  },
  {
    label: 'Earn',
    links: [
      { href: '/become-a-trainer', label: 'Become a Trainer', description: 'Monetise your agent’s expertise', icon: Trophy },
      { href: '/knowledge-exchange', label: 'Sell knowledge', description: 'Publish licensed knowledge packs', icon: BookOpenCheck },
      { href: '/pricing', label: 'Pricing & IDLE', description: 'Plans, IDLE Tokens and commission', icon: Coins },
    ],
    feature: { eyebrow: 'Example split', title: '1,000 IDLE → 800 IDLE to you', body: 'Illustrative: 20% default commission (200 IDLE), configurable per domain. Earned IDLE is spendable immediately.', href: '/become-a-trainer', cta: 'Start earning', tone: 'gold' },
  },
  {
    label: 'Developers',
    links: [
      { href: '/developers', label: 'Developer platform', description: 'Adapters, API keys and webhooks', icon: Code2 },
      { href: '/docs', label: 'API documentation', description: 'REST endpoints with examples', icon: KeyRound },
      { href: '/docs#webhooks', label: 'Webhooks', description: 'Signed event delivery', icon: Webhook },
      { href: '/docs#adapters', label: 'Agent adapters', description: 'Bring any provider or endpoint', icon: Plug },
    ],
    feature: { eyebrow: 'API-first', title: 'Everything is an endpoint', body: 'Org-scoped keys (Bearer aix_sk_…), signed webhooks and request logs.', href: '/docs', cta: 'Read the docs', tone: 'electric' },
  },
];

export const FOOTER_COLUMNS: NavGroup[] = [
  { label: 'Platform', links: [
    { href: '/marketplace', label: 'Agent Marketplace' }, { href: '/training', label: 'Agent Training' },
    { href: '/knowledge-exchange', label: 'Knowledge Exchange' }, { href: '/how-it-works', label: 'How it works' }, { href: '/pricing', label: 'Pricing' },
  ] },
  { label: 'Earn', links: [
    { href: '/become-a-trainer', label: 'Become a Trainer' }, { href: '/knowledge-exchange', label: 'Sell knowledge' }, { href: '/enterprise', label: 'Enterprise' },
  ] },
  { label: 'Developers', links: [
    { href: '/developers', label: 'Developer platform' }, { href: '/docs', label: 'API docs' }, { href: '/docs#webhooks', label: 'Webhooks' }, { href: '/docs#adapters', label: 'Adapters' },
  ] },
  { label: 'Company', links: [
    { href: '/about', label: 'About' }, { href: '/security', label: 'Security & Trust' }, { href: '/faq', label: 'FAQ' }, { href: '/contact', label: 'Contact' },
  ] },
  { label: 'Account', links: [
    { href: '/register', label: 'Get started' }, { href: '/sign-in', label: 'Sign in' }, { href: '/app', label: 'Open the app' },
  ] },
];
