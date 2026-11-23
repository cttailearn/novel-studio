import { defineRole } from './role-kit.js';

/**
 * The adapter row: read the original, read the adapted draft, look up the
 * ledger, rename a chapter, hand over a proposal.
 *
 * It gets no prose-writing tool at all — `propose_adaptation` is a submission,
 * not a write. That is what makes "the author can always still see the old
 * version" a property of the tool set rather than a promise in the prompt.
 */
export default defineRole('adapt');
