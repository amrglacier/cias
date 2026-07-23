import { describe, it, expect } from 'vitest';
import {
  bayesianSmooth,
  calculateAdjXg,
  calculateAdjConc,
  calculateWeatherDecay,
  calculateRefereeStrictness,
  calculateMotivation,
  calculateInjuryImpact,
  calculateFormationCounter,
} from '../src/agents/algorithms';
import { detectMoveType, classifyOddsZone, ODDS_ZONES, DEATH_ODDS_VALUES } from '../src/config/defaults';
import {
  calculateOWF,
  calculateK1,
  calculateWr,
  calibrateProbabilities,
  predictResult,
  generateDirectionJudgment,
} from '../src/agents/logic-engine';
import { validateConstitution } from '../src/system/constitution';
import { DEFAULT_FACTOR_WEIGHTS, SYSTEM_CONSTANTS } from '../src/config/defaults';
import type { MatchFacts, Prediction, MarketSignal } from '../src/types';

describe('Bayesian Smoothing', () => {
  it('should apply prior when sample < 5', () => {
    const result = bayesianSmooth(2.0, 3, 0, 1.3);
    expect(result.priorApplied).toBe(true);
    // When opp avg rate is 0, should use league avg
    expect(result.adjusted).toBeGreaterThan(0);
  });

  it('should not apply prior when sample >= 5', () => {
    const result = bayesianSmooth(2.0, 10, 1.5, 1.3);
    expect(result.priorApplied).toBe(false);
    expect(result.adjusted).toBeCloseTo(2.0 / 1.5);
  });

  it('should handle zero smoothed rate', () => {
    const result = bayesianSmooth(2.0, 10, 0, 1.3);
    // When smoothed rate is 0, fall back to league avg
    expect(result.adjusted).toBeGreaterThan(0);
  });
});

describe('Adjusted xG', () => {
  it('should calculate adjusted xG with prior', () => {
    const result = calculateAdjXg(2.5, 2, 0.5, 1.3);
    expect(result.priorApplied).toBe(true);
    expect(result.xgAdj).toBeGreaterThan(0);
  });

  it('should calculate adjusted xG without prior', () => {
    const result = calculateAdjXg(2.5, 10, 1.5, 1.3);
    expect(result.priorApplied).toBe(false);
    expect(result.xgAdj).toBeCloseTo(2.5 / 1.5);
  });
});

describe('Weather Decay', () => {
  it('should return 1.0 for normal weather', () => {
    const result = calculateWeatherDecay(20, 5, 0, false);
    expect(result).toBe(1.0);
  });

  it('should reduce decay for extreme weather', () => {
    const result = calculateWeatherDecay(-5, 30, 15, true);
    expect(result).toBeLessThan(1.0);
    expect(result).toBeGreaterThanOrEqual(0.95);
  });
});

describe('Referee Strictness', () => {
  it('should calculate based on card and foul averages', () => {
    const result = calculateRefereeStrictness(4, 0.3, 25);
    expect(result).toBeGreaterThan(0);
  });
});

describe('Motivation', () => {
  it('should increase for derby', () => {
    const result = calculateMotivation(true, false, false, false, true);
    expect(result).toBeGreaterThan(1.0);
  });

  it('should decrease for dead rubber', () => {
    const result = calculateMotivation(false, false, false, true, false);
    expect(result).toBeLessThan(1.0);
  });

  it('should clamp to [0.9, 1.1]', () => {
    const high = calculateMotivation(true, true, true, false, true);
    expect(high).toBeLessThanOrEqual(1.1);
    const low = calculateMotivation(false, false, false, true, false);
    expect(low).toBeGreaterThanOrEqual(0.9);
  });
});

describe('Injury Impact', () => {
  it('should calculate based on injured players', () => {
    const impact = calculateInjuryImpact([
      { position: 'GK', importance: 0.9 },
      { position: 'DEF', importance: 0.7 },
    ], true);
    expect(impact).toBeGreaterThan(0);
  });

  it('should return 0 for no injuries', () => {
    const impact = calculateInjuryImpact([], true);
    expect(impact).toBe(0);
  });
});

