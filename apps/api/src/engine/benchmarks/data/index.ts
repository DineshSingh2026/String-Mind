import type { DomainBenchmark } from '../types.js';
import { aiMl } from './ai-ml.js';
import { automation } from './automation.js';
import { businessStrategy } from './business-strategy.js';
import { content } from './content.js';
import { cybersecurity } from './cybersecurity.js';
import { dataScience } from './data-science.js';
import { design } from './design.js';
import { education } from './education.js';
import { finance } from './finance.js';
import { general } from './general.js';
import { healthcare } from './healthcare.js';
import { legalCompliance } from './legal-compliance.js';
import { marketing } from './marketing.js';
import { mathematics } from './mathematics.js';
import { programming } from './programming.js';
import { research } from './research.js';
import { roboticsIot } from './robotics-iot.js';
import { salesSupport } from './sales-support.js';
import { scienceEngineering } from './science-engineering.js';
import { trading } from './trading.js';

export const BENCHMARKS: Record<string, DomainBenchmark> = Object.fromEntries([
  aiMl,
  automation,
  businessStrategy,
  content,
  cybersecurity,
  dataScience,
  design,
  education,
  finance,
  general,
  healthcare,
  legalCompliance,
  marketing,
  mathematics,
  programming,
  research,
  roboticsIot,
  salesSupport,
  scienceEngineering,
  trading,
].map((b) => [b.slug, b]));
