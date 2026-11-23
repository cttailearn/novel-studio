/**
 * Role rows.
 *
 * Each is a separate module *on disk* because the loader resolves a preset row
 * by module specifier: `@local/dsh-novel-studio/role/material` is an entry in
 * this package's `exports`, and it must be its own file so that the row's
 * config is independent of the parent plugin's.
 *
 * Keeping them thin is the point — everything shared lives in `role-kit.js`.
 */

import { defineRole } from './role-kit.js';

export default defineRole('material');