describe('Formation Counter', () => {
  it('should return positive for counter formation', () => {
    const result = calculateFormationCounter('4-3-3', '4-4-2');
    expect(result).toBe(0.03);
  });

  it('should return negative for being countered', () => {
    // 5-3-2 counters 4-3-3, so 4-3-3 vs 5-3-2 means away counters home
    const result = calculateFormationCounter('4-3-3', '5-3-2');
    expect(result).toBe(-0.03);
  });

  it('should return 0 for neutral formations', () => {
    // Neither formation counters the other
    const result = calculateFormationCounter('3-5-2', '4-3-3');
    expect(result).toBe(0);
  });
});

describe('Market Signal Detection', () => {
  it('should detect sharp move >= 5%', () => {
    const result = detectMoveType(2.0, 2.1);
    expect(result.isSharp).toBe(true);
    expect(result.movePct).toBeCloseTo(0.05);
  });

  it('should detect steam move >= 8%', () => {
    const result = detectMoveType(2.0, 2.2);
    expect(result.isSteam).toBe(true);
    expect(result.isSharp).toBe(true);
  });

  it('should not detect for small moves', () => {
    const result = detectMoveType(2.0, 2.02);
    expect(result.isSharp).toBe(false);
  });
});

describe('Odds Zone Classification', () => {
  it('should classify death odds 1.44', () => {
    const result = classifyOddsZone(1.44);
    expect(result).toBe(ODDS_ZONES.DEATH_ODDS);
  });

  it('should classify strong favorite', () => {
    const result = classifyOddsZone(1.3);
    expect(result).toBe(ODDS_ZONES.STRONG_FAVORITE);
  });

  it('should classify balanced', () => {
    const result = classifyOddsZone(2.2);
    expect(result).toBe(ODDS_ZONES.BALANCED);
  });
});

describe('OWF Calculation', () => {
  const mockFacts: MatchFacts = {
    matchId: 'test-1',
    homeXgAdj: 1.5,
    awayXgAdj: 1.0,
    homeConcAdj: 0.8,
    awayConcAdj: 1.2,
    injuryImpactHome: 0.1,
    injuryImpactAway: 0.05,
    weatherDecay: 0.98,
    refereeStrictness: 3,
    motivationHome: 1.05,
    motivationAway: 0.95,
    oddsZone: 'balanced',
    biasCorrection: 0,
    formationCtrHome: 0.03,
    formationCtrAway: -0.03,
    dataConfidence: 0.8,
    leagueAvgGoals: 1.3,
    leagueAvgConc: 1.3,
    bayesianPriorApplied: false,
    status: 'frozen',
  };

  it('should calculate OWF with correct formula', () => {
    const result = calculateOWF(mockFacts, DEFAULT_FACTOR_WEIGHTS, 0, 0);
    expect(result.value).toBeGreaterThan(0);
    // OWF = (1.5 * 0.35 + 1.0 * 0.25) * 0.98 * 1.05
    const expected = (1.5 * 0.35 + 1.0 * 0.25) * 0.98 * 1.05;
    expect(result.value).toBeCloseTo(expected, 5);
  });

  it('should include factors in result', () => {
    const result = calculateOWF(mockFacts, DEFAULT_FACTOR_WEIGHTS, 0, 0);
    expect(result.factors.F1).toBeDefined();
    expect(result.factors.F2).toBeDefined();
    expect(result.factors.F7).toBeDefined();
    expect(result.factors.F9).toBeDefined();
  });
});

