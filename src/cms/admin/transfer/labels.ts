import type { MatchState, Outcome, TransferAction } from './types';

/** Words for the codes, in one place, so both wizards say the same thing. */
export const ACTION_LABELS: Record<TransferAction, string> = {
  skip: 'Skip — keep this site’s',
  overwrite: 'Overwrite this site’s',
  copy: 'Import as a copy',
  merge: 'Merge — add what is missing',
};

export const STATE_LABELS: Record<MatchState, string> = {
  new: 'New',
  conflict: 'Exists here',
  ambiguous: 'Matches more than one item',
  pathTaken: 'Its address is taken',
};

export const OUTCOME_LABELS: Record<Outcome, string> = {
  created: 'Created',
  updated: 'Overwritten',
  copied: 'Copied',
  merged: 'Merged',
  skipped: 'Skipped',
  reused: 'Already here',
  failed: 'Failed',
  pending: 'Not reached',
};
