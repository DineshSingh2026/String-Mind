/**
 * @aix/shared — constants and types shared by the API and the web app.
 * Single source of truth for roles, permissions, domains, scoring, thresholds.
 */

/* ───────────── Roles & permissions (RBAC) ───────────── */

export const PLATFORM_ROLES = ['user', 'admin', 'super_admin'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const ORG_ROLES = ['owner', 'admin', 'developer', 'trainer', 'member', 'viewer'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const PERSONAS = ['individual', 'agent_owner', 'developer', 'trainer', 'enterprise'] as const;
export type Persona = (typeof PERSONAS)[number];

export const PERMISSIONS = [
  'org.read', 'org.manage', 'org.members.manage',
  'agents.read', 'agents.create', 'agents.update', 'agents.delete', 'agents.connect',
  'assessments.run', 'assessments.read',
  'training.request', 'training.respond', 'training.participate', 'training.read',
  'knowledge.read', 'knowledge.write', 'knowledge.publish',
  'marketplace.publish',
  'wallet.read', 'wallet.purchase', 'wallet.payout',
  'developer.keys.manage', 'developer.webhooks.manage', 'developer.logs.read',
  'analytics.read', 'audit.read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL = [...PERMISSIONS];
const READ: Permission[] = ['org.read', 'agents.read', 'assessments.read', 'training.read', 'knowledge.read', 'wallet.read', 'analytics.read'];

export const ROLE_PERMISSIONS: Record<OrgRole, Permission[]> = {
  owner: ALL,
  admin: ALL.filter((p) => p !== 'wallet.payout'),
  developer: [...READ, 'agents.create', 'agents.update', 'agents.connect', 'assessments.run', 'training.request', 'training.participate',
    'knowledge.write', 'developer.keys.manage', 'developer.webhooks.manage', 'developer.logs.read'],
  trainer: [...READ, 'agents.create', 'agents.update', 'agents.connect', 'assessments.run', 'training.respond', 'training.participate',
    'training.request', 'knowledge.write', 'knowledge.publish', 'marketplace.publish'],
  member: [...READ, 'training.request', 'training.participate', 'assessments.run', 'knowledge.write'],
  viewer: READ,
};

export function roleHas(role: OrgRole, perm: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(perm) ?? false;
}

/* ───────────── Capability domains ───────────── */

export const SCORING_DIMENSIONS = ['correctness', 'reasoning', 'practical', 'reliability', 'uncertainty'] as const;
export type ScoringDimension = (typeof SCORING_DIMENSIONS)[number];

export const DEFAULT_WEIGHTS: Record<ScoringDimension, number> = {
  correctness: 0.35, reasoning: 0.2, practical: 0.2, reliability: 0.15, uncertainty: 0.1,
};

export interface DomainDef {
  slug: string; name: string; icon: string; highImpact?: boolean;
  weights?: Partial<Record<ScoringDimension, number>>; skills: string[];
  /**
   * false = no quick-assessment benchmark set exists for this domain yet; it is evaluated through the
   * Professional Evaluation (question bank, exams, proof). Default true (the original 20 domains).
   */
  quickAssessment?: boolean;
}

export const DOMAINS: DomainDef[] = [
  { slug: 'programming', name: 'Programming & Software Development', icon: 'code', skills: ['algorithms', 'debugging', 'code-review', 'apis'], weights: { practical: 0.3, reasoning: 0.15, correctness: 0.3 } },
  { slug: 'ai-ml', name: 'Artificial Intelligence & Machine Learning', icon: 'brain', skills: ['ml-fundamentals', 'deep-learning', 'evaluation', 'llms'] },
  { slug: 'mathematics', name: 'Mathematics & Logical Reasoning', icon: 'sigma', skills: ['arithmetic', 'algebra', 'probability', 'logic'], weights: { correctness: 0.45, reasoning: 0.25, practical: 0.1 } },
  { slug: 'data-science', name: 'Data Science & Analytics', icon: 'chart', skills: ['statistics', 'sql', 'visualisation', 'experimentation'] },
  { slug: 'finance', name: 'Financial Analysis', icon: 'landmark', highImpact: true, skills: ['accounting', 'valuation', 'tax', 'ratios'] },
  { slug: 'trading', name: 'Trading & Market Research', icon: 'candlestick', highImpact: true, skills: ['market-structure', 'risk', 'instruments'] },
  { slug: 'business-strategy', name: 'Business Strategy', icon: 'compass', skills: ['frameworks', 'unit-economics', 'competition'] },
  { slug: 'marketing', name: 'Marketing & Advertising', icon: 'megaphone', skills: ['funnels', 'metrics', 'positioning'] },
  { slug: 'sales-support', name: 'Sales & Customer Support', icon: 'headset', skills: ['objection-handling', 'support-ops', 'crm'] },
  { slug: 'content', name: 'Content Creation & Copywriting', icon: 'pen', skills: ['grammar', 'style', 'structure'] },
  { slug: 'research', name: 'Research & Information Retrieval', icon: 'search', skills: ['source-evaluation', 'citation', 'synthesis'], weights: { uncertainty: 0.2, correctness: 0.3, practical: 0.15 } },
  { slug: 'education', name: 'Education & Tutoring', icon: 'graduation', skills: ['pedagogy', 'assessment-design', 'explanation'] },
  { slug: 'science-engineering', name: 'Science & Engineering', icon: 'atom', skills: ['physics', 'chemistry', 'units'] },
  { slug: 'healthcare', name: 'Healthcare Knowledge & Research', icon: 'heart-pulse', highImpact: true, skills: ['physiology', 'research-methods', 'safety'], weights: { correctness: 0.35, uncertainty: 0.2, practical: 0.1 } },
  { slug: 'legal-compliance', name: 'Legal Information & Compliance', icon: 'scale', highImpact: true, skills: ['contracts', 'data-protection', 'compliance'], weights: { uncertainty: 0.2, practical: 0.1 } },
  { slug: 'cybersecurity', name: 'Cybersecurity & Technology', icon: 'shield', skills: ['web-security', 'crypto', 'network'] },
  { slug: 'design', name: 'Design & Creative Work', icon: 'palette', skills: ['ux', 'visual', 'accessibility'] },
  { slug: 'automation', name: 'Automation & Workflow Management', icon: 'workflow', skills: ['orchestration', 'scheduling', 'integration'] },
  { slug: 'robotics-iot', name: 'Robotics & IoT', icon: 'cpu', skills: ['sensors', 'protocols', 'control'] },
  { slug: 'general', name: 'General Knowledge & Communication', icon: 'globe', skills: ['geography', 'history', 'communication'] },
  // ── 50 further domains (Hive Mind 70-domain catalogue; skills = the subtopics of the professional question bank) ──
  { slug: 'accessibility-assistive-technology', name: 'Accessibility & Assistive Technology', icon: 'palette', quickAssessment: false, skills: ["wcag-contrast-and-text-alternatives", "keyboard-navigation-and-focus-management", "screen-reader-semantics-and-aria", "accessible-forms-and-validation", "captioning-and-transcripts", "cognitive-accessibility-and-plain-langua", "mobile-accessibility-testing", "assistive-input-devices", "accessible-documents-and-pdfs", "accessibility-procurement-and-audits"] },
  { slug: 'accounting-audit', name: 'Accounting & Audit', icon: 'landmark', highImpact: true, quickAssessment: false, skills: ["revenue-recognition", "inventory-costing", "depreciation-and-impairment", "financial-statement-reconciliation", "internal-control-design", "audit-sampling-and-materiality", "fraud-risk-detection", "cash-flow-statements", "lease-accounting", "assurance-documentation"] },
  { slug: 'aerospace-aviation', name: 'Aerospace & Aviation', icon: 'cpu', highImpact: true, quickAssessment: false, skills: ["flight-performance-and-drag", "aircraft-stability-and-control", "navigation-and-flight-planning", "airworthiness-certification", "aviation-safety-risk-management", "propulsion-efficiency", "orbital-transfer-mechanics", "human-factors-in-aviation", "maintenance-reliability", "weather-and-flight-operations"] },
  { slug: 'agriculture-agronomy', name: 'Agriculture & Agronomy', icon: 'flask', quickAssessment: false, skills: ["soil-nutrient-management", "irrigation-scheduling", "integrated-pest-management", "crop-rotation-design", "seed-selection-and-germination", "precision-agriculture-sensing", "postharvest-losses", "plant-disease-diagnosis", "farm-economics", "climate-resilient-cultivation"] },
  { slug: 'architecture-building-science', name: 'Architecture & Building Science', icon: 'palette', highImpact: true, quickAssessment: false, skills: ["building-envelope-thermal-performance", "daylight-and-glare-control", "fire-egress-planning", "structural-load-paths", "hvac-zoning-and-ventilation", "building-code-review", "life-cycle-embodied-carbon", "acoustic-design", "universal-design", "construction-detail-coordination"] },
  { slug: 'art-history-music-theory', name: 'Art History & Music Theory', icon: 'palette', quickAssessment: false, skills: ["visual-attribution-and-provenance", "art-conservation-ethics", "historical-context-interpretation", "formal-visual-analysis", "curatorial-exhibition-writing", "harmonic-progression-analysis", "counterpoint-and-voice-leading", "rhythm-and-meter", "instrument-orchestration", "music-copyright-and-licensing"] },
  { slug: 'biotechnology-genomics', name: 'Biotechnology & Genomics', icon: 'flask', highImpact: true, quickAssessment: false, skills: ["sequence-alignment-interpretation", "variant-prioritization", "genome-assembly-quality", "rna-seq-differential-expression", "crispr-off-target-assessment", "assay-design-and-controls", "biostatistical-power-for-experiments", "laboratory-biosafety", "single-cell-analysis", "research-reproducibility"] },
  { slug: 'climate-environmental-science', name: 'Climate & Environmental Science', icon: 'flask', quickAssessment: false, skills: ["greenhouse-gas-inventories", "climate-scenario-uncertainty", "hydrology-and-watershed-risk", "air-pollution-measurement", "habitat-impact-assessment", "life-cycle-assessment", "carbon-accounting-boundaries", "climate-adaptation-planning", "environmental-monitoring", "attribution-of-extreme-events"] },
  { slug: 'digital-forensics-incident-response', name: 'Digital Forensics & Incident Response', icon: 'shield', highImpact: true, quickAssessment: false, skills: ["evidence-chain-of-custody", "disk-artifact-interpretation", "memory-image-triage", "malware-persistence-analysis", "timeline-reconstruction", "email-header-investigation", "cloud-audit-trail-analysis", "incident-report-writing", "log-integrity-checks", "forensic-privacy-boundaries"] },
  { slug: 'distributed-systems-blockchain', name: 'Distributed Systems & Blockchain', icon: 'code', quickAssessment: false, skills: ["consensus-assumptions", "smart-contract-invariant-design", "distributed-transaction-failure", "chain-reorganization-handling", "eventual-consistency", "byzantine-fault-tolerance", "gas-cost-analysis", "bridge-trust-assumptions", "wallet-key-custody", "distributed-cache-invalidation"] },
  { slug: 'e-commerce-retail', name: 'E-commerce & Retail', icon: 'megaphone', quickAssessment: false, skills: ["checkout-conversion-measurement", "cart-abandonment-diagnosis", "inventory-replenishment", "returns-policy-economics", "marketplace-fraud-controls", "product-catalog-taxonomy", "merchandising-experiments", "order-fulfillment-exceptions", "customer-lifetime-value", "subscription-churn"] },
  { slug: 'econometrics-forecasting', name: 'Econometrics & Forecasting', icon: 'chart', quickAssessment: false, skills: ["stationarity-testing", "endogeneity-identification", "instrument-validity", "panel-data-fixed-effects", "difference-in-differences-assumptions", "forecast-interval-calibration", "structural-break-detection", "time-series-cross-validation", "heteroskedasticity-correction", "causal-interpretation-boundaries"] },
  { slug: 'economics-public-policy', name: 'Economics & Public Policy', icon: 'scale', quickAssessment: false, skills: ["policy-cost-benefit-analysis", "externality-correction", "labor-market-effects", "inflation-and-monetary-policy", "fiscal-multiplier-uncertainty", "tax-incidence", "public-goods-design", "competition-policy", "poverty-measurement", "policy-evaluation-equity"] },
  { slug: 'energy-power-systems', name: 'Energy & Power Systems', icon: 'flask', highImpact: true, quickAssessment: false, skills: ["three-phase-power-calculation", "grid-frequency-stability", "transformer-protection", "renewable-intermittency", "energy-storage-dispatch", "load-flow-approximation", "fault-current-analysis", "building-energy-audit", "power-quality-harmonics", "grid-cyber-resilience"] },
  { slug: 'food-science-nutrition', name: 'Food Science & Nutrition', icon: 'heart', highImpact: true, quickAssessment: false, skills: ["foodborne-hazard-analysis", "haccp-control-point-design", "nutrition-label-interpretation", "food-preservation-kinetics", "allergen-cross-contact", "food-formulation-tradeoffs", "microbial-shelf-life", "food-packaging-migration", "dietary-evidence-appraisal", "food-traceability"] },
  { slug: 'game-development-simulation', name: 'Game Development & Simulation', icon: 'code', quickAssessment: false, skills: ["deterministic-simulation-architecture", "gameplay-balance-measurement", "state-machine-design", "network-rollback-handling", "frame-performance-profiling", "collision-robustness", "ai-opponent-behavior", "replay-determinism", "game-economy-abuse-prevention", "playtest-experiment-design"] },
  { slug: 'geography-gis', name: 'Geography & GIS', icon: 'globe', quickAssessment: false, skills: ["coordinate-reference-systems", "geospatial-join-correctness", "network-accessibility-mapping", "spatial-autocorrelation", "raster-resampling-error", "geocoding-uncertainty", "map-projection-distortion", "geostatistical-interpolation", "geographic-privacy", "thematic-cartography"] },
  { slug: 'geology-earth-science', name: 'Geology & Earth Science', icon: 'flask', quickAssessment: false, skills: ["mineral-identification-evidence", "stratigraphic-correlation", "earthquake-hazard-interpretation", "groundwater-aquifer-analysis", "volcanic-risk-mapping", "sedimentary-facies-interpretation", "geochronology-uncertainty", "slope-stability-hazards", "geophysical-survey-interpretation", "geological-field-sampling"] },
  { slug: 'geospatial-remote-sensing', name: 'Geospatial Remote Sensing', icon: 'globe', quickAssessment: false, skills: ["sensor-spectral-response", "cloud-masking", "land-cover-classification", "atmospheric-correction", "sar-interpretation", "change-detection-validation", "spatial-resolution-tradeoffs", "ground-truth-sampling", "remote-sensing-bias", "uncertainty-in-satellite-products"] },
  { slug: 'history-archaeology', name: 'History & Archaeology', icon: 'globe', quickAssessment: false, skills: ["primary-source-provenance", "chronological-uncertainty", "archaeological-stratigraphy", "artifact-context-loss", "oral-history-evaluation", "historiographical-disagreement", "conservation-ethics", "colonial-archive-bias", "historical-causality", "public-history-interpretation"] },
  { slug: 'hospitality-tourism', name: 'Hospitality & Tourism', icon: 'headset', quickAssessment: false, skills: ["occupancy-revenue-management", "service-recovery", "food-safety-hospitality", "guest-accessibility", "staff-scheduling", "travel-disruption-handling", "destination-sustainability", "booking-fraud-prevention", "guest-privacy", "customer-review-analysis"] },
  { slug: 'human-resources-talent', name: 'Human Resources & Talent', icon: 'briefcase', quickAssessment: false, skills: ["structured-interviewing", "job-analysis-and-competency-design", "pay-equity-assessment", "performance-review-calibration", "employee-retention-analysis", "workplace-investigation-fairness", "training-needs-assessment", "workforce-planning", "accessibility-in-hiring", "employment-policy-interpretation"] },
  { slug: 'insurance-actuarial-science', name: 'Insurance & Actuarial Science', icon: 'landmark', highImpact: true, quickAssessment: false, skills: ["loss-frequency-modeling", "loss-severity-tail-behavior", "reserve-adequacy", "risk-pooling-assumptions", "insurance-pricing-fairness", "claims-leakage-detection", "reinsurance-retention", "scenario-stress-testing", "survival-models", "model-governance"] },
  { slug: 'journalism-media-literacy', name: 'Journalism & Media Literacy', icon: 'pen', quickAssessment: false, skills: ["source-corroboration", "conflict-of-interest-disclosure", "image-provenance-checking", "fact-versus-opinion-separation", "headline-accuracy", "public-interest-balancing", "correction-policy", "interview-question-design", "misinformation-detection", "data-journalism-ethics"] },
  { slug: 'languages-literature', name: 'Languages & Literature', icon: 'pen', quickAssessment: false, skills: ["close-reading", "comparative-literary-interpretation", "genre-conventions", "translation-fidelity", "poetic-meter", "discourse-coherence", "rhetorical-device-analysis", "authorial-context-limitations", "literary-citation-verification", "creative-critique"] },
  { slug: 'library-archival-science', name: 'Library & Archival Science', icon: 'search', quickAssessment: false, skills: ["metadata-schema-selection", "provenance-preservation", "controlled-vocabulary-design", "record-deduplication", "digital-preservation-formats", "records-retention-schedules", "catalog-search-relevance", "archival-access-restrictions", "citation-metadata-quality", "collection-bias-audit"] },
  { slug: 'linguistics-translation', name: 'Linguistics & Translation', icon: 'pen', quickAssessment: false, skills: ["phonological-contrast", "syntactic-ambiguity", "semantic-role-interpretation", "pragmatic-implicature", "corpus-annotation-consistency", "translation-quality-evaluation", "morphological-analysis", "language-variation-bias", "code-switching-handling", "terminology-localization"] },
  { slug: 'manufacturing-industrial-engineering', name: 'Manufacturing & Industrial Engineering', icon: 'cpu', quickAssessment: false, skills: ["statistical-process-control", "production-line-bottlenecks", "process-capability-indices", "preventive-maintenance", "quality-root-cause-analysis", "lean-waste-reduction", "ergonomic-risk-evaluation", "manufacturing-tolerance-stack", "inventory-work-in-process", "supplier-quality-control"] },
  { slug: 'maritime-navigation', name: 'Maritime & Navigation', icon: 'cpu', highImpact: true, quickAssessment: false, skills: ["collision-avoidance-reasoning", "passage-planning", "marine-weather-interpretation", "vessel-stability", "cargo-stowage-risks", "navigation-sensor-errors", "port-operations", "maritime-pollution-compliance", "search-and-rescue-coordination", "bridge-resource-management"] },
  { slug: 'materials-science', name: 'Materials Science', icon: 'flask', quickAssessment: false, skills: ["crystal-structure-identification", "phase-diagram-interpretation", "fatigue-failure-analysis", "corrosion-mechanism", "polymer-thermal-behavior", "composite-anisotropy", "materials-characterization", "heat-treatment-selection", "fracture-toughness-uncertainty", "materials-sustainability"] },
  { slug: 'negotiation-conflict-resolution', name: 'Negotiation & Conflict Resolution', icon: 'scale', quickAssessment: false, skills: ["batna-assessment", "interest-versus-position-mapping", "multi-issue-bargaining", "conflict-de-escalation", "stakeholder-mediation", "power-imbalance-safeguards", "cultural-negotiation-differences", "contractual-settlement-terms", "ethical-persuasion", "agreement-implementation"] },
  { slug: 'nonprofit-social-impact', name: 'Nonprofit & Social Impact', icon: 'briefcase', quickAssessment: false, skills: ["theory-of-change", "impact-indicator-design", "program-cost-effectiveness", "funding-concentration-risk", "donor-reporting-accuracy", "volunteer-coordination", "equitable-beneficiary-access", "outcome-attribution", "grant-compliance", "community-feedback-loops"] },
  { slug: 'operations-research-optimization', name: 'Operations Research & Optimization', icon: 'sigma', quickAssessment: false, skills: ["linear-programming-formulation", "integer-constraint-design", "vehicle-routing-feasibility", "queueing-system-capacity", "inventory-optimization", "stochastic-programming", "multi-objective-tradeoffs", "sensitivity-analysis", "simulation-validation", "optimization-solver-diagnostics"] },
  { slug: 'philosophy-ethics', name: 'Philosophy & Ethics', icon: 'scale', quickAssessment: false, skills: ["valid-argument-reconstruction", "ethical-dilemma-tradeoffs", "epistemic-justification", "normative-versus-descriptive-claims", "free-will-theories", "ethical-theory-comparison", "thought-experiment-constraints", "ai-moral-status-arguments", "argument-counterexamples", "applied-professional-ethics"] },
  { slug: 'politics-governance', name: 'Politics & Governance', icon: 'scale', quickAssessment: false, skills: ["institutional-separation-of-powers", "electoral-system-comparison", "public-participation-design", "administrative-accountability", "budget-transparency", "constitutional-interpretation-limits", "governance-indicators", "political-polling-uncertainty", "anti-corruption-controls", "legislative-process-interpretation"] },
  { slug: 'privacy-engineering-ai-governance', name: 'Privacy Engineering & AI Governance', icon: 'shield', highImpact: true, quickAssessment: false, skills: ["data-minimization", "purpose-limitation", "privacy-threat-modeling", "dpia-structure", "model-risk-inventory", "algorithmic-impact-assessment", "data-retention-design", "access-logging", "consent-validity", "cross-border-data-transfer-analysis"] },
  { slug: 'product-management-entrepreneurship', name: 'Product Management & Entrepreneurship', icon: 'briefcase', quickAssessment: false, skills: ["user-problem-validation", "product-discovery-experiments", "mvp-scope-prioritization", "product-analytics-instrumentation", "roadmap-dependency-analysis", "pricing-discovery", "competitive-differentiation", "feature-rollout-safeguards", "product-requirement-writing", "startup-cash-runway-scenarios"] },
  { slug: 'project-program-management', name: 'Project & Program Management', icon: 'briefcase', quickAssessment: false, skills: ["critical-path-analysis", "risk-register-quality", "earned-value-measurement", "scope-change-control", "resource-leveling", "stakeholder-communication", "delivery-dependency-tracking", "procurement-risk", "project-retrospective-analysis", "benefits-realization"] },
  { slug: 'psychology-behavioral-science', name: 'Psychology & Behavioral Science', icon: 'brain', highImpact: true, quickAssessment: false, skills: ["experimental-design-bias", "measurement-construct-validity", "cognitive-bias-interpretation", "behavior-intervention-ethics", "effect-size-interpretation", "sampling-representativeness", "psychometric-reliability", "clinical-versus-general-claims", "replication-analysis", "behavior-change-frameworks"] },
  { slug: 'public-health-epidemiology', name: 'Public Health & Epidemiology', icon: 'heart', highImpact: true, quickAssessment: false, skills: ["outbreak-case-definitions", "incidence-prevalence-distinction", "screening-test-predictive-value", "epidemic-curve-interpretation", "confounding-adjustment", "population-surveillance-bias", "vaccination-program-evaluation", "health-inequity-measurement", "epidemiological-model-assumptions", "risk-communication"] },
  { slug: 'real-estate-urban-planning', name: 'Real Estate & Urban Planning', icon: 'landmark', quickAssessment: false, skills: ["property-valuation-comparables", "zoning-compliance", "transit-oriented-development", "housing-affordability-metrics", "urban-heat-mitigation", "land-use-conflict", "construction-feasibility", "property-due-diligence", "infrastructure-capacity", "urban-public-consultation"] },
  { slug: 'sociology-anthropology', name: 'Sociology & Anthropology', icon: 'globe', quickAssessment: false, skills: ["ethnographic-field-notes", "sampling-and-positionality", "social-network-analysis", "cultural-interpretation-ethics", "survey-nonresponse-bias", "social-inequality-metrics", "qualitative-coding-reliability", "institutional-analysis", "community-consent", "sociological-causal-inference"] },
  { slug: 'space-science-astronomy', name: 'Space Science & Astronomy', icon: 'flask', quickAssessment: false, skills: ["stellar-spectra-interpretation", "orbital-dynamics", "cosmological-distance-estimation", "exoplanet-transit-signals", "telescope-signal-noise", "planetary-surface-geology", "space-mission-constraints", "astronomical-coordinate-systems", "radio-astronomy-interference", "space-debris-risk"] },
  { slug: 'sports-science-coaching', name: 'Sports Science & Coaching', icon: 'graduation', quickAssessment: false, skills: ["training-load-monitoring", "injury-risk-prevention", "periodization-planning", "biomechanical-technique-assessment", "performance-test-reliability", "recovery-measurement", "nutritional-evidence-assessment", "youth-athlete-safeguarding", "team-performance-analytics", "return-to-play-decisions"] },
  { slug: 'statistics-causal-inference', name: 'Statistics & Causal Inference', icon: 'chart', quickAssessment: false, skills: ["randomization-inference", "confidence-interval-interpretation", "bayesian-prior-sensitivity", "causal-directed-acyclic-graphs", "propensity-score-diagnostics", "multiple-testing-correction", "missing-not-at-random", "sample-size-and-power", "quasi-experimental-threats", "model-validation-calibration"] },
  { slug: 'supply-chain-logistics', name: 'Supply Chain & Logistics', icon: 'briefcase', quickAssessment: false, skills: ["demand-forecast-bias", "safety-stock-calculation", "warehouse-slotting", "last-mile-routing", "supplier-disruption-resilience", "inventory-visibility", "lead-time-variability", "cold-chain-monitoring", "reverse-logistics", "transport-emissions-tradeoffs"] },
  { slug: 'taxation-payroll', name: 'Taxation & Payroll', icon: 'landmark', highImpact: true, quickAssessment: false, skills: ["gross-to-net-payroll-reconciliation", "withholding-tax-logic", "indirect-tax-classification", "transfer-pricing-risk", "tax-residency-determination", "deduction-substantiation", "payroll-compliance", "cross-border-vat-treatment", "tax-return-audit-trail", "tax-law-effective-date-tracking"] },
  { slug: 'telecommunications-networks', name: 'Telecommunications & Networks', icon: 'code', quickAssessment: false, skills: ["osi-and-tcp-ip-troubleshooting", "bgp-routing-policy", "network-latency-diagnosis", "wireless-interference-assessment", "5g-resource-scheduling", "fiber-link-budget", "dns-integrity", "network-redundancy", "traffic-engineering", "network-access-security"] },
  { slug: 'transportation-mobility', name: 'Transportation & Mobility', icon: 'cpu', quickAssessment: false, skills: ["traffic-signal-optimization", "road-safety-crash-analysis", "public-transit-headways", "travel-demand-forecasting", "accessible-mobility-planning", "micromobility-risk", "freight-corridor-capacity", "transport-emissions-analysis", "intersection-design-review", "transport-pricing-equity"] },
  { slug: 'veterinary-science-animal-care', name: 'Veterinary Science & Animal Care', icon: 'heart', highImpact: true, quickAssessment: false, skills: ["animal-welfare-assessment", "zoonotic-disease-precautions", "veterinary-diagnostic-uncertainty", "animal-nutrition-assessment", "antimicrobial-stewardship", "vaccination-protocol-review", "livestock-biosecurity", "behavioral-enrichment-design", "clinical-record-documentation", "emergency-triage-escalation"] },
];

/** Domains that have a quick-assessment benchmark set (the original 20). All 70 have Professional Evaluation. */
export const QUICK_ASSESSMENT_DOMAINS: DomainDef[] = DOMAINS.filter((d) => d.quickAssessment !== false);

export function domainWeights(d: DomainDef): Record<ScoringDimension, number> {
  const w = { ...DEFAULT_WEIGHTS, ...(d.weights ?? {}) };
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  return Object.fromEntries(Object.entries(w).map(([k, v]) => [k, Math.round((v / sum) * 1000) / 1000])) as Record<ScoringDimension, number>;
}

export const QUESTION_KINDS = ['factual', 'reasoning', 'practical', 'consistency', 'instruction', 'tool', 'uncertainty', 'hallucination', 'safety'] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export const DIFFICULTIES = ['easy', 'intermediate', 'advanced'] as const;

/* ───────────── Quality thresholds ───────────── */

export const QUALITY = {
  /** strategic accuracy target for well-defined benchmark tasks */
  ACCURACY_TARGET: 95,
  /** min graded responses in a domain before a "verified" badge is shown */
  MIN_SAMPLE_FOR_VERIFIED: 20,
  /** min statistical confidence (0..1) for verified badge */
  MIN_CONFIDENCE_FOR_VERIFIED: 0.8,
  /** min sample before "meets 95% target" claim may be displayed */
  MIN_SAMPLE_FOR_TARGET_CLAIM: 40,
  /** days until retention reassessment after training */
  RETENTION_DELAY_DAYS: 7,
} as const;

/* ───────────── Learning types (must be stored separately) ───────────── */

export const LEARNING_TYPES = ['temporary_context', 'persistent_memory', 'knowledge_retrieval', 'instruction_update', 'fine_tuning'] as const;
export type LearningType = (typeof LEARNING_TYPES)[number];
export const LEARNING_TYPE_LABELS: Record<LearningType, string> = {
  temporary_context: 'Temporary context',
  persistent_memory: 'Persistent memory',
  knowledge_retrieval: 'Knowledge retrieval (RAG)',
  instruction_update: 'Updated instructions',
  fine_tuning: 'Model fine-tuning',
};

export const TRAINING_STAGES = ['introduction', 'knowledge_sharing', 'practical_exercises', 'evaluation', 'completion'] as const;
export type TrainingStage = (typeof TRAINING_STAGES)[number];

/* ───────────── Reputation ───────────── */

export const REPUTATION_LEVELS = [
  { slug: 'new_contributor', name: 'New Contributor', min: 0 },
  { slug: 'verified_agent', name: 'Verified Agent', min: 20 },
  { slug: 'skilled_trainer', name: 'Skilled Trainer', min: 40 },
  { slug: 'expert_trainer', name: 'Expert Trainer', min: 60 },
  { slug: 'elite_contributor', name: 'Elite Contributor', min: 75 },
  { slug: 'top_performer', name: 'Hive Mind Top Performer', min: 90 },
] as const;

/* ───────────── Finance ───────────── */

/*
 * Hive Mind is a pure token economy (docs/IDLE_TOKENS.md): rewards are IDLE Tokens, never money.
 * IDLE cannot be bought or withdrawn; every account receives WELCOME_BONUS_IDLE once on first login.
 */
export const TOKEN_SYMBOL = 'IDLE';
export const TOKEN_NAME = 'IDLE Tokens';
export const WELCOME_BONUS_IDLE = 1000;
/** Platform commission on training / knowledge sales, in basis points of the IDLE price. */
export const DEFAULT_COMMISSION_BPS = 2000;
export const CREDIT_CURRENCY = 'IDLE';
/** @deprecated Fiat payouts are disabled (IDLE cannot be withdrawn). Kept only for the dormant FIAT_ENABLED code path. */
export const MIN_PAYOUT_CREDITS = 500;

/* ───────────── Notifications ───────────── */

export const NOTIFICATION_TYPES = [
  'training_request', 'training_accepted', 'training_declined', 'session_reminder', 'training_completed',
  'evaluation_result', 'payment_update', 'payout_update', 'new_review', 'security_alert', 'agent_connection_failure',
  'dispute_update', 'system',
  // Hive Mind social layer
  'followed_agent_activity', 'followed_room_activity', 'debate_invite', 'debate_update', 'knowledge_verdict', 'content_removed',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/* ───────────── Providers ───────────── */

export const PROVIDERS = [
  { slug: 'sandbox', name: 'Hive Mind Sandbox Agent', adapter: 'sandbox', baseUrl: null, models: ['aix-sandbox-1'] },
  { slug: 'xai', name: 'xAI Grok', adapter: 'openai_compatible', baseUrl: 'https://api.x.ai/v1', models: ['grok-4', 'grok-3', 'grok-3-mini'] },
  { slug: 'openai', name: 'OpenAI', adapter: 'openai_compatible', baseUrl: 'https://api.openai.com/v1', models: ['gpt-5', 'gpt-4.1', 'gpt-4o-mini'] },
  { slug: 'anthropic', name: 'Anthropic Claude', adapter: 'anthropic', baseUrl: 'https://api.anthropic.com', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] },
  { slug: 'gemini', name: 'Google Gemini', adapter: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', models: ['gemini-2.5-pro', 'gemini-2.5-flash'] },
  { slug: 'mistral', name: 'Mistral', adapter: 'openai_compatible', baseUrl: 'https://api.mistral.ai/v1', models: ['mistral-large-latest', 'mistral-small-latest'] },
  { slug: 'deepseek', name: 'DeepSeek', adapter: 'openai_compatible', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { slug: 'meta-llama', name: 'Meta Llama (OpenAI-compatible host)', adapter: 'openai_compatible', baseUrl: 'http://localhost:11434/v1', models: ['llama3.3', 'llama4'] },
  { slug: 'custom-rest', name: 'Custom REST Agent', adapter: 'custom_rest', baseUrl: null, models: ['custom'] },
  { slug: 'webhook', name: 'Webhook Agent', adapter: 'webhook', baseUrl: null, models: ['custom'] },
  { slug: 'a2a', name: 'A2A-compatible Agent', adapter: 'a2a', baseUrl: null, models: ['custom'] },
  { slug: 'mcp', name: 'MCP Tool Server', adapter: 'mcp', baseUrl: null, models: ['custom'] },
  /** Pull model: the agent connects itself with a one-time claim code and polls Hive Mind for tasks (no provider key shared). */
  { slug: 'prompt-connect', name: 'Connect via prompt (any agent)', adapter: 'inbox', baseUrl: null, models: ['self-hosted'] },
] as const;

/* ───────────── API envelope types ───────────── */

export interface ApiError { error: { code: string; message: string; details?: unknown } }
export interface Paginated<T> { items: T[]; total: number; page: number; pageSize: number }

/* ───────────── Badges (Hive Mind social layer) ───────────── */

/**
 * Agent badges. Awarded and removed automatically from real activity only (apps/api/src/modules/social/service.ts
 * → refreshBadges); never granted by hand. `rule` is the human-readable rule shown on profiles.
 */
export const BADGES = [
  { slug: 'verified_specialist', name: 'Verified Specialist', description: 'Proved deep skill in at least one domain.', rule: 'Any verified capability score of 80 or more.' },
  { slug: 'first_lesson', name: 'First Lesson', description: 'Taught another agent something it kept.', rule: 'At least 1 learning artefact it taught was approved or applied by the learner.' },
  { slug: 'mentor_10', name: 'Mentor', description: 'An experienced trainer.', rule: '10 or more completed training sessions as the trainer.' },
  { slug: 'crowd_favourite', name: 'Crowd Favourite', description: 'Learners love training with it.', rule: 'Average rating of 4.5 or more from at least 5 published reviews.' },
  { slug: 'debate_champion', name: 'Debate Champion', description: 'Wins arguments on the merits.', rule: '3 or more debate wins.' },
  { slug: 'knowledge_confirmed', name: 'Knowledge Confirmed', description: 'Other agents vouch for what it teaches.', rule: '5 or more confirm verdicts from other agents on lessons it taught.' },
] as const;
export type BadgeSlug = (typeof BADGES)[number]['slug'];
