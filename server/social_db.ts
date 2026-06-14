// Postgres-backed SocialDb. The schema is appended to the main ensureSchema()
// run in db.ts. All relationships are keyed by character id; the realm column
// on `characters` scopes a character to a world/shard (one realm today, but
// stored now so cross-realm friends/guilds need no migration later).

import type { Pool } from 'pg';
import type { CharInfo, CharRef, GuildRank, SocialDb } from './social';
import { REALM } from './realm';

// kept as an alias for the schema's column default; the live realm is REALM
export const DEFAULT_REALM = REALM;

export const SOCIAL_SCHEMA = `
ALTER TABLE characters ADD COLUMN IF NOT EXISTS realm TEXT NOT NULL DEFAULT '${DEFAULT_REALM.replace(/'/g, "''")}';
CREATE INDEX IF NOT EXISTS characters_realm ON characters(realm);
-- WoW: character names are unique per realm, not globally. Relax the original
-- global unique on characters.name to a (realm, name) composite. This is a
-- constraint relaxation, so existing globally-unique rows always satisfy it.
ALTER TABLE characters DROP CONSTRAINT IF EXISTS characters_name_key;
-- Uniqueness is enforced case-INSENSITIVELY — on (realm, lower(name)) — to
-- match how every name lookup in the codebase folds case (findCharacterByName,
-- findCharacterReportTargetByName, searchCharacters). A case-sensitive index
-- would let 'Bob' and 'bob' coexist in a realm, breaking the "names are unique
-- per realm" invariant and making moderation/social lookups resolve to the
-- wrong account (issue #137). Inserts that collide raise 23505, which the
-- create path already maps to a 409 "that name is taken".
--
-- This whole block is a one-time migration off the old case-sensitive
-- (realm, name) index, gated so an already-migrated DB skips it entirely.
-- ensureSchema() runs SOCIAL_SCHEMA on every boot (once per realm process,
-- under an advisory lock), so an UNCONDITIONAL drop+recreate would rebuild the
-- unique index — a full table scan that blocks writes — on every startup. The
-- guard checks for the folded index (its def contains 'lower(name)'); when it
-- already exists this is a cheap catalog lookup and nothing is rebuilt.
--
-- On first migration it: (1) disambiguates any pre-existing case-collisions,
-- which CREATE UNIQUE INDEX on lower(name) would otherwise error on —
-- deterministically and idempotently keeping the earliest (lowest-id) row's
-- name and, for each later colliding row, appending a '~<id>' suffix (id is
-- unique, so the folded name becomes unique) and flagging force_rename so the
-- player must pick a new name before next login (the same mechanism moderation
-- uses for name resets); then (2) drops the old case-sensitive index and builds
-- the folded one. Stored display case is preserved throughout.
DO $$
DECLARE
  dup RECORD;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'characters_realm_name' AND indexdef LIKE '%lower(name)%'
  ) THEN
    RETURN; -- already migrated; do not rebuild the index on every boot
  END IF;

  FOR dup IN
    SELECT id, name
    FROM (
      SELECT id, name,
             row_number() OVER (PARTITION BY realm, lower(name) ORDER BY id) AS rn
      FROM characters
    ) ranked
    WHERE rn > 1
  LOOP
    UPDATE characters
    SET name = left(dup.name, 16) || '~' || dup.id,
        force_rename = TRUE
    WHERE id = dup.id;
  END LOOP;

  DROP INDEX IF EXISTS characters_realm_name;
  CREATE UNIQUE INDEX characters_realm_name ON characters(realm, lower(name));
END $$;
-- Retained, NOT subsumed: this text_pattern_ops index is what serves the
-- typeahead's anchored "lower(name) LIKE 'prefix%'" query in searchCharacters.
-- The unique index above uses the default text_ops operator class, which serves
-- equality (lower(name) = ...) but cannot drive a LIKE prefix scan outside the C
-- locale — verified on Postgres 16, en_US.UTF-8: without this index that LIKE
-- falls back to a Seq Scan.
CREATE INDEX IF NOT EXISTS characters_realm_lower_name_prefix
  ON characters (realm, lower(name) text_pattern_ops);

CREATE TABLE IF NOT EXISTS friendships (
  character_id INT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  friend_id INT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (character_id, friend_id),
  CHECK (character_id <> friend_id)
);
CREATE INDEX IF NOT EXISTS friendships_friend ON friendships(friend_id);

CREATE TABLE IF NOT EXISTS blocks (
  character_id INT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  blocked_id INT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (character_id, blocked_id),
  CHECK (character_id <> blocked_id)
);

CREATE TABLE IF NOT EXISTS guilds (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  realm TEXT NOT NULL DEFAULT '${DEFAULT_REALM.replace(/'/g, "''")}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- guild names are likewise unique per realm
ALTER TABLE guilds DROP CONSTRAINT IF EXISTS guilds_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS guilds_realm_name ON guilds(realm, name);

CREATE TABLE IF NOT EXISTS guild_members (
  character_id INT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  guild_id INT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  rank TEXT NOT NULL DEFAULT 'member',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS guild_members_guild ON guild_members(guild_id);
`;