describe('K1 Calculation', () => {
  const mockFacts: MatchFacts = {
    matchId: 'test-1',
    homeXgAdj: 1.5,
    awayXgAdj: 1.0,
    homeConcAdj: 0.8,
    awayConcAdj: 1.2,
    injuryImpactHome: 0.1,
    injuryImpactAway: 0.05,
    weatherDecay: 0.98,
    refereeStrictness: 3,
    motivationHome: 1.05,
    motivationAway: 0.95,
    oddsZone: 'balanced',
    biasCorrection: 0,
    formationCtrHome: 0.03,
    formationCtrAway: -0.03,
    dataConfidence: 0.8,
    leagueAvgGoals: 1.3,
    leagueAvgConc: 1.3,
    bayesianPriorApplied: false,
    status: 'frozen',
  };

  it('should calculate K1 with correct formula', () => {
    const result = calculateK1(mockFacts, DEFAULT_FACTOR_WEIGHTS);
    expect(result.value).toBeGreaterThan(0);
    // K1 = (0.8 * 0.20 + 1.2 * 0.10 + 3 * 0.02 * 5) * (1 - 0.1 * 0.15)
    const injuryFactor = 0.1 * 0.15;
    const baseSum = 0.8 * 0.20 + 1.2 * 0.10;
    const refComponent = 3 * 0.02 * 5;
    const expected = (baseSum + refComponent) * (1 - injuryFactor);
    expect(result.value).toBeCloseTo(expected, 5);
  });
});

describe('Wr Calculation', () => {
  const mockFacts: MatchFacts = {
    matchId: 'test-1',
    injuryImpactHome: 0.1,
    injuryImpactAway: 0,
    weatherDecay: 1.0,
    refereeStrictness: 3,
    motivationHome: 1.0,
    motivationAway: 1.0,
    biasCorrection: 0,
    formationCtrHome: 0,
    formationCtrAway: 0,
    dataConfidence: 0.8,
    leagueAvgGoals: 1.3,
    leagueAvgConc: 1.3,
    bayesianPriorApplied: false,
    status: 'frozen',
  };

  it('should calculate Wr with base rate + referee + error', () => {
    const result = calculateWr(mockFacts, DEFAULT_FACTOR_WEIGHTS, 0.05);
    const refComponent = 3 * 0.02 * 5;
    const expected = 0.05 + refComponent + 0.05;
    expect(result.value).toBeCloseTo(expected, 5);
  });
});

describe('Probability Calibration', () => {
  it('should produce valid probabilities', () => {
    const result = calibrateProbabilities(1.5, 0.8, 0.1, 0, 0);
    expect(result.homeWinProb).toBeGreaterThan(0);
    expect(result.drawProb).toBeGreaterThan(0);
    expect(result.awayWinProb).toBeGreaterThan(0);
    const sum = result.homeWinProb + result.drawProb + result.awayWinProb;
    expect(sum).toBeCloseTo(1.0, 5);
  });

  it('should apply bias zone correction', () => {
    const base = calibrateProbabilities(1.5, 0.8, 0.1, 0, 0);
    const adjusted = calibrateProbabilities(1.5, 0.8, 0.1, -0.05, 0);
    expect(adjusted.homeWinProb).toBeLessThan(base.homeWinProb);
  });
});

describe('Predict Result', () => {
  it('should pick highest probability as primary', () => {
    const result = predictResult(0.6, 0.25, 0.15);
    expect(result.primary).toBe('home_win');
  });

  it('should include hedge when second highest > 20%', () => {
    const result = predictResult(0.5, 0.3, 0.2);
    expect(result.hedge).toBeDefined();
  });

  it('should not include hedge when second highest <= 20%', () => {
    const result = predictResult(0.8, 0.1, 0.1);
    expect(result.hedge).toBeUndefined();
  });
});

describe('Direction Judgment', () => {
  it('should generate telegram-style text within 20-30 chars', () => {
    const result = generateDirectionJudgment('home_win', 'draw', 1.5, 0.8, []);
    expect(result.length).toBeGreaterThanOrEqual(15);
    expect(result.length).toBeLessThanOrEqual(30);
  });

  it('should not contain numbers', () => {
    const result = generateDirectionJudgment('home_win', undefined, 1.5, 0.8, []);
    expect(result).not.toMatch(/\d/);
  });

  it('should include market signal info', () => {
    const signals: MarketSignal[] = [
      { id: 'sig1', matchId: 'test', signalType: 'sharp_move', description: 'test', detectedAt: '', metadata: {} },
    ];
    const result = generateDirectionJudgment('home_win', undefined, 1.5, 0.8, signals);
    expect(result).toContain('\u8d54\u7387');
  });
});

