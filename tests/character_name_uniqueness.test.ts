import { describe, expect, it } from 'vitest';
import { SOCIAL_SCHEMA } from '../server/social_db';

// Issue #137: character-name uniqueness was enforced case-SENSITIVELY at the DB
// level — UNIQUE(realm, name) — while every lookup in the codebase folds case.
// So `Bob` and `bob` could both be created in one realm, breaking the documented
// "names are unique per realm" invariant and letting moderation/social lookups
// resolve to the wrong account. The fix folds the unique index to match the
// lookups: UNIQUE(realm, lower(name)). The create path already maps Postgres'
// 23505 unique-violation to a 409 "that name is taken", so no main.ts change is
// needed once the index folds case.
//
// The DB is not exercised directly in this test harness (no live Postgres — see
// the pg-mock pattern in db_search.test.ts / character_db.test.ts), so we assert
// the migration DDL string that ensureSchema() runs verbatim against Postgres.

describe('character name uniqueness (#137)', () => {
  it('enforces uniqueness case-insensitively, scoped per realm', () => {
    // Folded unique index: (realm, lower(name)). This makes `Bob` and `bob`
    // collide within a realm (insert raises 23505 -> 409), while the same name
    // on a DIFFERENT realm is still allowed because `realm` is the lead column.
    expect(SOCIAL_SCHEMA).toContain(
      'CREATE UNIQUE INDEX characters_realm_name ON characters(realm, lower(name))',
    );
  });

  it('does not keep a case-SENSITIVE unique index on the raw name', () => {
    // The original case-sensitive index must be gone — a verbatim (realm, name)
    // unique index would let `Bob`/`bob` coexist again.
    expect(SOCIAL_SCHEMA).not.toContain(
      'CREATE UNIQUE INDEX characters_realm_name ON characters(realm, name)',
    );
    expect(SOCIAL_SCHEMA).not.toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS characters_realm_name ON characters(realm, name)',
    );
  });

  it('disambiguates pre-existing case-colliding rows before adding the unique index', () => {
    // CREATE UNIQUE INDEX on lower(name) FAILS on a live DB that already holds
    // case-collisions (e.g. a `Bob` and a `bob` created before this fix). The
    // migration must deterministically resolve those collisions first, keeping
    // the earliest (lowest-id) row and flagging the later duplicates for rename,
    // so the index build cannot error out on existing data.
    const dedupeIdx = SOCIAL_SCHEMA.indexOf('force_rename = TRUE');
    const createIdx = SOCIAL_SCHEMA.indexOf(
      'CREATE UNIQUE INDEX characters_realm_name ON characters(realm, lower(name))',
    );
    expect(dedupeIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeGreaterThanOrEqual(0);
    // the dedupe/backfill runs BEFORE the unique index is created
    expect(dedupeIdx).toBeLessThan(createIdx);
  });

  it('guards the drop/recreate so an already-migrated DB does not rebuild the index every boot', () => {
    // ensureSchema() runs SOCIAL_SCHEMA on every server start (once per realm
    // process). An unconditional DROP INDEX + CREATE would rebuild the unique
    // index — a full table scan that blocks writes — on every boot. The
    // migration must short-circuit when the folded index already exists.
    expect(SOCIAL_SCHEMA).toContain('AND indexdef LIKE \'%lower(name)%\'');
    // the early-out (RETURN) must precede the destructive DROP INDEX so the
    // guard actually skips the rebuild rather than running it
    const guardIdx = SOCIAL_SCHEMA.indexOf('RETURN;');
    const dropIdx = SOCIAL_SCHEMA.indexOf('DROP INDEX IF EXISTS characters_realm_name');
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(dropIdx).toBeGreaterThanOrEqual(0);
    expect(guardIdx).toBeLessThan(dropIdx);
  });
});
