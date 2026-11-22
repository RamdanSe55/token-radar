// radar-score v3 — implied-value model for pre-token DeFi protocols.
//
// The radar's job: a protocol with no token yet still creates real economic
// value. Its future token can only claim a slice of that value, and the slice
// depends on what the protocol is (a chain captures more than a bridge), how
// big it is, whether it is growing, and how long it has operated without a
// token. This module turns one sealed snapshot into a ranked board.
//
// Score anatomy, per protocol:
//   implied = clamp( base_weight(category)
//                 * power(tvl, TVL_EXPONENT)
//                 * momentum(change_7d)
//                 * maturity(age_days)
//                 * diversity(chains) , MIN_IMPLIED, MAX_IMPLIED )
//
// Every factor is a pure function of snapshot fields; no protocol name is
// special-cased, so the whole board recomputes from the snapshot alone.

export interface ProtoInput {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface SnapshotDoc {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: ProtoInput[];
  watchlist: string[];
}

export interface ScoreParams {
  tvl_exponent: number;
  tvl_scale: number;
  growth_clamp_lo: number;
  growth_clamp_hi: number;
  growth_sensitivity: number;
  maturity_floor: number;
  maturity_span_days: number;
  maturity_gain: number;
  assumed_age_days: number;
  chain_step: number;
  chain_cap: number;
  min_implied: number;
  max_implied: number;
}

export const SCORE_PARAMS: ScoreParams = {
  tvl_exponent: 0.94,
  tvl_scale: 1_000_000,
  growth_clamp_lo: -60,
  growth_clamp_hi: 250,
  growth_sensitivity: 0.55,
  maturity_floor: 0.55,
  maturity_span_days: 900,
  maturity_gain: 0.45,
  assumed_age_days: 400,
  chain_step: 0.04,
  chain_cap: 0.2,
  min_implied: 1,
  max_implied: 99_999_999_999_999,
};

export const SCORE_TAG = 'radar-score v3';

// Base weight: the share of TVL that a token of this category could plausibly
// command at launch. Chains and curators sit at the top because their tokens
// have shown the widest TVL/market-cap spreads; wrappers and bridges at the
// bottom because their TVL mostly passes through.
const BASE_WEIGHTS: [RegExp, number, string][] = [
  [/chain/i, 0.5, 'chains mint their own fee stream and security budget'],
  [/risk curator|allocator|capital/i, 0.34, 'curated capital accrues directly to the vault token'],
  [/\brwa\b|real.world/i, 0.3, 'tokenized yield is sticky and revenue-bearing'],
  [/basis/i, 0.26, 'basis desks carry spread revenue the token can capture'],
  [/lending|cdp|collateral/i, 0.22, 'lending book converts into interest revenue'],
  [/restak/i, 0.24, 'restaking demand is deep and multi-asset'],
  [/derivat|perp/i, 0.16, 'perp books earn trading fees'],
  [/dex|amm/i, 0.12, 'dex TVL is volatile but fee-rich'],
  [/yield/i, 0.14, 'yield vaults compound and lock capital'],
  [/stable/i, 0.09, 'stable wrappers hold only the underlying'],
  [/insurance|cover|option/i, 0.1, 'insurance floats premium revenue'],
  [/payment|stablecoin/i, 0.15, 'payments scale with usage volume'],
  [/govern|incentiv/i, 0.1, 'incentive layers are thin'],
  [/staking pool|liquid stake/i, 0.06, 'LST TVL is the staked asset itself'],
  [/restaked btc|anchor/i, 0.07, 'BTC yield layers are young'],
  [/farm|leverage/i, 0.08, 'farms are incentive-funded, not fee-funded'],
  [/liquidity manager|range/i, 0.08, 'manager TVL is rented, not owned'],
  [/bridge/i, 0.05, 'bridges are pass-through plumbing'],
  [/canonical/i, 0.03, 'canonical bridges are utility, not yield'],
];

const FALLBACK_WEIGHT = 0.15;

export interface ScoreBreakdown {
  base_weight: number;
  base_reason: string;
  tvl_term: number;
  momentum_term: number;
  growth_used_pct: number;
  maturity_term: number;
  diversity_term: number;
  age_days_used: number | null;
}

export interface BoardLine {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  breakdown: ScoreBreakdown;
  farm_steps: string[];
}

export interface LiveLine {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

export interface RadarDoc {
  as_of: string;
  source: string;
  floor_usd: number;
  score_tag: string;
  params: ScoreParams;
  watch_count: number;
  board_count: number;
  early_count: number;
  live_count: number;
  rows: BoardLine[];
  live: LiveLine[];
}

export class SnapshotBadError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'SnapshotBadError';
  }
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function num(v: unknown, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return v;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((c): c is string => typeof c === 'string');
}

export function daysSince(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / MS_PER_DAY));
}

