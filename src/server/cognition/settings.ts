import type { AppConfig } from '../config.ts';

/** Effective cognition knobs: the `cognition`/`events` config sections plus internal defaults (spec §7). */
export interface CognitionSettings {
  retrievalK: number;
  retrievalWeights: { recency: number; importance: number; relevance: number };
  importanceMode: 'llm' | 'heuristic';
  reflectionThreshold: number;
  reflectionMode: 'single' | 'two-step';
  maxConversationTurns: number;
  pairCooldownMinutes: number;
  /** Same subject+activity is stored at most once per this many game minutes. */
  observationCooldownMinutes: number;
  reflectionMinGapMinutes: number;
  replanMinGapMinutes: number;
  /** Conversations are cut after this many game minutes (slow models). */
  maxConversationGameMinutes: number;
  importanceBatchSize: number;
  ensureDailyEvent: boolean;
  /** Minute of day after which a missing daily event is proposed. */
  ensureDailyAt: number;
  maxProposalsPerDay: number;
  needsEnabled: boolean;
  temperature: number;
  playerName: string;
  seed: number;
}

export const DEFAULT_SETTINGS: CognitionSettings = {
  retrievalK: 8,
  retrievalWeights: { recency: 1, importance: 1, relevance: 1 },
  importanceMode: 'llm',
  reflectionThreshold: 60,
  reflectionMode: 'single',
  maxConversationTurns: 6,
  pairCooldownMinutes: 120,
  observationCooldownMinutes: 30,
  reflectionMinGapMinutes: 180,
  replanMinGapMinutes: 120,
  maxConversationGameMinutes: 60,
  importanceBatchSize: 8,
  ensureDailyEvent: true,
  ensureDailyAt: 600,
  maxProposalsPerDay: 2,
  needsEnabled: true,
  temperature: 0.7,
  playerName: 'You',
  seed: 42,
};

export function settingsFromConfig(
  cfg: AppConfig,
  overrides: Partial<CognitionSettings> = {},
): CognitionSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...cfg.cognition,
    retrievalWeights: { ...cfg.cognition.retrievalWeights },
    ensureDailyEvent: cfg.events.ensureDaily,
    maxProposalsPerDay: cfg.events.maxProposalsPerDay,
    needsEnabled: cfg.needs.enabled,
    temperature: cfg.llm.temperature,
    playerName: cfg.player.name,
    seed: cfg.sim.seed,
    ...overrides,
  };
}
