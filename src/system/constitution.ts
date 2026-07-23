// ============================================================
// CIAS - Constitutional Check
// SRS Section 1: Constitution (Highest Priority)
// ============================================================

import type { Prediction, ConstitutionalCheck } from '../types';
import { SYSTEM_CONSTANTS } from '../config/defaults';

/**
 * SRS 1.1 & 1.2: Validate prediction against constitutional rules.
 * Violations are treated as Fatal Error.
 */
export function validateConstitution(prediction: Prediction): ConstitutionalCheck {
  const violations: string[] = [];
  const checks = {
    formatValid: true,
    directionLengthValid: true,
    noNumbersInDirection: true,
    hedgePresent: true,
    versionTagValid: true,
  };

  // Check 1: Direction judgment format (SRS 1.2 - Telegram style)
  const dir = prediction.directionJudgment || '';
  if (dir.length < SYSTEM_CONSTANTS.DIRECTION_MIN_CHARS || dir.length > SYSTEM_CONSTANTS.DIRECTION_MAX_CHARS) {
    checks.directionLengthValid = false;
    violations.push(
      `Direction judgment length ${dir.length} outside [${SYSTEM_CONSTANTS.DIRECTION_MIN_CHARS}, ${SYSTEM_CONSTANTS.DIRECTION_MAX_CHARS}]`
    );
  }

  // Check 2: No numbers in direction judgment (SRS 1.2)
  if (/\d/.test(dir)) {
    checks.noNumbersInDirection = false;
    violations.push('Direction judgment contains numbers (forbidden by constitution)');
  }

  // Check 3: Non-stone-cold picks must have hedge (SRS 5.2 - Constitutional constraint)
  // is_lock = TRUE OR hedge_result IS NOT NULL (DB CHECK constraint)
  if (!prediction.isLock && !prediction.hedgeResult) {
    checks.hedgePresent = false;
    violations.push('Non-locked prediction has no hedge (constitutional violation)');
  }

  // Check 4: Version tag valid
  if (!['INITIAL', 'PERIODIC', 'FINAL'].includes(prediction.versionTag)) {
    checks.versionTagValid = false;
    violations.push(`Invalid version_tag: ${prediction.versionTag}`);
  }

  // Check 5: Primary result format
  if (!prediction.primaryResult || !['home_win', 'draw', 'away_win'].includes(prediction.primaryResult)) {
    checks.formatValid = false;
    violations.push(`Invalid primary_result: ${prediction.primaryResult}`);
  }

  // Check 6: Scoreline format (x:y pattern)
  if (prediction.primaryFt && !/^\d+:\d+$/.test(prediction.primaryFt)) {
    checks.formatValid = false;
    violations.push(`Invalid primary_ft format: ${prediction.primaryFt}`);
  }
  if (prediction.hedgeFt && !/^\d+:\d+$/.test(prediction.hedgeFt)) {
    checks.formatValid = false;
    violations.push(`Invalid hedge_ft format: ${prediction.hedgeFt}`);
  }

  // Check 7: logic_trace must reflect Bayesian status (SRS 9.1)
  if (!prediction.logicTrace || prediction.logicTrace.bayesianApplied === undefined) {
    violations.push('logic_trace missing bayesianApplied field');
  }

  return {
    passed: violations.length === 0,
    violations,
    checks,
  };
}

/**
 * SRS 5.2 Phase 5: Constitutional enforcement before publish.
 * If not compliant, block publication.
 */
export function enforceConstitution(prediction: Prediction): {
  canPublish: boolean;
  errors: string[];
} {
  const check = validateConstitution(prediction);
  if (!check.passed) {
    return {
      canPublish: false,
      errors: check.violations,
    };
  }
  return { canPublish: true, errors: [] };
}