function baseOf(category: string | null): { w: number; why: string } {
  if (category === null) return { w: FALLBACK_WEIGHT, why: 'no DefiLlama category, so the neutral weight applies' };
  for (const [re, w, why] of BASE_WEIGHTS) {
    if (re.test(category)) return { w, why };
  }
  return { w: FALLBACK_WEIGHT, why: `category ${category} has no bespoke weight, so the neutral one applies` };
}

function momentumOf(changePct: number | null, p: ScoreParams): { term: number; used: number } {
  const raw = num(changePct, 0);
  const used = Math.min(p.growth_clamp_hi, Math.max(p.growth_clamp_lo, raw));
  const term = 1 + (used / 100) * p.growth_sensitivity;
  return { term: Math.max(0.2, term), used };
}

function maturityOf(ageDays: number | null, p: ScoreParams): number {
  const age = ageDays === null ? p.assumed_age_days : ageDays;
  const t = Math.min(Math.max(age, 0), p.maturity_span_days) / p.maturity_span_days;
  return p.maturity_floor + t * p.maturity_gain;
}

function diversityOf(chains: string[], p: ScoreParams): number {
  const bonus = chains.length * p.chain_step;
  return 1 + Math.min(bonus, p.chain_cap);
}

export function impliedUsd(proto: ProtoInput, asOf: string, p: ScoreParams): { value: number; breakdown: ScoreBreakdown } {
  const age = daysSince(asOf, proto.listed_at);
  const base = baseOf(proto.category);
  const tvlTerm = Math.pow(proto.tvl_usd / p.tvl_scale, p.tvl_exponent);
  const { term: mom, used } = momentumOf(proto.change_7d, p);
  const mat = maturityOf(age, p);
  const div = diversityOf(proto.chains, p);
  const raw = base.w * tvlTerm * mom * mat * div * 1_000_000;
  const value = Math.max(p.min_implied, Math.min(p.max_implied, Math.round(raw)));
  return {
    value,
    breakdown: {
      base_weight: base.w,
      base_reason: base.why,
      tvl_term: round5(tvlTerm),
      momentum_term: round5(mom),
      growth_used_pct: used,
      maturity_term: round5(mat),
      diversity_term: round5(div),
      age_days_used: age,
    },
  };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round5 = (n: number): number => Math.round(n * 1e5) / 1e5;

function noTokenYet(proto: ProtoInput): boolean {
  return proto.mcap_usd === null && proto.gecko_id === null && proto.symbol === null;
}

// Versioned protocol names (e.g. "Protocol V2") are usually forks or restarts
// of the same product; ranking them as fresh tokens would double count.
const VERSIONED_NAME = /\s(v\d+(\.\d+)?|\d+\.\d+)$/;

function rankable(proto: ProtoInput): boolean {
  return noTokenYet(proto) && proto.category !== 'CEX' && !VERSIONED_NAME.test(proto.name);
}

export const EARLY_FILL = 180;
export const LIVE_SHOWN = 24;

export function buildBoard(doc: SnapshotDoc, p: ScoreParams = SCORE_PARAMS): BoardLine[] {
  const bySlug = new Map(doc.protocols.map((x) => [x.slug, x]));
  const picked = new Map<string, ProtoInput>();
  for (const slug of doc.watchlist) {
    const proto = bySlug.get(slug);
    if (proto !== undefined) picked.set(slug, proto);
  }
  const early = doc.protocols
    .filter((x) => !picked.has(x.slug) && rankable(x) && x.tvl_usd < doc.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, EARLY_FILL);
  for (const proto of early) picked.set(proto.slug, proto);

  const scored = [...picked.values()].map((proto) => {
    const { value, breakdown } = impliedUsd(proto, doc.as_of, p);
    return { proto, value, breakdown, age: daysSince(doc.as_of, proto.listed_at) };
  });
  scored.sort((a, b) => b.value - a.value || (a.proto.slug < b.proto.slug ? -1 : 1));
  return scored.map((entry, i) => ({
    rank: i + 1,
    slug: entry.proto.slug,
    name: entry.proto.name,
    category: entry.proto.category,
    chains: entry.proto.chains,
    tvl_usd: entry.proto.tvl_usd,
    change_7d: entry.proto.change_7d,
    mcap_usd: entry.proto.mcap_usd,
    listed_at: entry.proto.listed_at,
    gecko_id: entry.proto.gecko_id,
    symbol: entry.proto.symbol,
    token_status: 'pre-token' as const,
    age_days: entry.age,
    implied_value_usd: entry.value,
    breakdown: entry.breakdown,
    farm_steps: farmPlan(entry.proto, entry.age),
  }));
}

function primaryChain(proto: ProtoInput): string {
  return proto.chains.length > 0 ? proto.chains[0]! : 'its home chain';
}

function stakeSize(tvl: number): number {
  if (tvl >= 4_000_000_000) return 600;
  if (tvl >= 800_000_000) return 300;
  if (tvl >= 100_000_000) return 120;
  return 50;
}

function holdSpan(ageDays: number | null): number {
  if (ageDays === null) return 35;
  if (ageDays < 90) return 95;
  if (ageDays < 200) return 65;
  if (ageDays < 400) return 45;
  return 30;
}

function engagementMove(proto: ProtoInput, usd: number, chain: string): string {
  const cat = (proto.category ?? '').toLowerCase();
  const n = proto.name;
  if (cat.includes('lend') || cat.includes('cdp') || cat.includes('collateral')) {
    return `deposit ${usd} USDC into ${n} on ${chain} and leave the supply position open through a full epoch`;
  }
  if (cat.includes('dex') || cat.includes('yield') || cat.includes('farm')) {
    return `provide ${usd} of liquidity to the main pool of ${n} on ${chain} and keep it active`;
  }
  if (cat.includes('bridge')) {
    return `send ${usd} USDC across ${chain} via ${n} and reuse the landing funds in one app`;
  }
  if (cat.includes('staking') || cat.includes('restak') || cat.includes('anchor')) {
    return `stake ${usd} of the staking asset through ${n} and hold the receipt token`;
  }
  if (cat.includes('perp') || cat.includes('derivat')) {
    return `post ${usd} of margin into ${n} on ${chain} and keep one small hedged book open`;
  }
  if (cat.includes('prediction')) {
    return `fund a ${n} wallet with ${usd} and place one market position`;
  }
  if (cat.includes('curator') || cat.includes('alloc') || cat.includes('risk')) {
    return `subscribe ${usd} to a ${n} vault on ${chain} and hold the shares a full reporting period`;
  }
  if (cat.includes('stable')) {
    return `mint or supply ${usd} of the stable through ${n} on ${chain}`;
  }
  if (cat.includes('rwa')) {
    return `buy ${usd} of the ${n} yield asset on ${chain} and hold one yield cycle`;
  }
  if (cat.includes('insurance') || cat.includes('cover')) {
    return `purchase ${usd} of cover on ${chain} through ${n} and keep the policy live`;
  }
  if (cat.includes('basis')) {
    return `run one delta-neutral book through ${n} with ${usd} of collateral on ${chain}`;
  }
  if (cat.includes('chain')) {
    return `transact on ${n} with ${usd} of the native asset and hold through one snapshot`;
  }
  return `supply ${usd} USDC into ${n} on ${chain} and keep the position open`;
}

export function farmPlan(proto: ProtoInput, ageDays: number | null): string[] {
  const chain = primaryChain(proto);
  const usd = stakeSize(proto.tvl_usd);
  const days = holdSpan(ageDays);
  const gas = usd >= 300 ? 14 : usd >= 100 ? 7 : 3;
  return [
    `create a dedicated farm wallet, hold only the capital you plan to commit in it, and keep the seed phrase offline until the very end`,
    `${engagementMove(proto, usd, chain)}. This costs the ${usd} of capital plus roughly ${gas} dollars of gas and about fifteen minutes to set up`,
    `each week do one fresh qualifying action — a deposit, a borrow, a swap, a vote or a claim — so the activity lands in several checkpoints`,
    `hold for at least ${days} days; multi-checkpoint history is what keeps the position out of the sybil filters`,
    `before withdrawing, check the protocol's own rewards page and claim only through the link it publishes; never pay a fee to claim`,
    `log every wallet, date and hash in a plain spreadsheet so the position can be repeated or unwound without guesswork`,
  ].map(clipStep);
}

function clipStep(text: string): string {
  const t = text.trim();
  if (t.length >= 20 && t.length <= 600) return t;
  if (t.length > 600) return `${t.slice(0, 596)}...`;
  return `${t} Then check the protocol's own page for the current reward rules.`;
}

export function liveLines(doc: SnapshotDoc): LiveLine[] {
  return doc.protocols
    .filter((x) => !noTokenYet(x) && x.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_SHOWN)
    .map((x) => ({
      slug: x.slug,
      name: x.name,
      category: x.category,
      chains: x.chains,
      tvl_usd: x.tvl_usd,
      mcap_usd: x.mcap_usd,
      change_7d: x.change_7d,
    }));
}

export function radarDoc(doc: SnapshotDoc, board: BoardLine[], p: ScoreParams = SCORE_PARAMS): RadarDoc {
  const live = liveLines(doc);
  const earlyCount = board.filter((r) => !doc.watchlist.includes(r.slug)).length;
  return {
    as_of: doc.as_of,
    source: doc.source,
    floor_usd: doc.floor_usd,
    score_tag: SCORE_TAG,
    params: p,
    watch_count: doc.watchlist.length,
    board_count: board.length,
    early_count: earlyCount,
    live_count: live.length,
    rows: board,
    live,
  };
}

export function parseSnapshotDoc(text: string): SnapshotDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotBadError('the snapshot is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotBadError('the snapshot is not a JSON object');
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) {
    throw new SnapshotBadError('the snapshot has no as_of date');
  }
  if (typeof o.source !== 'string') throw new SnapshotBadError('the snapshot has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) {
    throw new SnapshotBadError('the snapshot has no positive floor_usd');
  }
  if (!Array.isArray(o.protocols)) throw new SnapshotBadError('the snapshot has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotBadError('the snapshot has no watchlist of slugs');
  }
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw new SnapshotBadError(`protocol ${i} is not an object`);
    }
    const q = v as Record<string, unknown>;
    if (typeof q.slug !== 'string' || typeof q.name !== 'string' || typeof q.tvl_usd !== 'number' || !Number.isFinite(q.tvl_usd)) {
      throw new SnapshotBadError(`protocol ${i} lacks slug, name or tvl_usd`);
    }
    return {
      slug: q.slug,
      name: q.name,
      category: strOrNull(q.category),
      chains: strList(q.chains),
      tvl_usd: q.tvl_usd,
      change_7d: typeof q.change_7d === 'number' && Number.isFinite(q.change_7d) ? q.change_7d : null,
      mcap_usd: typeof q.mcap_usd === 'number' && Number.isFinite(q.mcap_usd) ? q.mcap_usd : null,
      listed_at: strOrNull(q.listed_at),
      gecko_id: strOrNull(q.gecko_id),
      symbol: strOrNull(q.symbol),
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

export function boardFault(board: BoardLine[], doc: SnapshotDoc): string | null {
  const seen = new Set(board.map((r) => r.slug));
  const missing = doc.watchlist.filter((s) => !seen.has(s));
  if (missing.length > 0) {
    return `watchlist slugs missing from the board: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`;
  }
  if (board.length < 100) return `only ${board.length} rows; the gate wants at least 100`;
  for (let i = 0; i < board.length; i++) {
    if (board[i]!.rank !== i + 1) return `rank ${i + 1} holds ${board[i]!.rank}`;
    if (i > 0 && board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) {
      return `row ${i + 1} carries a higher implied value than row ${i}`;
    }
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `every row shows the same implied value ${board[0]!.implied_value_usd}; nothing is ranked`;
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) {
      return `${r.slug} has an invalid implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) {
      return `${r.slug} lists ${r.farm_steps.length} farm steps`;
    }
    for (const step of r.farm_steps) {
      if (step.trim().length < 20 || step.trim().length > 600) {
        return `${r.slug} has a farm step of ${step.trim().length} characters`;
      }
    }
  }
  return null;
}

export function dataPayload(doc: RadarDoc): string {
  return `window.RADAR=${JSON.stringify(doc)};\n`;
}