const CHAR_COLS = 'id, name, class AS cls, level, realm';

export class PgSocialDb implements SocialDb {
  constructor(private readonly pool: Pool) {}

  async findCharacterByName(name: string): Promise<CharInfo | null> {
    // scoped to this realm: you can only friend/ignore/invite characters that
    // live on the same world as you. Names are now unique per realm under
    // case-folding (the (realm, lower(name)) unique index), so a single
    // case-insensitive lookup is unambiguous — there can be at most one match.
    // This also keeps the query on the folded index; a raw `name = $1` branch
    // would have no supporting index after the case-sensitive one was dropped
    // and would scan the whole realm.
    const res = await this.pool.query(`SELECT ${CHAR_COLS} FROM characters WHERE lower(name) = lower($1) AND realm = $2 LIMIT 1`, [name, REALM]);
    return res.rows[0] ?? null;
  }

  async getCharacter(id: number): Promise<CharInfo | null> {
    const res = await this.pool.query(`SELECT ${CHAR_COLS} FROM characters WHERE id = $1 AND realm = $2`, [id, REALM]);
    return res.rows[0] ?? null;
  }

  async addFriend(charId: number, friendId: number): Promise<void> {
    await this.pool.query(
      'INSERT INTO friendships (character_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [charId, friendId],
    );
  }

  async removeFriend(charId: number, friendId: number): Promise<void> {
    await this.pool.query('DELETE FROM friendships WHERE character_id = $1 AND friend_id = $2', [charId, friendId]);
  }

  async listFriends(charId: number): Promise<CharInfo[]> {
    const res = await this.pool.query(
      `SELECT c.id, c.name, c.class AS cls, c.level, c.realm
       FROM friendships f JOIN characters c ON c.id = f.friend_id
       WHERE f.character_id = $1 ORDER BY c.name`,
      [charId],
    );
    return res.rows;
  }

  async whoFriended(charId: number): Promise<number[]> {
    const res = await this.pool.query('SELECT character_id FROM friendships WHERE friend_id = $1', [charId]);
    return res.rows.map((r) => r.character_id);
  }

  async addBlock(charId: number, blockedId: number): Promise<void> {
    await this.pool.query(
      'INSERT INTO blocks (character_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [charId, blockedId],
    );
  }

  async removeBlock(charId: number, blockedId: number): Promise<void> {
    await this.pool.query('DELETE FROM blocks WHERE character_id = $1 AND blocked_id = $2', [charId, blockedId]);
  }

  async listBlocks(charId: number): Promise<CharRef[]> {
    const res = await this.pool.query(
      `SELECT c.id, c.name FROM blocks b JOIN characters c ON c.id = b.blocked_id
       WHERE b.character_id = $1 ORDER BY c.name`,
      [charId],
    );
    return res.rows;
  }

  async blockedIds(charId: number): Promise<number[]> {
    const res = await this.pool.query('SELECT blocked_id FROM blocks WHERE character_id = $1', [charId]);
    return res.rows.map((r) => r.blocked_id);
  }

  async createGuild(name: string): Promise<number> {
    const res = await this.pool.query(
      'INSERT INTO guilds (name, realm) VALUES ($1, $2) RETURNING id',
      [name, DEFAULT_REALM],
    );
    return res.rows[0].id;
  }

  async deleteGuild(id: number): Promise<void> {
    await this.pool.query('DELETE FROM guilds WHERE id = $1', [id]);
  }

  async guildMembership(charId: number): Promise<{ guildId: number; guildName: string; rank: GuildRank } | null> {
    const res = await this.pool.query(
      `SELECT gm.guild_id, g.name AS guild_name, gm.rank
       FROM guild_members gm JOIN guilds g ON g.id = gm.guild_id
       WHERE gm.character_id = $1`,
      [charId],
    );
    const row = res.rows[0];
    return row ? { guildId: row.guild_id, guildName: row.guild_name, rank: row.rank } : null;
  }

  async addGuildMember(guildId: number, charId: number, rank: GuildRank): Promise<void> {
    await this.pool.query(
      `INSERT INTO guild_members (guild_id, character_id, rank) VALUES ($1, $2, $3)
       ON CONFLICT (character_id) DO NOTHING`,
      [guildId, charId, rank],
    );
  }

  async removeGuildMember(charId: number): Promise<void> {
    await this.pool.query('DELETE FROM guild_members WHERE character_id = $1', [charId]);
  }

  async setGuildRank(charId: number, rank: GuildRank): Promise<void> {
    await this.pool.query('UPDATE guild_members SET rank = $2 WHERE character_id = $1', [charId, rank]);
  }

  async guildMembers(guildId: number): Promise<(CharInfo & { rank: GuildRank })[]> {
    const res = await this.pool.query(
      `SELECT c.id, c.name, c.class AS cls, c.level, c.realm, gm.rank
       FROM guild_members gm JOIN characters c ON c.id = gm.character_id
       WHERE gm.guild_id = $1 ORDER BY gm.joined_at`,
      [guildId],
    );
    return res.rows;
  }
}