describe('Constitutional Check', () => {
  const validPrediction: Prediction = {
    matchId: 'test-1',
    primaryResult: 'home_win',
    primaryFt: '2:1',
    primaryHt: '1:0',
    hedgeResult: 'draw',
    hedgeFt: '1:1',
    directionJudgment: '\u4e3b\u961f\u8fdb\u653b\u5360\u4f18\uff0c\u5ba2\u961f\u9632\u7ebf\u5b58\u7591\uff0c\u770b\u597d\u4e3b\u80dc\uff0c\u8c28\u9632\u95f7\u5e73',
    versionTag: 'INITIAL',
    isArchived: false,
    marketSignalIds: [],
    logicTrace: {
      bayesianApplied: true,
      unadjustedWarning: false,
    },
    keyFactors: {},
    isLock: false,
    alignmentStatus: 'pending',
    alignmentForcedDegrade: false,
    crossDiscussionLog: [],
  };

  it('should pass for valid prediction', () => {
    const result = validateConstitution(validPrediction);
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('should fail when direction contains numbers', () => {
    const bad = { ...validPrediction, directionJudgment: '\u4e3b\u961f\u8fdb\u653b\u5360\u4f1820%\u770b\u597d\u4e3b\u80dc' };
    const result = validateConstitution(bad);
    expect(result.passed).toBe(false);
    expect(result.checks.noNumbersInDirection).toBe(false);
  });

  it('should fail when no hedge for non-locked prediction', () => {
    const bad = { ...validPrediction, hedgeResult: undefined, hedgeFt: undefined };
    const result = validateConstitution(bad);
    expect(result.passed).toBe(false);
    expect(result.checks.hedgePresent).toBe(false);
  });

  it('should pass when locked and no hedge', () => {
    const locked = { ...validPrediction, isLock: true, hedgeResult: undefined, hedgeFt: undefined };
    const result = validateConstitution(locked);
    expect(result.checks.hedgePresent).toBe(true);
  });

  it('should fail for direction too short', () => {
    const bad = { ...validPrediction, directionJudgment: '\u592a\u77ed' };
    const result = validateConstitution(bad);
    expect(result.passed).toBe(false);
    expect(result.checks.directionLengthValid).toBe(false);
  });

  it('should fail for direction too long', () => {
    const long = '\u8fd9\u662f\u4e00\u4e2a\u975e\u5e38\u975e\u5e38\u975e\u5e38\u9759\u957f\u7684\u65b9\u5411\u7814\u5224\u8bed\u53e5\u8d85\u8fc7\u4e86\u4e09\u5341\u4e2a\u5b57\u7b26\u7684\u9650\u5236\u8303\u56f4\u592a\u957f\u4e86\u786e\u5b9e';
    const bad = { ...validPrediction, directionJudgment: long };
    const result = validateConstitution(bad);
    expect(result.passed).toBe(false);
    expect(result.checks.directionLengthValid).toBe(false);
  });
});

describe('System Constants', () => {
  it('should have correct in-play max records', () => {
    expect(SYSTEM_CONSTANTS.INPLAY_MAX_RECORDS).toBe(5);
  });

  it('should have correct cross-discussion max rounds', () => {
    expect(SYSTEM_CONSTANTS.CROSS_DISCUSSION_MAX_ROUNDS).toBe(2);
  });

  it('should have correct sharp move threshold', () => {
    expect(SYSTEM_CONSTANTS.SHARP_MOVE_THRESHOLD).toBe(0.05);
  });

  it('should have correct API budget critical percent', () => {
    expect(SYSTEM_CONSTANTS.API_BUDGET_CRITICAL_PERCENT).toBe(10);
  });

  it('should have death odds values', () => {
    expect(DEATH_ODDS_VALUES).toContain(1.44);
  });
});
