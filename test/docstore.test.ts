import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
// The other declared peer major, installed under an alias so one suite can prove
// the library against both ends of `"zod": "^3.24.0 || ^4.3"` (F028).
import { z as zodThree } from "zod3";
import {
  compileWhere,
  createCollection,
  createStore,
  dateParser,
  DEFAULT_MAX_ROWS,
  type DocStore,
  populate,
  ref,
  transactionAcross,
} from "../src/index.ts";

function inTemporaryDirectory<TResult>(work: (directory: string) => TResult): TResult {
  const directory = mkdtempSync(join(tmpdir(), "docstore-"));
  try {
    return work(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function withTemporaryDirectory<TResult>(work: (databasePath: string) => TResult): TResult {
  return inTemporaryDirectory((directory) => work(join(directory, "docstore.sqlite")));
}

const UserSchema = z.object({
  id: ref("user"),
  name: z.string().default(""),
  age: z.number().default(0),
  active: z.boolean().default(true),
  nickname: z.string().nullable().default(null),
});

const PostSchema = z.object({
  id: ref("post"),
  authorId: ref("user"),
  title: z.string().default(""),
  views: z.number().default(0),
});

function freshUsers() {
  const store = createStore();
  const users = store.collection("users", UserSchema, {
    indexes: ["age", { fields: ["active"] }],
  });
  return { store, users };
}

describe("createCollection — CRUD", () => {
  test("insert validates, stores, and returns the parsed document", () => {
    const { users } = freshUsers();
    const inserted = users.insert({ id: "user_alice", name: "Alice", age: 30 });
    expect(inserted).toEqual({
      id: "user_alice",
      name: "Alice",
      age: 30,
      active: true,
      nickname: null,
    });
  });

  test("get re-parses on the way out and returns null for a miss", () => {
    const { users } = freshUsers();
    users.insert({ id: "user_bob", name: "Bob" });
    expect(users.get("user_bob")?.name).toBe("Bob");
    expect(users.get("user_missing")).toBeNull();
  });

  test("insert rejects a document that fails the Zod gate", () => {
    const { users } = freshUsers();
    expect(() => users.insert({ id: "not-a-user-ref", name: "X" })).toThrow();
    expect(() => users.insert({ id: "user_x", age: "old" as unknown as number })).toThrow();
  });

  test("duplicate id fails loudly", () => {
    const { users } = freshUsers();
    users.insert({ id: "user_dup" });
    expect(() => users.insert({ id: "user_dup" })).toThrow();
  });

  test("update shallow-merges, re-validates, and rejects id changes", () => {
    const { users } = freshUsers();
    users.insert({ id: "user_u", name: "U", age: 20 });
    const updated = users.update("user_u", { age: 21 });
    expect(updated?.age).toBe(21);
    expect(updated?.name).toBe("U");
    expect(users.update("user_absent", { age: 1 })).toBeNull();
    expect(() => users.update("user_u", { id: "user_other" })).toThrow();
  });

  test("replace swaps the whole document", () => {
    const { users } = freshUsers();
    users.insert({ id: "user_r", name: "Before", age: 1 });
    const replaced = users.replace("user_r", { id: "user_r", name: "After" });
    expect(replaced).toEqual({
      id: "user_r",
      name: "After",
      age: 0,
      active: true,
      nickname: null,
    });
    expect(users.replace("user_gone", { id: "user_gone" })).toBeNull();
    expect(() => users.replace("user_r", { id: "user_mismatch" })).toThrow();
  });

  test("upsert inserts then replaces", () => {
    const { users } = freshUsers();
    users.upsert({ id: "user_up", name: "First" });
    users.upsert({ id: "user_up", name: "Second" });
    expect(users.get("user_up")?.name).toBe("Second");
    expect(users.count()).toBe(1);
  });

  test("delete reports whether a row was removed", () => {
    const { users } = freshUsers();
    users.insert({ id: "user_d" });
    expect(users.delete("user_d")).toBe(true);
    expect(users.delete("user_d")).toBe(false);
    expect(users.get("user_d")).toBeNull();
  });
});

describe("batch operations", () => {
  test("insertMany is atomic — a bad row rolls back the whole batch", () => {
    const { users } = freshUsers();
    expect(() =>
      users.insertMany([
        { id: "user_ok1" },
        { id: "bad-ref" },
        { id: "user_ok2" },
      ]),
    ).toThrow();
    expect(users.count()).toBe(0);
  });

  test("insertMany commits a valid batch", () => {
    const { users } = freshUsers();
    const inserted = users.insertMany([{ id: "user_1" }, { id: "user_2" }]);
    expect(inserted).toHaveLength(2);
    expect(users.count()).toBe(2);
  });

  test("findByIds dedups, preserves order, and omits misses", () => {
    const { users } = freshUsers();
    users.insertMany([{ id: "user_a" }, { id: "user_b" }, { id: "user_c" }]);
    const found = users.findByIds(["user_c", "user_a", "user_c", "user_missing"]);
    expect(found.map((user) => user.id)).toEqual(["user_c", "user_a"]);
    expect(users.findByIds([])).toEqual([]);
  });

  test("deleteMany removes matching rows and returns the count", () => {
    const { users } = freshUsers();
    users.insertMany([
      { id: "user_young", age: 10 },
      { id: "user_old1", age: 70 },
      { id: "user_old2", age: 80 },
    ]);
    expect(users.deleteMany({ age: { gte: 70 } })).toBe(2);
    expect(users.count()).toBe(1);
  });
});

describe("find — typed where-clause", () => {
  function seeded() {
    const { users } = freshUsers();
    users.insertMany([
      { id: "user_1", name: "Ann", age: 20, active: true, nickname: "A" },
      { id: "user_2", name: "Bob", age: 30, active: false, nickname: null },
      { id: "user_3", name: "Cy", age: 40, active: true, nickname: null },
    ]);
    return users;
  }

  test("shorthand equality", () => {
    expect(seeded().find({ where: { name: "Bob" } }).map((user) => user.id)).toEqual([
      "user_2",
    ]);
  });

  test("boolean equality maps to 1/0", () => {
    expect(seeded().find({ where: { active: true } }).map((user) => user.id)).toEqual([
      "user_1",
      "user_3",
    ]);
  });

  test("comparison operators", () => {
    const users = seeded();
    expect(users.find({ where: { age: { gt: 20, lte: 40 } } }).map((user) => user.id)).toEqual([
      "user_2",
      "user_3",
    ]);
  });

  test("in / notIn", () => {
    const users = seeded();
    expect(users.find({ where: { age: { in: [20, 40] } } }).map((user) => user.id)).toEqual([
      "user_1",
      "user_3",
    ]);
    expect(users.find({ where: { age: { notIn: [20, 40] } } }).map((user) => user.id)).toEqual([
      "user_2",
    ]);
    expect(users.find({ where: { age: { in: [] } } })).toEqual([]);
  });

  test("like", () => {
    expect(seeded().find({ where: { name: { like: "A%" } } }).map((user) => user.id)).toEqual([
      "user_1",
    ]);
  });

  test("null handling via shorthand and operators", () => {
    const users = seeded();
    expect(users.find({ where: { nickname: null } }).map((user) => user.id)).toEqual([
      "user_2",
      "user_3",
    ]);
    expect(users.find({ where: { nickname: { isNull: false } } }).map((user) => user.id)).toEqual([
      "user_1",
    ]);
    expect(users.find({ where: { nickname: { ne: null } } }).map((user) => user.id)).toEqual([
      "user_1",
    ]);
  });

  test("orderBy, limit, and offset", () => {
    const users = seeded();
    const descending = users.find({ orderBy: { field: "age", direction: "desc" } });
    expect(descending.map((user) => user.id)).toEqual(["user_3", "user_2", "user_1"]);
    const paged = users.find({ orderBy: { field: "age" }, limit: 1, offset: 1 });
    expect(paged.map((user) => user.id)).toEqual(["user_2"]);
  });

  test("findOne and count", () => {
    const users = seeded();
    expect(users.findOne({ where: { active: false } })?.id).toBe("user_2");
    expect(users.findOne({ where: { name: "nobody" } })).toBeNull();
    expect(users.count({ active: true })).toBe(2);
  });
});

describe("escaped LIKE operands (F009)", () => {
  const RowSchema = z.object({ id: ref("row"), name: z.string().default("") });

  function seeded() {
    const store = createStore();
    const rows = store.collection("rows", RowSchema);
    rows.insertMany([
      { id: "row_ann", name: "Ann" },
      { id: "row_percent", name: "50% off" },
      { id: "row_underscore", name: "a_b" },
      { id: "row_backslash", name: "back\\slash" },
    ]);
    return rows;
  }

  test("contains matches a literal %, _ and backslash", () => {
    const rows = seeded();
    expect(rows.find({ where: { name: { contains: "%" } } }).map((row) => row.id)).toEqual([
      "row_percent",
    ]);
    expect(rows.find({ where: { name: { contains: "_" } } }).map((row) => row.id)).toEqual([
      "row_underscore",
    ]);
    expect(rows.find({ where: { name: { contains: "\\" } } }).map((row) => row.id)).toEqual([
      "row_backslash",
    ]);
  });

  test("contains on an ordinary string matches the substring", () => {
    const rows = seeded();
    expect(rows.find({ where: { name: { contains: "nn" } } }).map((row) => row.id)).toEqual([
      "row_ann",
    ]);
    expect(rows.find({ where: { name: { contains: "off" } } }).map((row) => row.id)).toEqual([
      "row_percent",
    ]);
    expect(rows.find({ where: { name: { contains: "nothing" } } })).toEqual([]);
  });

  test("startsWith and endsWith anchor the escaped operand", () => {
    const rows = seeded();
    expect(rows.find({ where: { name: { startsWith: "50%" } } }).map((row) => row.id)).toEqual([
      "row_percent",
    ]);
    // Anchored, so the leading "50" is required — "% off" is not a prefix.
    expect(rows.find({ where: { name: { startsWith: "% off" } } })).toEqual([]);
    expect(rows.find({ where: { name: { endsWith: "_b" } } }).map((row) => row.id)).toEqual([
      "row_underscore",
    ]);
  });

  test("like stays a raw pattern, with an ESCAPE for a literal wildcard", () => {
    const rows = seeded();
    // Documented behaviour: the expert escape hatch means what SQL means.
    expect(rows.find({ where: { name: { like: "%" } } })).toHaveLength(4);
    expect(rows.find({ where: { name: { like: "A%" } } }).map((row) => row.id)).toEqual([
      "row_ann",
      // SQLite's LIKE is ASCII case-insensitive, and "_" is the caller's own
      // wildcard here — both are what "raw pattern" means.
      "row_underscore",
    ]);
    // …and the ESCAPE clause is what makes a literal expressible at all.
    expect(rows.find({ where: { name: { like: "%\\%%" } } }).map((row) => row.id)).toEqual([
      "row_percent",
    ]);
  });

  test("a literal backslash in a raw like pattern must be doubled", () => {
    const rows = seeded();
    // `\` is the escape character, so a doubled one is the literal.
    expect(rows.find({ where: { name: { like: "%\\\\%" } } }).map((row) => row.id)).toEqual([
      "row_backslash",
    ]);
    // Undoubled, "\s" escapes the "s" — the pattern reads "backslash" and matches
    // no row. It fails closed, which is why it is documented rather than guarded.
    expect(rows.find({ where: { name: { like: "back\\slash" } } })).toEqual([]);
    expect(rows.find({ where: { name: { like: "back\\\\slash" } } }).map((row) => row.id)).toEqual([
      "row_backslash",
    ]);
  });

  test("contains compiles to an escaped LIKE and fails loudly on a non-string", () => {
    expect(compileWhere({ name: { contains: "50%" } })).toEqual({
      sql: String.raw`WHERE json_extract(doc, '$.name') LIKE ? ESCAPE '\'`,
      parameters: [String.raw`%50\%%`],
    });
    expect(() => compileWhere({ name: { contains: 5 } })).toThrow(
      /"contains" expects a string operand/,
    );
  });
});

describe("dotted field paths in where and orderBy (F011)", () => {
  const PlaceSchema = z.object({
    id: ref("place"),
    label: z.string().default(""),
    address: z
      .object({
        city: z.string().default(""),
        geo: z.object({ zone: z.string().default("") }).default({ zone: "" }),
      })
      .default({ city: "", geo: { zone: "" } }),
  });

  function seeded() {
    const store = createStore();
    // The README's own nested-index example — now queryable by the same path.
    const places = store.collection("places", PlaceSchema, { indexes: ["address.city"] });
    places.insertMany([
      { id: "place_b", label: "Beta", address: { city: "Berlin", geo: { zone: "east" } } },
      { id: "place_a", label: "Alpha", address: { city: "Aachen", geo: { zone: "west" } } },
    ]);
    return places;
  }

  test("a nested path filters without a cast", () => {
    const places = seeded();
    expect(places.find({ where: { "address.city": "Berlin" } }).map((place) => place.id)).toEqual([
      "place_b",
    ]);
    // The operand is typed by the value at the path, not widened to unknown.
    expect(
      places.find({ where: { "address.city": { startsWith: "Aa" } } }).map((place) => place.id),
    ).toEqual(["place_a"]);
    expect(places.count({ "address.geo.zone": { in: ["east"] } })).toBe(1);
  });

  test("a nested path orders", () => {
    expect(
      seeded()
        .find({ orderBy: { field: "address.city", direction: "desc" } })
        .map((place) => place.id),
    ).toEqual(["place_b", "place_a"]);
  });

  test("a typo'd path is a compile error", () => {
    // @ts-expect-error "address.citty" is not a field path of the document
    expect(seeded().find({ where: { "address.citty": "Berlin" } })).toEqual([]);
  });
});

describe("OR / NOT combinators (F012)", () => {
  function seeded() {
    const { users } = freshUsers();
    users.insertMany([
      { id: "user_1", name: "Ann", age: 20, active: true, nickname: "mine" },
      { id: "user_2", name: "Bob", age: 30, active: false, nickname: null },
      { id: "user_3", name: "Cy", age: 40, active: true, nickname: "yours" },
      { id: "user_4", name: "Dee", age: 50, active: false, nickname: "mine" },
    ]);
    return users;
  }

  test("a disjunction orders and pages across the whole union", () => {
    const users = seeded();
    // "assigned to me or unassigned" — the work-queue shape.
    expect(
      users
        .find({
          where: { OR: [{ nickname: "mine" }, { nickname: null }] },
          orderBy: { field: "age", direction: "desc" },
        })
        .map((user) => user.id),
    ).toEqual(["user_4", "user_2", "user_1"]);
    // The property two find() calls merged in JavaScript cannot provide: the
    // limit applies to the union, not to each half of it.
    expect(
      users
        .find({
          where: { OR: [{ nickname: "mine" }, { nickname: null }] },
          orderBy: { field: "age", direction: "desc" },
          limit: 2,
          offset: 1,
        })
        .map((user) => user.id),
    ).toEqual(["user_2", "user_1"]);
    expect(users.count({ OR: [{ nickname: "mine" }, { nickname: null }] })).toBe(3);
  });

  test("sibling conditions still AND, so a disjunction narrows", () => {
    const users = seeded();
    expect(
      users
        .find({ where: { active: false, OR: [{ nickname: "mine" }, { nickname: null }] } })
        .map((user) => user.id),
    ).toEqual(["user_2", "user_4"]);
  });

  test("NOT negates a nested clause, and the combinators nest", () => {
    const users = seeded();
    expect(users.find({ where: { NOT: { active: true } } }).map((user) => user.id)).toEqual([
      "user_2",
      "user_4",
    ]);
    expect(
      users
        .find({ where: { NOT: { OR: [{ age: { lt: 30 } }, { age: { gt: 40 } }] } } })
        .map((user) => user.id),
    ).toEqual(["user_2", "user_3"]);
    expect(
      users
        .find({ where: { OR: [{ age: 20 }, { NOT: { nickname: { isNull: false } } }] } })
        .map((user) => user.id),
    ).toEqual(["user_1", "user_2"]);
  });

  test("an empty disjunction matches nothing", () => {
    expect(seeded().find({ where: { OR: [] } })).toEqual([]);
  });

  test("a branch with no condition matches nothing, so an absent value cannot widen", () => {
    const users = seeded();
    // The shape a work-queue screen actually builds: the filter's value comes
    // from state that may not be loaded yet. `undefined` is skipped, so this
    // branch carries no condition at all — it must not read as "every row".
    const currentUser: string | undefined = undefined;
    expect(
      users
        .find({ where: { OR: [{ nickname: currentUser }, { nickname: null }] } })
        .map((user) => user.id),
    ).toEqual(["user_2"]);
    expect(users.count({ OR: [{ nickname: currentUser }] })).toBe(0);
    // Through deleteMany the fail-open reading would have emptied the table.
    expect(users.deleteMany({ OR: [{ nickname: currentUser }] })).toBe(0);
    expect(users.count()).toBe(4);
  });

  test("a document field named OR or NOT is refused where the schema is declared", () => {
    const store = createStore();
    expect(() =>
      store.collection("bad", z.object({ id: ref("b"), OR: z.string().default("") })),
    ).toThrow(/field "OR" is a reserved where-clause key/);
    expect(() =>
      store.collection("bad", z.object({ id: ref("b"), NOT: z.string().default("") })),
    ).toThrow(/field "NOT" is a reserved where-clause key/);
  });
});

describe("an absent value narrows, never widens (F022)", () => {
  function seeded() {
    const { users } = freshUsers();
    users.insertMany([
      { id: "user_1", name: "Ann", age: 20, active: true, nickname: "mine" },
      { id: "user_2", name: "Bob", age: 30, active: false, nickname: null },
      { id: "user_3", name: "Cy", age: 40, active: true, nickname: "yours" },
      { id: "user_4", name: "Dee", age: 50, active: false, nickname: "mine" },
    ]);
    return users;
  }

  test("a top-level where whose value is absent matches nothing, through deleteMany and count", () => {
    const users = seeded();
    // The same work-queue shape the OR branch already guarded, without the OR —
    // and this is the spelling a caller reaches for first.
    const currentUser: string | undefined = undefined;
    expect(users.count({ nickname: currentUser })).toBe(0);
    expect(users.find({ where: { nickname: currentUser } })).toEqual([]);
    // The one that cost: this used to compile to a bare `DELETE FROM "users"`.
    expect(users.deleteMany({ nickname: currentUser })).toBe(0);
    expect(users.count()).toBe(4);
  });

  test("the operator-object form goes the same way", () => {
    const users = seeded();
    const minimumAge: number | undefined = undefined;
    expect(users.count({ age: { gte: minimumAge } })).toBe(0);
    expect(users.deleteMany({ age: { gte: minimumAge } })).toBe(0);
    expect(users.count()).toBe(4);
  });

  test("one absent sibling narrows the whole clause rather than dropping out of it", () => {
    const users = seeded();
    const currentUser: string | undefined = undefined;
    // `active: false` on its own matches two rows. A partial widening is still
    // over-deletion, so the surviving sibling must not be left to run alone.
    expect(users.count({ active: false, nickname: currentUser })).toBe(0);
    expect(users.deleteMany({ active: false, nickname: currentUser })).toBe(0);
    expect(users.count()).toBe(4);
  });

  test("NOT of an absent value matches nothing rather than negating into every row", () => {
    const users = seeded();
    const currentUser: string | undefined = undefined;
    // Narrowing the gap to `0` is not sufficient by itself here: `NOT (0)` is
    // every row, so the fail-open would return through the negation.
    expect(users.count({ NOT: { nickname: currentUser } })).toBe(0);
    expect(users.deleteMany({ NOT: { nickname: currentUser } })).toBe(0);
    expect(users.count()).toBe(4);
    // A NOT over a clause that decides something still negates normally.
    expect(users.count({ NOT: { active: true } })).toBe(2);
  });

  test("a live alternative still makes a disjunction a real filter", () => {
    const users = seeded();
    const currentUser: string | undefined = undefined;
    // One unavailable alternative among live ones narrows the disjunction; it
    // does not poison it. This is the documented README shape and must not have
    // been traded away for the guard above.
    expect(
      users
        .find({ where: { OR: [{ nickname: currentUser }, { nickname: null }] } })
        .map((user) => user.id),
    ).toEqual(["user_2"]);
  });

  test("negating a disjunction that carries a gap matches nothing, not its complement", () => {
    const users = seeded();
    const currentUser: string | undefined = undefined;
    // The retention shape — "delete everything except these" — and the one the
    // README teaches for NOT. A missing branch *narrows* the disjunction, so
    // negating it widens the complement by exactly the rows the missing
    // condition existed to protect: user_1 is kept only by `nickname: "mine"`.
    // Whether the clause is usable in positive position and whether it is safe
    // to negate are therefore two different questions.
    expect(users.find({ where: { NOT: { OR: [{ nickname: currentUser }, { nickname: null }] } } }))
      .toEqual([]);
    expect(users.count({ NOT: { OR: [{ nickname: currentUser }, { nickname: null }] } })).toBe(0);
    expect(users.deleteMany({ NOT: { OR: [{ nickname: currentUser }, { nickname: null }] } })).toBe(
      0,
    );
    expect(users.count()).toBe(4);

    // Supplied, the very same clause negates normally — the guard keys on the
    // gap, not on the shape.
    const assignee: string | undefined = "mine";
    expect(
      users
        .find({ where: { NOT: { OR: [{ nickname: assignee }, { nickname: null }] } } })
        .map((user) => user.id),
    ).toEqual(["user_3"]);
  });

  test("the gap survives to any depth under a negation", () => {
    const users = seeded();
    const currentUser: string | undefined = undefined;
    // Nesting must not launder it: each of these reaches the negation through
    // one more layer than the last.
    expect(users.count({ NOT: { NOT: { nickname: currentUser } } })).toBe(0);
    expect(users.count({ NOT: { OR: [{ NOT: { nickname: currentUser } }, { age: 20 }] } })).toBe(0);
    expect(users.count({ NOT: { active: true, nickname: currentUser } })).toBe(0);
    expect(users.deleteMany({ NOT: { OR: [{ NOT: { nickname: currentUser } }] } })).toBe(0);
    expect(users.count()).toBe(4);
  });

  test("an explicit empty where is still the caller asking for no filter", () => {
    const users = seeded();
    // `{}` names no key, so nothing went missing — it stays the documented
    // "match everything", which is what keeps deleteMany({}) meaningful.
    expect(users.count({})).toBe(4);
    expect(users.find({ where: {} }).length).toBe(4);
    expect(users.deleteMany({})).toBe(4);
  });
});

describe("an undefined patch key is not supplied (F023)", () => {
  test("it leaves the stored value alone instead of resetting it to the schema default", () => {
    const { users } = freshUsers();
    users.insert({ id: "user_1", name: "Ann", age: 20, nickname: "mine" });
    // A patch built from optional inputs — `update(id, { name: form.name })`.
    // Every non-identity field carries a `.default(...)`, so an
    // assigned `undefined` was dropped by JSON.stringify and then refilled from
    // that default: the stored value gone, with nothing logged and nothing thrown.
    const name: string | undefined = undefined;
    const updated = users.update("user_1", { name, age: 21 });
    expect(updated?.name).toBe("Ann");
    expect(updated?.age).toBe(21);
    expect(updated?.nickname).toBe("mine");
    // The stored row kept it too, not merely the object handed back.
    expect(users.get("user_1")?.name).toBe("Ann");
  });

  test("clearing a field means naming the value to clear it to", () => {
    const { users } = freshUsers();
    users.insert({ id: "user_1", name: "Ann", nickname: "mine" });
    expect(users.update("user_1", { nickname: null })?.nickname).toBe(null);
    expect(users.get("user_1")?.nickname).toBe(null);
    expect(users.update("user_1", { name: "" })?.name).toBe("");
  });

  test("replace() is the wholesale form, where an omitted field does take its default", () => {
    const { users } = freshUsers();
    users.insert({ id: "user_1", name: "Ann", age: 20, nickname: "mine" });
    // The contrast that makes update()'s rule legible rather than arbitrary:
    // replace() is a whole new document, so its omissions are real omissions.
    const replaced = users.replace("user_1", { id: "user_1" });
    expect(replaced?.name).toBe("");
    expect(replaced?.age).toBe(0);
    expect(replaced?.nickname).toBe(null);
  });
});

describe("populate — batched join", () => {
  function seeded() {
    const store = createStore();
    const users = store.collection("users", UserSchema);
    const posts = store.collection("posts", PostSchema);
    users.insertMany([
      { id: "user_alice", name: "Alice" },
      { id: "user_bob", name: "Bob" },
    ]);
    posts.insertMany([
      { id: "post_1", authorId: "user_alice", title: "First" },
      { id: "post_2", authorId: "user_bob", title: "Second" },
      { id: "post_3", authorId: "user_ghost", title: "Orphan" },
    ]);
    return { users, posts };
  }

  test("attaches resolved references and null for misses", () => {
    const { users, posts } = seeded();
    const populated = populate(posts.find(), "authorId", users, "author");
    expect(populated.map((post) => post.author?.name ?? null)).toEqual([
      "Alice",
      "Bob",
      null,
    ]);
  });

  test("the missing reference is an explicit null key, never a dropped one", () => {
    const { users, posts } = seeded();
    const populated = populate(posts.find({ where: { id: "post_3" } }), "authorId", users, "author");
    expect(populated[0]).toHaveProperty("author");
    expect(populated[0]?.author).toBeNull();
  });
});

describe("forward-compatible defaults", () => {
  test("rows written under an old schema read forward under an extended one", () => {
    const store = createStore({ path: ":memory:" });
    const oldUsers = store.collection("people", z.object({ id: ref("user"), name: z.string().default("") }));
    oldUsers.insert({ id: "user_legacy", name: "Legacy" });

    // A second collection handle over the same table with a new defaulted field.
    const newUsers = store.collection(
      "people",
      z.object({
        id: ref("user"),
        name: z.string().default(""),
        role: z.enum(["admin", "member"]).default("member"),
      }),
    );
    expect(newUsers.get("user_legacy")).toEqual({
      id: "user_legacy",
      name: "Legacy",
      role: "member",
    });
  });
});

// F006 — find() parsed every row through the schema with no error policy, so
// one row that no longer validated threw for the whole query: three rows, one
// stale, and find() returned nothing at all while count() still answered 3.
describe("the read policy (F006)", () => {
  const LooseSchema = z.object({ id: ref("p"), status: z.string().default("open") });
  const TightSchema = z.object({
    id: ref("p"),
    status: z.enum(["open", "closed"]).default("open"),
  });

  /**
   * Three rows `p_1`–`p_3` written under the loose schema, reopened under the
   * tight one that strands whichever carries a status the enum rejects. The
   * default strands the middle row; passing statuses moves the damage, padding
   * with a readable `"open"` to keep the row count at three.
   */
  function stale(onParseError?: "throw" | "skip", ...statuses: string[]) {
    const rowStatuses =
      statuses.length === 0
        ? ["open", "legacy-value", "open"] // written under the old schema
        : [0, 1, 2].map((index) => statuses[index] ?? "open");
    const store = createStore();
    store.collection("docs", LooseSchema).insertMany(
      rowStatuses.map((status, index) => ({ id: `p_${index + 1}`, status })),
    );
    return store.collection("docs", TightSchema, { onParseError });
  }

  test("under \"throw\" the message names the row that failed", () => {
    const tight = stale();
    // A bare ZodError does not say *which* row failed, which is what made
    // diagnosis expensive; the id is now in the message either way.
    expect(() => tight.find()).toThrow(/stored row "p_2" does not match the current schema/);
    expect(() => tight.get("p_2")).toThrow(/stored row "p_2"/);
    expect(() => tight.findByIds(["p_1", "p_2"])).toThrow(/stored row "p_2"/);
    // A good row is still readable one at a time, and count() still answers
    // from SQL — the two realities the finding named.
    expect(tight.get("p_1")?.status).toBe("open");
    expect(tight.count()).toBe(3);
  });

  test("under \"skip\" the good rows come back and the bad row reads as absent", () => {
    const tight = stale("skip");
    expect(tight.find().map((document) => document.id)).toEqual(["p_1", "p_3"]);
    expect(tight.findByIds(["p_1", "p_2", "p_3"]).map((document) => document.id)).toEqual([
      "p_1",
      "p_3",
    ]);
    expect(tight.get("p_2")).toBeNull();
    expect(tight.get("p_1")?.status).toBe("open");
    // Skipping is a read policy, not a repair: the row is still there.
    expect(tight.count()).toBe(3);
  });

  test("validate() lists exactly the failing ids and throws nothing", () => {
    const failures = stale().validate();
    expect(failures.map((failure) => failure.id)).toEqual(["p_2"]);
    expect(failures[0]?.error).toBeInstanceOf(z.ZodError);
    // The repair primitive works under either policy, and reports rather than
    // throws — that is what makes it usable on a collection already in trouble.
    expect(stale("skip").validate().map((failure) => failure.id)).toEqual(["p_2"]);
    expect(stale().find({ where: { id: "p_1" } })).toHaveLength(1);
  });

  test("a row of malformed JSON is a parse failure like any other", () => {
    const store = createStore();
    const documents = store.collection("docs", LooseSchema);
    documents.insert({ id: "p_1" });
    store.database.run(`INSERT INTO "docs" (id, doc) VALUES ('p_broken', '{not json')`);

    expect(() => documents.find()).toThrow(/stored row "p_broken"/);
    expect(documents.validate().map((failure) => failure.id)).toEqual(["p_broken"]);
    const skipping = store.collection("docs", LooseSchema, { onParseError: "skip" });
    expect(skipping.find().map((document) => document.id)).toEqual(["p_1"]);
  });

  test("a write onto an unreadable row names the collection and the row too", () => {
    const store = createStore();
    const documents = store.collection("docs", LooseSchema);
    documents.insert({ id: "p_1" });
    store.database.run(`INSERT INTO "docs" (id, doc) VALUES ('p_broken', '{not json')`);

    // update() merges into the stored JSON, so it meets a malformed row before
    // any schema does. A bare "JSON Parse error" is the diagnosis cost F006 was
    // closed to remove — the write path owes the same named message as a read.
    expect(() => documents.update("p_broken", { status: "open" })).toThrow(
      /Collection "docs": stored row "p_broken"/,
    );
    expect(() => documents.update("p_broken", { status: "open" })).toThrow(
      /stored JSON is malformed/,
    );
    // A write never skips: the policy that lets a read past the row does not
    // let a write past it.
    const skipping = store.collection("docs", LooseSchema, { onParseError: "skip" });
    expect(() => skipping.update("p_broken", { status: "open" })).toThrow(
      /stored row "p_broken"/,
    );
    // A row that is merely stale — well-formed JSON the schema now rejects — is
    // still repairable through update(), which is the point of not validating
    // the stored form here.
    const tight = store.collection("docs", TightSchema);
    store.database.run(
      `INSERT INTO "docs" (id, doc) VALUES ('p_stale', '{"id":"p_stale","status":"legacy-value"}')`,
    );
    expect(tight.update("p_stale", { status: "closed" })?.status).toBe("closed");
    // Repaired: it no longer appears among the rows the schema rejects. Only
    // the malformed row does, which no patch can fix.
    expect(tight.validate().map((failure) => failure.id)).toEqual(["p_broken"]);
  });

  // The skip filter runs after SQL has applied LIMIT, so a page containing a
  // skipped row comes back short. Pinned rather than fixed: `limit`/`offset`
  // page over *stored* rows, and paging over readable rows instead would make
  // every page's offset require a parse of the whole table before it. It is a
  // documented cost of a degraded read-for-repair mode, called out on
  // `onParseError` and in the README.
  test("under \"skip\" a page containing a skipped row comes back short", () => {
    const skipping = stale("skip", "legacy-value");
    expect(skipping.find().map((document) => document.id)).toEqual(["p_2", "p_3"]);
    expect(skipping.find({ limit: 2 }).map((document) => document.id)).toEqual(["p_2"]);
    expect(skipping.validate().map((failure) => failure.id)).toEqual(["p_1"]);
  });

  // …but findOne() is not a page, and a null that means "the first stored match
  // was skipped" is indistinguishable from "no such document" for exactly the
  // operator repairing a damaged collection. It streams to the first *readable*
  // match instead.
  test("under \"skip\" findOne() steps over a skipped row to the first readable match", () => {
    const skipping = stale("skip", "legacy-value"); // p_1 is stale and sorts first
    expect(skipping.findOne()?.id).toBe("p_2");
    // Order, filter and offset still decide *which* match — findOne only stops
    // skipping rows short of one it can return.
    expect(skipping.findOne({ orderBy: { field: "id", direction: "desc" } })?.id).toBe("p_3");
    expect(skipping.findOne({ offset: 1 })?.id).toBe("p_2");
    expect(skipping.findOne({ where: { id: "p_3" } })?.id).toBe("p_3");
    // A null still means what it says: no match, or none that is readable.
    expect(skipping.findOne({ where: { id: "p_1" } })).toBeNull();
    expect(skipping.findOne({ where: { id: "p_missing" } })).toBeNull();

    // Every match unreadable is the only case that scans to the end.
    const allStale = stale("skip", "legacy-value", "legacy-value", "legacy-value");
    expect(allStale.findOne()).toBeNull();

    // Under the default policy the first unreadable match still throws rather
    // than being stepped over — skipping is opt-in, and findOne does not widen it.
    expect(() => stale("throw", "legacy-value").findOne()).toThrow(/stored row "p_1"/);
  });

  // findOne is the one read that stops before the end of its scan. bun:sqlite
  // caches prepared statements by SQL text, and a cached statement left
  // mid-scan *resumes* there on its next use — so an early exit would hand the
  // tail of one caller's scan to the next one, silently. Same SQL text is the
  // sharp case: findOne() with no options and validate() compile identically.
  test("a findOne() that stops early leaves no scan open for the next read", () => {
    const skipping = stale("skip", "legacy-value");
    expect(skipping.findOne()?.id).toBe("p_2");
    // Not "p_3": the second call starts its own scan rather than resuming.
    expect(skipping.findOne()?.id).toBe("p_2");
    expect(skipping.validate().map((failure) => failure.id)).toEqual(["p_1"]);
    expect(skipping.find().map((document) => document.id)).toEqual(["p_2", "p_3"]);
    expect(skipping.count()).toBe(3);
  });
});

// F021 — the read path appended the JSON driver's own message, and JavaScriptCore
// quotes the token it failed on, so a corrupted row reproduced a fragment of its
// stored document into the exception and from there into a log. That is the leak
// the write gate was hardened against, one surface along.
describe("a malformed row names its position, never its content (F021)", () => {
  const RowSchema = z.object({ id: ref("r"), body: z.string().default("") });

  function corrupted() {
    const store = createStore();
    const rows = store.collection("rows", RowSchema);
    rows.insert({ id: "r_ok" });
    // A corruption that leaves a bare identifier rather than truncating — the
    // shape that made the driver quote document content. A truncated row names
    // nothing, which is why this finding was narrow rather than absent.
    store.database.run(
      `INSERT INTO "rows" (id, doc) VALUES ('r_1', '{"id":"r_1","body":SECRET_TOKEN_ABC}')`,
    );
    return { store, rows };
  }

  test("get() and update() withhold the token the parser choked on", () => {
    const { rows } = corrupted();
    const reads = [() => rows.get("r_1"), () => rows.update("r_1", { body: "x" })];
    for (const read of reads) {
      // Still diagnosable: the collection, the row, and where in the JSON.
      expect(read).toThrow(/stored row "r_1"/);
      expect(read).toThrow(/Malformed JSON at line \d+, column \d+/);
      expect(read).not.toThrow(/SECRET_TOKEN_ABC/);
    }
  });

  test("the original SyntaxError is still the cause", () => {
    const { rows } = corrupted();
    // Withheld from the message, not discarded: a caller that deliberately
    // inspects the cause is a different decision from a line that lands in a log.
    expect(() => rows.get("r_1")).toThrow();
    try {
      rows.get("r_1");
    } catch (error) {
      expect((error as Error).cause).toBeInstanceOf(SyntaxError);
      expect(((error as Error).cause as Error).message).toContain("SECRET_TOKEN_ABC");
    }
  });

  test("a row that fails Zod rather than JSON still reports its failing path", () => {
    const { store, rows } = corrupted();
    // The fix must not blunt the common case: a well-formed row the schema
    // rejects names the field that failed, because that is the diagnosis.
    store.database.run(`INSERT INTO "rows" (id, doc) VALUES ('r_2', '{"id":"r_2","body":42}')`);
    expect(() => rows.get("r_2")).toThrow(/body/);
    expect(() => rows.get("r_2")).not.toThrow(/Malformed JSON/);
  });

  test("validate() still lists the malformed row", () => {
    const { rows } = corrupted();
    expect(rows.validate().map((failure) => failure.id)).toEqual(["r_1"]);
  });
});

// F028 — the other half of the same function. A SyntaxError's message was
// withheld while a ZodError's was forwarded verbatim, on the premise that it
// names paths and types and carries no values. It does not: a ZodError's message
// is the serialised issue list, an issue's path runs through a z.record()'s keys
// — which are document content, as the write gate has said for two hundred lines
// — and under Zod 3 the issue carries the rejected value as `received` too. It
// needs no corruption, only a stored row the current schema rejects, and it
// fires on the default read policy.
describe("a stale row names its failing paths, never its content (F028)", () => {
  // The map-keyed-by-person shape the elision rule was written for: the key is
  // an identifier, the value is what the schema now rejects.
  const ConsentSchema = z.object({
    id: ref("r"),
    consents: z.record(z.string(), z.boolean()).default({}),
    label: z.string().default(""),
  });

  /**
   * One readable row and one stale one. The stale row is well-formed JSON that
   * an earlier schema would have accepted — the ordinary drift case, not a
   * corruption — with an identifier for a record key and a value the current
   * schema rejects.
   */
  function stale() {
    const store = createStore();
    const rows = store.collection("rows", ConsentSchema);
    rows.insert({ id: "r_ok" });
    store.database.run(
      `INSERT INTO "rows" (id, doc) VALUES ('r_1', ` +
        `'{"id":"r_1","consents":{"alice@example.com":"SECRET_VALUE"},"label":""}')`,
    );
    return rows;
  }

  test("every read path renders the issue list instead of forwarding it", () => {
    const rows = stale();
    const reads = [
      () => rows.get("r_1"),
      () => rows.find(),
      () => rows.findByIds(["r_ok", "r_1"]),
      () => rows.findOne({ where: { id: "r_1" } }),
    ];
    for (const read of reads) {
      // Still diagnosable: the collection, the row, the code, and a path whose
      // record segment says a key was there without saying which.
      expect(read).toThrow(/Collection "rows": stored row "r_1"/);
      expect(read).toThrow(/"consents\.<key>" \(invalid_type, expected boolean\)/);
      // And carries nothing of the document: neither the key nor the value.
      expect(read).not.toThrow(/alice/);
      expect(read).not.toThrow(/example\.com/);
      expect(read).not.toThrow(/SECRET_VALUE/);
    }
  });

  test("the original ZodError is still the cause, and still carries what the message drops", () => {
    const rows = stale();
    try {
      rows.get("r_1");
      throw new Error("expected a throw");
    } catch (error) {
      const cause = (error as Error).cause;
      // Withheld from the message, not discarded — the same decision F021 made
      // for the SyntaxError: a caller that deliberately inspects the cause is
      // not a line that lands in a log by default.
      expect(cause).toBeInstanceOf(z.ZodError);
      expect(JSON.stringify((cause as z.ZodError).issues)).toContain("alice@example.com");
    }
  });

  test("a declared field's name still appears in the path", () => {
    const store = createStore();
    const rows = store.collection("rows", ConsentSchema);
    store.database.run(
      `INSERT INTO "rows" (id, doc) VALUES ('r_2', ` +
        `'{"id":"r_2","consents":{},"label":42,"nested":{"deep":1}}')`,
    );
    // Eliding a schema-declared key would blunt the diagnosis F006 was closed to
    // provide: `label` is a field name a developer typed, not stored content.
    expect(() => rows.get("r_2")).toThrow(/"label" \(invalid_type, expected string\)/);
  });

  test("a nested object names its fields and an array names its index", () => {
    const NestedSchema = z.object({
      id: ref("r"),
      profile: z.object({ nickname: z.string().default("") }).default({ nickname: "" }),
      scores: z.array(z.number()).default([]),
    });
    const store = createStore();
    const rows = store.collection("rows", NestedSchema);
    store.database.run(
      `INSERT INTO "rows" (id, doc) VALUES ('r_3', ` +
        `'{"id":"r_3","profile":{"nickname":7},"scores":[1,"SECRET_VALUE"]}')`,
    );
    // A position is not content, so an index is printed as the write gate prints
    // it; a declared key two levels down is still a field name.
    expect(() => rows.get("r_3")).toThrow(/"profile\.nickname" \(invalid_type, expected string\)/);
    expect(() => rows.get("r_3")).toThrow(/"scores\[1\]" \(invalid_type, expected number\)/);
    expect(() => rows.get("r_3")).not.toThrow(/SECRET_VALUE/);
  });

  test("repeated record failures collapse rather than counting the document's keys", () => {
    const store = createStore();
    const rows = store.collection("rows", ConsentSchema);
    const consents = Object.fromEntries(
      Array.from({ length: 30 }, (_unused, index) => [`person_${index}@example.com`, "yes"]),
    );
    store.database.run(
      `INSERT INTO "rows" (id, doc) VALUES ('r_4', '${JSON.stringify({ id: "r_4", consents, label: "" })}')`,
    );
    // Thirty rejected entries of one record are one path — printing it thirty
    // times would add no diagnosis while publishing how many keys the row held.
    let message = "";
    try {
      rows.get("r_4");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(`"consents.<key>" (invalid_type, expected boolean)`);
    expect(message.match(/<key>/g)).toHaveLength(1);
    expect(message).not.toContain("person_");
    expect(message).not.toContain("30");
  });

  test("the write gate's round-trip refusal renders the issue list too", () => {
    // The same reflex on the write path: a document whose stored form its own
    // schema rejects. It echoes the caller's own document back to the caller
    // rather than a stored row to a log, which made it the smaller half — but it
    // is the same defect, and one renderer closes both.
    const CalendarSchema = z.object({
      id: ref("c"),
      seen: z.record(z.string(), z.date()).default({}),
    });
    const store = createStore();
    const calendars = store.collection("calendars", CalendarSchema);
    const write = () => calendars.insert({ id: "c_1", seen: { "alice@example.com": new Date(0) } });

    expect(write).toThrow(/does not survive a JSON round-trip/);
    expect(write).toThrow(/"seen\.<key>" \(invalid_type, expected date\)/);
    expect(write).not.toThrow(/alice/);
    expect(write).not.toThrow(/example\.com/);
    // The neighbouring stability refusal already said this; both throws in the
    // function say it now.
    expect(write).toThrow(/no document values are included in this message/);
  });

  // Zod is a peer dependency across two majors and the leak is not the same on
  // both: Zod 4 puts a record's key in the issue path, and Zod 3 puts the
  // *rejected value* in the issue's `received` field on top of it. Which major
  // runs is the consumer's choice, so the older one is installed as the `zod3`
  // alias and exercised here rather than reasoned about — the enum and literal
  // codes are the two that carry `received`.
  describe("under the older declared peer major", () => {
    // ref() and dateParser are built from the Zod the library resolves, and
    // mixing two majors inside one schema is the bug a peer dependency exists to
    // prevent — so this schema is spelled out in Zod 3 alone, id field included.
    const LegacySchema = zodThree.object({
      id: zodThree.string(),
      consents: zodThree.record(zodThree.string(), zodThree.boolean()).default({}),
      kind: zodThree.enum(["draft", "final"]).default("draft"),
      seat: zodThree.literal("front").default("front"),
      label: zodThree.string().default(""),
    }) as unknown as z.ZodType;

    function staleUnderZodThree() {
      const store = createStore();
      const rows = store.collection("legacy", LegacySchema);
      store.database.run(
        `INSERT INTO "legacy" (id, doc) VALUES ('r_1', ` +
          `'{"id":"r_1","consents":{"alice@example.com":"SECRET_VALUE"},` +
          `"kind":"SECRET_TOKEN_ABC","seat":"SECRET_TOKEN_ABC","label":42}')`,
      );
      return rows;
    }

    test("the message names codes and paths and drops Zod 3's `received`", () => {
      const rows = staleUnderZodThree();
      const read = () => rows.get("r_1");
      expect(read).toThrow(/stored row "r_1"/);
      expect(read).toThrow(/"consents\.<key>" \(invalid_type, expected boolean\)/);
      expect(read).toThrow(/"kind" \(invalid_enum_value\)/);
      expect(read).toThrow(/"seat" \(invalid_literal, expected front\)/);
      // A declared field is still named here too.
      expect(read).toThrow(/"label" \(invalid_type, expected string\)/);
      // The two codes that carry the rejected value under this major, and the
      // record key that both majors carry.
      expect(read).not.toThrow(/SECRET_TOKEN_ABC/);
      expect(read).not.toThrow(/SECRET_VALUE/);
      expect(read).not.toThrow(/alice/);
      expect(read).not.toThrow(/example\.com/);
    });

    test("the cause still carries the key and the value the message withholds", () => {
      const rows = staleUnderZodThree();
      try {
        rows.get("r_1");
        throw new Error("expected a throw");
      } catch (error) {
        const cause = (error as Error).cause as { issues?: unknown };
        const issues = JSON.stringify(cause.issues);
        expect(issues).toContain("alice@example.com");
        expect(issues).toContain("SECRET_TOKEN_ABC");
      }
    });
  });
});

// F024 — the page bounds were inlined into the SQL text, so every distinct
// limit/offset was a distinct SQL string and `Database.query()` kept a prepared
// statement per string for the life of the connection. F025 — and the bounds
// were checked with `Number.isInteger`, which is `true` for `1e21`, so a value
// that no longer denotes one integer reached that text as `LIMIT 1e+21`.
describe("the paged read path (F024, F025)", () => {
  const PageSchema = z.object({ id: ref("n"), body: z.string().default("") });

  function seeded(rowCount: number) {
    const store = createStore();
    const pages = store.collection("pages", PageSchema);
    pages.insertMany(
      Array.from({ length: rowCount }, (_unused, index) => ({ id: `n_${index}` })),
    );
    return pages;
  }

  test("paging over many distinct pages retains nothing per page", () => {
    const pages = seeded(5);
    const PAGE_COUNT = 20_000;
    const residentBytes = () => {
      Bun.gc(true);
      return process.memoryUsage().rss;
    };
    const measure = (page: (index: number) => number) => {
      const before = residentBytes();
      for (let index = 0; index < PAGE_COUNT; index += 1) {
        pages.find({ limit: 1, offset: page(index) });
      }
      return (residentBytes() - before) / 1024 / 1024;
    };

    // Saturate the allocator arena before measuring anything. RSS tracks a
    // high-water mark rather than live memory, so an unwarmed first arm charges
    // ~40 MB of one-time growth to whichever loop happens to run first — enough
    // to swamp the signal and let a leaking build pass. A full-length warmup on
    // the *repeated* page reaches that mark while retaining a single statement
    // under either mechanism, so it cannot mask the thing being measured.
    for (let index = 0; index < PAGE_COUNT; index += 1) pages.find({ limit: 1, offset: 0 });

    // Both arms now run the same number of queries and allocate the same garbage
    // — one row parsed through Zod per call. The only difference left between
    // them is how many distinct SQL strings they produce, which is exactly what
    // the statement cache keys on.
    const repeatedPageMegabytes = measure(() => 0);
    const distinctPageMegabytes = measure((index) => index);

    // A/B measured over this exact loop, with only `compileLimitOffset` swapped:
    // inlined, the distinct arm retained ~56 MB against a ~2 MB control — one
    // cached statement per page, never released, for the life of the connection.
    // Bound, it is ~0 MB against the same control. The slack absorbs a noisy
    // machine while leaving the old behaviour failing by roughly 37 MB. This
    // asserts the retention is gone, not what the SQL looks like.
    expect(distinctPageMegabytes).toBeLessThan(repeatedPageMegabytes + 16);
  });

  test("limit and offset still page correctly, together and apart", () => {
    const pages = seeded(5);
    const order = { field: "id" } as const;
    expect(pages.find({ orderBy: order, limit: 2, offset: 1 }).map((page) => page.id)).toEqual([
      "n_1",
      "n_2",
    ]);
    // OFFSET with no LIMIT is the case that needs SQLite's "no limit" sentinel,
    // which is now bound rather than spelled into the statement.
    expect(pages.find({ orderBy: order, offset: 3 }).map((page) => page.id)).toEqual([
      "n_3",
      "n_4",
    ]);
    expect(pages.find({ orderBy: order, limit: 2 }).map((page) => page.id)).toEqual([
      "n_0",
      "n_1",
    ]);
    // The bounds bind after the where-clause's own parameters, so their order
    // has to survive a statement carrying both.
    expect(
      pages
        .find({
          where: { id: { in: ["n_1", "n_2", "n_3"] } },
          orderBy: order,
          limit: 2,
          offset: 1,
        })
        .map((page) => page.id),
    ).toEqual(["n_2", "n_3"]);
  });

  test("a bound that is not a safe integer is refused (F025)", () => {
    const pages = seeded(5);
    // Number.isInteger(1e21) is true, which is how `LIMIT 1e+21` used to compile.
    expect(() => pages.find({ limit: 1e21 })).toThrow(/Invalid limit 1e\+21/);
    expect(() => pages.find({ offset: 2 ** 53 })).toThrow(/Invalid offset/);
    expect(() => pages.find({ limit: -1 })).toThrow(/Invalid limit -1/);
    expect(() => pages.find({ limit: 1.5 })).toThrow(/Invalid limit 1.5/);
    // find() compiles its ceiling as maxRows + 1, so a ceiling that would make
    // that sum unrepresentable is refused at its own edge instead of surfacing
    // later as a confusing "invalid limit".
    expect(() => createStore({ maxRows: Number.MAX_SAFE_INTEGER })).toThrow(/Invalid maxRows/);
  });
});

// F010 — find() with no limit selected every matching row and parsed each one
// through Zod into memory, with no ceiling and no warning.
describe("the find() result ceiling (F010)", () => {
  const NoteSchema = z.object({ id: ref("n"), body: z.string().default("") });

  function seeded(rowCount: number, maxRows?: number | null) {
    const store = createStore(maxRows === undefined ? {} : { maxRows });
    const notes = store.collection("notes", NoteSchema);
    notes.insertMany(
      Array.from({ length: rowCount }, (_unused, index) => ({ id: `n_${index}` })),
    );
    return notes;
  }

  test("an unbounded find() past the ceiling throws, naming the collection and the ceiling", () => {
    const notes = seeded(6, 5);
    expect(() => notes.find()).toThrow(
      /find\(\) on "notes" returned more than maxRows \(5\)/,
    );
    // The message says what to do about it rather than only that it happened.
    expect(() => notes.find()).toThrow(/Pass an explicit limit, paginate, or raise\/disable maxRows/);
    // A where-clause that brings the result under the ceiling is unaffected.
    expect(notes.find({ where: { id: "n_0" } })).toHaveLength(1);
  });

  test("exactly maxRows rows is under the ceiling, not over it", () => {
    expect(seeded(5, 5).find()).toHaveLength(5);
  });

  test("an explicit limit is the caller's own bound and is honoured", () => {
    const notes = seeded(6, 5);
    expect(notes.find({ limit: 5 })).toHaveLength(5);
    expect(notes.find({ limit: 6 })).toHaveLength(6);
    expect(notes.find({ limit: 2, offset: 4 }).map((note) => note.id)).toEqual(["n_4", "n_5"]);
  });

  test("maxRows: null disables the ceiling for an export that wants every row", () => {
    expect(seeded(20, null).find()).toHaveLength(20);
    // A collection may keep its own ceiling — including `null` — against the store's.
    const store = createStore({ maxRows: 2 });
    const notes = store.collection("notes", NoteSchema, { maxRows: null });
    notes.insertMany([{ id: "n_1" }, { id: "n_2" }, { id: "n_3" }]);
    expect(notes.find()).toHaveLength(3);
    expect(store.collection("other", NoteSchema).find()).toEqual([]);
  });

  test("the default ceiling is 10_000", () => {
    expect(() => seeded(DEFAULT_MAX_ROWS + 1).find()).toThrow(/more than maxRows \(10000\)/);
    expect(seeded(DEFAULT_MAX_ROWS).find()).toHaveLength(DEFAULT_MAX_ROWS);
  });

  test("an invalid ceiling is rejected at the edge, on both entry points", () => {
    expect(() => createStore({ maxRows: 0 })).toThrow("Invalid maxRows 0");
    expect(() => createStore({ maxRows: -1 })).toThrow("Invalid maxRows -1");
    expect(() => createStore({ maxRows: 1.5 })).toThrow("Invalid maxRows 1.5");
    expect(() => createStore().collection("notes", NoteSchema, { maxRows: 0 })).toThrow(
      "Invalid maxRows 0",
    );
  });
});

// F013 — two handles on one table could disagree about identity, writing rows
// under two incompatible conventions with no complaint; the failure surfaced
// far away, as a row neither handle could read (which is F006's shape).
describe("collection reopen bindings (F013)", () => {
  test("reopening with a different idField throws, naming both fields", () => {
    const store = createStore();
    store.collection("ks", z.object({ id: ref("k") })).insert({ id: "k_1" });
    expect(() =>
      store.collection("ks", z.object({ slug: ref("k") }), { idField: "slug" }),
    ).toThrow(/collection\("ks"\): already open with idField "id", cannot reopen with "slug"/);
    // The conflicting handle never came into existence, so the table still holds
    // only the row written under the first convention — the assertion has to
    // start from a non-empty table, or it would pass with no guard at all.
    expect(store.database.query(`SELECT id FROM "ks"`).all()).toEqual([{ id: "k_1" }]);
  });

  test("a case-variant name is the same table, so it is the same binding", () => {
    const store = createStore();
    store.collection("ks", z.object({ id: ref("k") })).insert({ id: "k_1" });
    // SQLite identifiers are case-insensitive: CREATE TABLE IF NOT EXISTS "KS"
    // resolves to the existing "ks", so a registry keyed on the exact string
    // would think these are two tables while the database knows they are one.
    expect(() =>
      store.collection("KS", z.object({ slug: ref("k") }), { idField: "slug" }),
    ).toThrow(/collection\("KS" \(same table as "ks"\)\): already open with idField "id"/);
    expect(store.database.query(`SELECT id FROM "ks"`).all()).toEqual([{ id: "k_1" }]);
    // A case-variant reopen that agrees on idField is still just a reopen.
    expect(store.collection("KS", z.object({ id: ref("k") })).get("k_1")).toEqual({ id: "k_1" });
  });

  test("the registry is shared by both entry points", () => {
    const store = createStore();
    store.collection("ks", z.object({ id: ref("k") }));
    // createCollection is exported directly and takes a bare Database, so the
    // bindings hang off the Database rather than off the store's closure —
    // neither entry point can be used to get around the other.
    expect(() =>
      createCollection(store.database, "ks", z.object({ slug: ref("k") }), { idField: "slug" }),
    ).toThrow(/already open with idField "id"/);
  });

  // The registry lives in memory, so a second connection to the same file does
  // not see it and the conflicting reopen is accepted there. That is the
  // residual F018 tracks, pinned here so closing it fails this test rather than
  // slipping through: this asserts what currently happens, not what should.
  // It has to be one file opened twice — two independent stores share no table
  // and no binding, so they would agree whether or not the residual existed.
  test("a second connection does not yet see the binding (F018 residual)", () => {
    withTemporaryDirectory((databasePath) => {
      const first = createStore({ path: databasePath });
      first.collection("ks", z.object({ id: ref("k") })).insert({ id: "k_1" });
      first.close();

      const second = createStore({ path: databasePath });
      second
        .collection("ks", z.object({ slug: ref("k") }), { idField: "slug" })
        .insert({ slug: "k_2" });
      // F013's evidence, surviving a close: one table, two identity conventions,
      // and no complaint. Closing F018 makes this reopen throw, which fails here.
      expect(second.database.query(`SELECT id FROM "ks"`).all()).toEqual([
        { id: "k_1" },
        { id: "k_2" },
      ]);
      second.close();
    });
  });

  test("reopening with an extended schema and the same idField stays legal", () => {
    const store = createStore();
    const version1 = store.collection("people", z.object({ id: ref("user"), name: z.string().default("") }));
    version1.insert({ id: "user_legacy", name: "Legacy" });
    const version2 = store.collection(
      "people",
      z.object({
        id: ref("user"),
        name: z.string().default(""),
        role: z.enum(["admin", "member"]).default("member"),
      }),
    );
    expect(version2.get("user_legacy")?.role).toBe("member");
    // A non-default idField reopens under itself just as freely.
    const keyed = store.collection("keyed", z.object({ key: z.string() }), { idField: "key" });
    keyed.insert({ key: "k_1" });
    expect(
      store.collection("keyed", z.object({ key: z.string(), tag: z.string().default("") }), {
        idField: "key",
      }).get("k_1"),
    ).toEqual({ key: "k_1", tag: "" });
  });

  test("indexes are cumulative across handles, as documented", () => {
    const store = createStore();
    const NotesV1 = z.object({ id: ref("n"), status: z.string().default("") });
    store.collection("notes", NotesV1, { indexes: ["status"] });
    store.collection("notes", NotesV1.extend({ owner: z.string().default("") }), {
      indexes: ["owner"],
    });
    const indexNames = (
      store.database
        .query(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'notes'`)
        .all() as Array<{ name: string }>
    ).map((index) => index.name);
    // The second handle's index joins the first rather than replacing it —
    // which is what a reopen with an extended schema needs.
    expect(indexNames).toContain("idx_notes_status");
    expect(indexNames).toContain("idx_notes_owner");
  });
});

describe("compileWhere — unit", () => {
  test("empty where yields an empty clause", () => {
    expect(compileWhere(undefined)).toEqual({ sql: "", parameters: [] });
    expect(compileWhere({})).toEqual({ sql: "", parameters: [] });
  });

  test("rejects a non-identifier field path (injection guard)", () => {
    expect(() => compileWhere({ "name); DROP TABLE users;--": "x" })).toThrow();
  });

  test("the injection guard reaches inside the combinators (F012)", () => {
    // The widened key space is exactly the reserved keys plus what
    // FIELD_PATH_PATTERN already accepted — a nested branch is no way around it.
    expect(() => compileWhere({ OR: [{ "name); DROP TABLE users;--": "x" }] })).toThrow();
    expect(() => compileWhere({ NOT: { "doc') = 1 OR json_extract(doc, '$.x": 1 } })).toThrow();
    expect(() => compileWhere({ OR: [{ NOT: { "a-b": 1 } }] })).toThrow();
  });

  test("OR joins its branches and binds their parameters in order (F012)", () => {
    expect(compileWhere({ OR: [{ name: "a" }, { age: { gt: 3 } }] })).toEqual({
      sql:
        "WHERE (json_extract(doc, '$.name') = ? OR json_extract(doc, '$.age') > ?)",
      parameters: ["a", 3],
    });
    expect(compileWhere({ NOT: { name: "a" } })).toEqual({
      sql: "WHERE NOT (json_extract(doc, '$.name') = ?)",
      parameters: ["a"],
    });
  });

  test("an empty combinator resolves to a constant rather than vanishing (F012)", () => {
    // Every empty case fails closed: an empty disjunction matches nothing, as an
    // empty `in` does; an empty branch matches nothing rather than everything;
    // NOT of a clause with no conditions negates "everything".
    expect(compileWhere({ OR: [] })).toEqual({ sql: "WHERE 0", parameters: [] });
    expect(compileWhere({ OR: [{}] })).toEqual({ sql: "WHERE (0)", parameters: [] });
    expect(compileWhere({ OR: [{ name: undefined }, { age: 1 }] })).toEqual({
      sql: "WHERE (0 OR json_extract(doc, '$.age') = ?)",
      parameters: [1],
    });
    expect(compileWhere({ NOT: {} })).toEqual({ sql: "WHERE NOT (1)", parameters: [] });
  });

  test("an absent value compiles to a no-match, never to a vanished clause (F022)", () => {
    // Each of these produced `{ sql: "" }`, which every call site reads as "no
    // filter at all" — a bare `DELETE FROM` once it reaches deleteMany.
    expect(compileWhere({ name: undefined })).toEqual({ sql: "WHERE 0", parameters: [] });
    expect(compileWhere({ name: { eq: undefined } })).toEqual({ sql: "WHERE 0", parameters: [] });
    // A surviving sibling does not rescue the clause: partial widening is still
    // widening, and it is the shape a half-populated filter object actually has.
    expect(compileWhere({ name: "a", age: undefined })).toEqual({
      sql: "WHERE json_extract(doc, '$.name') = ? AND 0",
      parameters: ["a"],
    });
    // Absence survives negation rather than flipping into `NOT (0)` — every row.
    expect(compileWhere({ NOT: { name: undefined } })).toEqual({ sql: "WHERE 0", parameters: [] });
    // A disjunction with one live branch stays a usable filter in positive
    // position — the absence rule must not leak out through a real alternative.
    expect(compileWhere({ OR: [{ name: undefined }, { age: 1 }] })).toEqual({
      sql: "WHERE (0 OR json_extract(doc, '$.age') = ?)",
      parameters: [1],
    });
    // ...but negating it may not, because the branch that narrowed the
    // disjunction widens its complement by exactly the rows it excluded.
    expect(compileWhere({ NOT: { OR: [{ name: undefined }, { age: 1 }] } })).toEqual({
      sql: "WHERE 0",
      parameters: [],
    });
    expect(compileWhere({ NOT: { OR: [{ name: undefined }] } })).toEqual({
      sql: "WHERE 0",
      parameters: [],
    });
    // Depth is not laundering: the gap reaches the negation from anywhere below.
    expect(compileWhere({ NOT: { OR: [{ NOT: { name: undefined } }, { age: 1 }] } })).toEqual({
      sql: "WHERE 0",
      parameters: [],
    });
    // An *explicit* empty disjunction decided "no rows" — nothing went missing,
    // so negating it is still a decided "every row".
    expect(compileWhere({ NOT: { OR: [] } })).toEqual({
      sql: "WHERE NOT (0)",
      parameters: [],
    });
  });

  test("a malformed combinator fails loudly (F012)", () => {
    expect(() => compileWhere({ OR: { name: "a" } })).toThrow(
      /"OR" expects an array of where-clauses/,
    );
    expect(() => compileWhere({ OR: ["name"] })).toThrow(
      /"OR" expects an array of where-clauses/,
    );
    expect(() => compileWhere({ NOT: [{ name: "a" }] })).toThrow(
      /"NOT" expects a single where-clause/,
    );
  });

  test("a malformed in / notIn operand names the operator (F019)", () => {
    // A string has a `.length`, so it walked past the empty-list branch and
    // died on `.map` — an opaque TypeError from inside the compiler.
    expect(() => compileWhere({ age: { in: "abc" } })).toThrow(
      /Operator "in" expects an array operand, got string/,
    );
    expect(() => compileWhere({ age: { notIn: 5 } })).toThrow(
      /Operator "notIn" expects an array operand, got number/,
    );
    // `typeof null` is "object", which is the least useful answer here.
    expect(() => compileWhere({ age: { in: null } })).toThrow(
      /Operator "in" expects an array operand, got null/,
    );
    expect(() => compileWhere({ name: { contains: null } })).toThrow(
      /Operator "contains" expects a string operand, got null/,
    );
    // A well-formed list is untouched, empty one included.
    expect(compileWhere({ age: { in: [1, 2] } })).toEqual({
      sql: "WHERE json_extract(doc, '$.age') IN (?, ?)",
      parameters: [1, 2],
    });
    expect(compileWhere({ age: { notIn: [] } })).toEqual({ sql: "WHERE 1", parameters: [] });
  });
});

describe("ref helper", () => {
  test("validates the prefix and rejects an empty one", () => {
    const schema = ref("user");
    expect(schema.parse("user_123")).toBe("user_123");
    expect(() => schema.parse("post_123")).toThrow();
    expect(() => ref("")).toThrow();
  });
});

describe("store pragmas", () => {
  function readPragma(store: ReturnType<typeof createStore>, pragma: string): unknown {
    const row = store.database.query(`PRAGMA ${pragma}`).get() as Record<string, unknown> | null;
    return row === null ? null : Object.values(row)[0];
  }

  // F001 — the pragma this library was ported without. Its absence costs ~129x
  // on autocommit writes, and no test caught the drop; this one does.
  test("a default store runs at synchronous = NORMAL (1), not FULL (2)", () => {
    withTemporaryDirectory((databasePath) => {
      const store = createStore({ path: databasePath });
      expect(readPragma(store, "synchronous")).toBe(1);
      store.close();
    });
  });

  // F014 — each pragma is its own option and each defaults to the safe value.
  test("a default store is WAL, synchronous NORMAL, and busy_timeout 5000", () => {
    withTemporaryDirectory((databasePath) => {
      const store = createStore({ path: databasePath });
      expect(readPragma(store, "journal_mode")).toBe("wal");
      expect(readPragma(store, "synchronous")).toBe(1);
      expect(readPragma(store, "busy_timeout")).toBe(5000);
      store.close();
    });
  });

  test("each option overrides only its own pragma", () => {
    withTemporaryDirectory((databasePath) => {
      const stricter = createStore({ path: databasePath, synchronous: "FULL" });
      expect(readPragma(stricter, "synchronous")).toBe(2);
      expect(readPragma(stricter, "journal_mode")).toBe("wal");
      expect(readPragma(stricter, "busy_timeout")).toBe(5000);
      stricter.close();

      const rolledBack = createStore({ path: databasePath, journalMode: "DELETE" });
      expect(rolledBack.database.query("PRAGMA journal_mode").get()).toEqual({
        journal_mode: "delete",
      });
      expect(readPragma(rolledBack, "synchronous")).toBe(1);
      expect(readPragma(rolledBack, "busy_timeout")).toBe(5000);
      rolledBack.close();

      const patient = createStore({ path: databasePath, busyTimeoutMs: 250 });
      expect(readPragma(patient, "busy_timeout")).toBe(250);
      expect(readPragma(patient, "synchronous")).toBe(1);
      patient.close();
    });
  });

  test("an invalid pragma value is rejected before it reaches SQLite", () => {
    expect(() => createStore({ synchronous: "MAYBE" as never })).toThrow(
      "Invalid synchronous",
    );
    expect(() => createStore({ journalMode: "constructor" as never })).toThrow(
      "Invalid journalMode",
    );
    expect(() => createStore({ busyTimeoutMs: -1 })).toThrow("Invalid busyTimeoutMs");
    expect(() => createStore({ busyTimeoutMs: 1.5 })).toThrow("Invalid busyTimeoutMs");
  });

  // A busyTimeoutMs above int32 is parsed by SQLite as 0 — "give up
  // immediately", the inversion of what the caller asked for. Rejecting it is
  // the only answer that fails in the safe direction.
  test("a busy timeout SQLite cannot represent is rejected, not silently zeroed", () => {
    withTemporaryDirectory((databasePath) => {
      const atCeiling = createStore({ path: databasePath, busyTimeoutMs: 2_147_483_647 });
      expect(readPragma(atCeiling, "busy_timeout")).toBe(2_147_483_647);
      atCeiling.close();

      for (const overCeiling of [2_147_483_648, 5_000_000_000, Number.MAX_SAFE_INTEGER]) {
        expect(() => createStore({ path: databasePath, busyTimeoutMs: overCeiling })).toThrow(
          "Invalid busyTimeoutMs",
        );
      }
      // 1e21 stringifies as "1e+21"; SQLite would read the leading 1 and wait a
      // single millisecond. `Number.isInteger(1e21)` is true, so it is the range
      // clause — not the integer clause — that catches it.
      expect(() => createStore({ path: databasePath, busyTimeoutMs: 1e21 })).toThrow(
        "Invalid busyTimeoutMs",
      );
    });
  });

  // A pragma can fail when applied even though its value is valid. The handle
  // is open by then; leaking it exhausts descriptors in a long-running process
  // that opens many stores.
  test.skipIf(!existsSync("/proc/self/fd"))(
    "a pragma that fails when applied closes the handle instead of leaking it",
    () => {
      withTemporaryDirectory((databasePath) => {
        // A DELETE-mode file with a write transaction open: the default WAL
        // conversion cannot get the lock, and SQLite runs no busy handler for a
        // journal-mode change, so every createStore here throws.
        const holder = new Database(databasePath);
        holder.run("PRAGMA journal_mode = DELETE");
        holder.run("CREATE TABLE holder (id TEXT)");
        holder.run("BEGIN IMMEDIATE");
        holder.run("INSERT INTO holder VALUES ('x')");

        const countOpenDescriptors = () => readdirSync("/proc/self/fd").length;
        const before = countOpenDescriptors();
        let attempts = 0;
        for (let index = 0; index < 20; index++) {
          expect(() => createStore({ path: databasePath })).toThrow();
          attempts++;
        }
        expect(attempts).toBe(20);
        // Without the close-on-failure path this grows by one per attempt.
        expect(countOpenDescriptors() - before).toBeLessThanOrEqual(2);

        holder.run("ROLLBACK");
        holder.close();
      });
    },
  );

  // F004 — a blocked writer waits for its configured timeout instead of
  // throwing "database is locked" the instant it finds the lock held.
  test("a blocked writer waits for busy_timeout before giving up", () => {
    withTemporaryDirectory((databasePath) => {
      const busyTimeoutMs = 400;
      const holder = createStore({ path: databasePath });
      const blocked = createStore({ path: databasePath, busyTimeoutMs });
      const holderUsers = holder.collection("users", UserSchema);
      const blockedUsers = blocked.collection("users", UserSchema);

      expect(readPragma(blocked, "busy_timeout")).toBe(busyTimeoutMs);

      holder.database.run("BEGIN IMMEDIATE");
      holderUsers.insert({ id: "user_holder" });

      const started = Bun.nanoseconds();
      expect(() => blockedUsers.insert({ id: "user_blocked" })).toThrow(/locked|busy/i);
      const waitedMs = (Bun.nanoseconds() - started) / 1e6;

      // Waited rather than failed instantly. The upper bound is generous: the
      // point is the wait happened, not its precision.
      expect(waitedMs).toBeGreaterThanOrEqual(busyTimeoutMs * 0.7);
      expect(waitedMs).toBeLessThan(busyTimeoutMs * 5);

      holder.database.run("ROLLBACK");
      blocked.close();
      holder.close();
    });
  });
});

describe("the write gate", () => {
  function storedText(store: ReturnType<typeof createStore>, table: string, id: string): string {
    const row = store.database
      .query(`SELECT doc FROM "${table}" WHERE id = ?`)
      .get(id) as { doc: string } | null;
    if (row === null) throw new Error(`no row ${id} in ${table}`);
    return row.doc;
  }

  // F015 — a field with no default is dropped from the stored JSON by
  // JSON.stringify, so the row's key set silently varies row to row. The schema
  // is refused when the collection is created, where the mistake was made.
  describe("declared defaults", () => {
    test("a field with no default is refused, naming the field", () => {
      const store = createStore();
      expect(() =>
        store.collection("opts", z.object({ id: ref("o"), note: z.string().optional() })),
      ).toThrow(/field "note" has no default/);
      // .optional() is not a default: its value is undefined, which JSON.stringify
      // omits outright. Neither is a bare required field.
      expect(() =>
        store.collection("opts", z.object({ id: ref("o"), note: z.string() })),
      ).toThrow(/field "note" has no default/);
    });

    test("the same field with a default is accepted and stores an explicit null", () => {
      const store = createStore();
      const opts = store.collection(
        "opts",
        z.object({ id: ref("o"), note: z.string().nullable().default(null) }),
      );
      expect(opts.insert({ id: "o_1" })).toEqual({ id: "o_1", note: null });
      expect(storedText(store, "opts", "o_1")).toBe('{"id":"o_1","note":null}');
    });

    test("identity fields are the exception — the id field and every ref()", () => {
      const store = createStore();
      // A ref() foreign key carries no default by design, and neither does the
      // id field, whatever it is named.
      const keyed = store.collection(
        "keyed",
        z.object({ key: z.string(), ownerId: ref("user"), title: z.string().default("") }),
        { idField: "key" },
      );
      expect(keyed.insert({ key: "k_1", ownerId: "user_a" }).title).toBe("");
    });

    // The walk is one level deep by design: a nested object must itself declare
    // a default, but its members are not checked. This pins that boundary so the
    // limit stays a known one rather than an assumed fix.
    test("the walk is one level deep — a nested member without a default is not caught", () => {
      const store = createStore();
      const nested = store.collection(
        "nested",
        z.object({
          id: ref("n"),
          meta: z.object({ note: z.string().optional() }).default({}),
        }),
      );
      nested.insert({ id: "n_1" });
      // The known limit: `note` is dropped from storage exactly as F015 describes,
      // one level down. Recursing would need Zod internals to unwrap `.default()`,
      // which `hasDeclaredDefault` deliberately avoids for the ^3 || ^4 peer range.
      expect(storedText(store, "nested", "n_1")).toBe('{"id":"n_1","meta":{}}');
      // The nested object itself is still held to the rule.
      expect(() =>
        store.collection("nested2", z.object({ id: ref("n"), meta: z.object({}) })),
      ).toThrow(/field "meta" has no default/);
    });

    test("the check is escapable and skips a non-object schema", () => {
      const store = createStore();
      const loose = store.collection(
        "loose",
        z.object({ id: ref("l"), note: z.string().optional() }),
        { enforceDefaults: false },
      );
      expect(loose.insert({ id: "l_1" })).toEqual({ id: "l_1" });
      // A schema with no shape to walk is skipped rather than refused.
      const records = store.collection("records", z.record(z.string(), z.string()));
      expect(records.insert({ id: "r_1", note: "kept" }).note).toBe("kept");
    });
  });

  // F003 — a z.date() field passed the gate on the way in and was rejected by
  // the same schema on the way out, leaving a row no read could ever return.
  describe("JSON round-trip (F003)", () => {
    const EventSchema = z.object({ id: ref("evt"), at: z.date().default(new Date(0)) });

    test("a z.date() field is refused at the write, not at the read", () => {
      const store = createStore();
      const events = store.collection("events", EventSchema);
      expect(() => events.insert({ id: "evt_1", at: new Date("2020-01-01T00:00:00Z") })).toThrow(
        /Collection "events": document does not survive a JSON round-trip/,
      );
      // Nothing was committed, so no unreadable row is left behind.
      expect(events.count()).toBe(0);
      expect(() => events.upsert({ id: "evt_2" })).toThrow(/does not survive a JSON round-trip/);
      expect(events.count()).toBe(0);
    });

    test("dateParser inserts, reads back a Date, and is stable across reads", () => {
      const store = createStore();
      const events = store.collection(
        "events",
        z.object({ id: ref("evt"), at: dateParser.default(() => new Date(0)) }),
      );
      const at = new Date("2020-01-01T00:00:00.000Z");
      expect(events.insert({ id: "evt_1", at }).at).toEqual(at);
      expect(storedText(store, "events", "evt_1")).toBe(
        '{"id":"evt_1","at":"2020-01-01T00:00:00.000Z"}',
      );

      // Two consecutive reads return the same Date — the F002 property.
      expect(events.get("evt_1")?.at).toEqual(at);
      expect(events.get("evt_1")?.at).toEqual(at);
      expect(events.get("evt_1")?.at).toBeInstanceOf(Date);
      expect(storedText(store, "events", "evt_1")).toBe(
        '{"id":"evt_1","at":"2020-01-01T00:00:00.000Z"}',
      );
    });

    // A date under a field the schema does not type as one serialises to a
    // string the schema accepts, so the stored bytes are a fixed point while the
    // *value* is not: the gate compares types, not bytes.
    test("a value whose type changes across the round-trip is refused", () => {
      const store = createStore();
      const cases = store.collection(
        "cases",
        z.object({ id: ref("c"), meta: z.record(z.string(), z.unknown()).default({}) }),
      );
      const openedAt = new Date("2020-01-01T00:00:00Z");

      // Pre-fix (a byte comparison) this was accepted, and `get()` then returned
      // meta.openedAt as a String — not equal to what was written, nor its type.
      expect(() => cases.insert({ id: "c_1", meta: { openedAt } })).toThrow(
        /is not stable across a JSON round-trip/,
      );
      // "meta" is declared and names itself; "openedAt" is a key inside a
      // z.record(), which the schema does not declare, so it is elided — under
      // a record the key is document content and naming it leaks the document.
      expect(() => cases.insert({ id: "c_1", meta: { openedAt } })).toThrow(/"meta\.<key>"/);
      expect(cases.count()).toBe(0);

      // A union with a string branch is the same trap: Date in, String out.
      const unions = store.collection(
        "unions",
        z.object({ id: ref("u"), when: z.union([z.string(), z.date()]).default("") }),
      );
      expect(() => unions.insert({ id: "u_1", when: openedAt })).toThrow(
        /is not stable across a JSON round-trip/,
      );

      // Stored as what it reads back as, the same field is fine.
      const stored = cases.insert({ id: "c_2", meta: { openedAt: openedAt.toISOString() } });
      expect(stored.meta).toEqual({ openedAt: "2020-01-01T00:00:00.000Z" });
      expect(cases.get("c_2")?.meta).toEqual({ openedAt: "2020-01-01T00:00:00.000Z" });
    });
  });

  // F002 — reads re-parse the stored JSON, so a schema whose parse rewrites an
  // already-parsed value drifted on every read and doubled on every update:
  // 1 → 3 → 5 → 6 over one insert, two updates and a get.
  describe("parse idempotence (F002)", () => {
    test("a value-changing transform is refused instead of drifting", () => {
      const store = createStore();
      const ups = store.collection(
        "ups",
        z.object({
          id: ref("u"),
          name: z.string().default("").transform((value) => value.toUpperCase()),
          seen: z.number().default(0).transform((value) => value + 1),
        }),
      );
      expect(() => ups.insert({ id: "u_1", name: "bob", seen: 0 })).toThrow(
        /Collection "ups": document is not stable across a JSON round-trip/,
      );
      expect(ups.count()).toBe(0);
    });

    test("a stable schema does not drift across updates or reads", () => {
      const store = createStore();
      // An idempotent transform and a coercion both survive the gate: parsing
      // their own stored form returns it unchanged.
      const ups = store.collection(
        "ups",
        z.object({
          id: ref("u"),
          name: z.string().default("").transform((value) => value.toUpperCase()),
          seen: z.coerce.number().default(0),
        }),
      );

      expect(ups.insert({ id: "u_1", name: "bob", seen: "1" }).seen).toBe(1);
      const afterInsert = storedText(store, "ups", "u_1");

      expect(ups.update("u_1", {})?.seen).toBe(1);
      expect(ups.update("u_1", {})?.seen).toBe(1);
      expect(ups.get("u_1")?.seen).toBe(1);
      expect(ups.get("u_1")?.name).toBe("BOB");
      // The stored bytes are the same after two updates and a read as they were
      // after the insert — a read is pure, and an update applies its patch once.
      expect(storedText(store, "ups", "u_1")).toBe(afterInsert);
    });

    test("update merges into the stored document, not into a parsed read", () => {
      const { users } = freshUsers();
      users.insert({ id: "user_m", name: "M", age: 20 });
      expect(users.update("user_m", { age: 21 })).toEqual({
        id: "user_m",
        name: "M",
        age: 21,
        active: true,
        nickname: null,
      });
      expect(users.get("user_m")?.age).toBe(21);
    });

    // The merge-source half of F002, which is a bug under any schema: parsed
    // output is `z.output` and feeding it back as `z.input` re-runs the schema
    // over it. Here the two differ — input is a string, output a `Date` — so
    // merging into a parsed read feeds a `Date` into `z.string()` and throws.
    test("a schema whose input and output differ survives an update", () => {
      const store = createStore();
      const entries = store.collection(
        "entries",
        z.object({
          id: ref("e"),
          at: z
            .string()
            .default("1970-01-01T00:00:00.000Z")
            .transform((iso) => new Date(iso)),
          note: z.string().default(""),
        }),
      );

      entries.insert({ id: "e_1", at: "2020-01-01T00:00:00.000Z", note: "first" });
      const updated = entries.update("e_1", { note: "second" });
      expect(updated?.note).toBe("second");
      expect(updated?.at).toBeInstanceOf(Date);
      expect(updated?.at).toEqual(new Date("2020-01-01T00:00:00.000Z"));
      expect(storedText(store, "entries", "e_1")).toBe(
        '{"id":"e_1","at":"2020-01-01T00:00:00.000Z","note":"second"}',
      );
    });

    // The write gate refuses documents, so its message is a place document
    // content could leak. It names paths and never values, so an uncaught throw
    // here cannot land whole documents in a server log.
    test("the refusal names field paths, never document values", () => {
      const store = createStore();
      const drifts = store.collection(
        "drifts",
        z.object({
          id: ref("d"),
          name: z.string().default(""),
          nationalId: z.string().default(""),
          seen: z.number().default(0).transform((value) => value + 1),
        }),
      );

      let message = "";
      try {
        drifts.insert({ id: "d_1", name: "Jane Doe", nationalId: "DE-1234567890", seen: 0 });
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toMatch(/is not stable across a JSON round-trip/);
      expect(message).toContain('"seen"');
      expect(message).not.toContain("Jane Doe");
      expect(message).not.toContain("DE-1234567890");
    });

    // Under a record the key is document content too — a consents map keyed by
    // person is the natural shape for it, so a key printed verbatim leaks
    // exactly what the message promises it does not.
    // Only keys the schema declares are field names a developer wrote.
    test("a record's keys are values too, so they are elided, not named", () => {
      const store = createStore();
      const drifting = () => z.number().default(0).transform((value) => value + 1);
      const consents = store.collection(
        "consents",
        z.object({
          id: ref("c"),
          byDataSubject: z.record(z.string(), drifting()).default({}),
        }),
      );

      let message = "";
      try {
        consents.insert({
          id: "c_1",
          byDataSubject: { "jane.doe@example.com": 0, "DE-1234567890": 0 },
        });
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toMatch(/is not stable across a JSON round-trip/);
      expect(message).not.toContain("jane.doe@example.com");
      expect(message).not.toContain("DE-1234567890");
      // The declared field still names itself, so the message stays diagnostic,
      // and the undeclared keys collapse to one elided segment rather than one
      // per key — which would publish how many subjects the document held.
      expect(message).toContain('"byDataSubject.<key>"');
      expect(message).toContain("field ");
      expect(message).not.toContain("fields ");

      // The other half of the trade: eliding must not swallow keys the schema
      // *does* declare. Every non-identity field carries a .default(...), so a
      // nested object is always seen through a wrapper — if those
      // are not peeled, every nested path collapses to "<key>" and the message
      // stops diagnosing anything.
      const shapes = store.collection(
        "shapes",
        z.object({
          id: ref("s"),
          profile: z.object({ seen: drifting() }).default({ seen: 0 }),
          tags: z.array(z.object({ seen: drifting() })).default([]),
          maybe: z.object({ seen: drifting() }).nullable().default(null),
        }),
      );

      let nested = "";
      try {
        shapes.insert({ id: "s_1", profile: { seen: 0 }, tags: [{ seen: 0 }], maybe: { seen: 0 } });
      } catch (error) {
        nested = (error as Error).message;
      }

      expect(nested).toContain('"profile.seen"');
      expect(nested).toContain('"tags[0].seen"');
      expect(nested).toContain('"maybe.seen"');
      expect(nested).not.toContain("<key>");
    });

    test("a rejected id is reported by type, never by value", () => {
      const store = createStore();
      // An id is document content like any other field — a customer number here.
      // The gate has to say enough to diagnose the mistake and no more.
      const accounts = store.collection(
        "accounts",
        z.object({ id: z.number().default(0), note: z.string().default("") }),
      );

      let message = "";
      try {
        accounts.insert({ id: 4711992 });
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toContain('Collection "accounts"');
      expect(message).toContain('"id"');
      expect(message).toContain("a number");
      expect(message).not.toContain("4711992");

      // The empty-string case is the other way in, and says which it was.
      const strings = store.collection("strings", z.object({ id: z.string().default("") }));
      expect(() => strings.insert({ id: "" })).toThrow(/an empty string/);
    });
  });

  // F005 — update() was a SELECT and an UPDATE with no lock between them, so a
  // second connection could commit in the gap and have its change overwritten
  // without an error, a conflict, or a trace.
  test("a concurrent writer's committed change is never silently overwritten", () => {
    withTemporaryDirectory((databasePath) => {
      // The hook fires from inside Zod, i.e. from inside update()'s parse —
      // between its read of the row and its write of the merged document.
      let interleave: (() => void) | null = null;
      const CounterSchema = z
        .object({ id: ref("x"), n: z.number().default(0), label: z.string().default("") })
        .refine(() => {
          const hook = interleave;
          interleave = null; // fire once, and keep the other writer's own parses out
          hook?.();
          return true;
        });

      const writerA = createStore({ path: databasePath });
      // A short timeout keeps the test quick; the contending writer only has to
      // find the lock held, not wait out a realistic one.
      const writerB = createStore({ path: databasePath, busyTimeoutMs: 50 });
      const countersA = writerA.collection("counters", CounterSchema);
      const countersB = writerB.collection("counters", CounterSchema);
      countersA.upsert({ id: "x_9", n: 0, label: "" });

      let concurrentCommitted = false;
      let concurrentError: unknown = null;
      interleave = () => {
        try {
          countersB.update("x_9", { n: 100 });
          concurrentCommitted = true;
        } catch (error) {
          concurrentError = error;
        }
      };

      countersA.update("x_9", { label: "a" });
      const stored = countersA.get("x_9");

      // Pre-fix, B's n = 100 committed in the gap and A's UPDATE — built from a
      // read taken before B ran — erased it, leaving n = 0 and B none the wiser.
      expect(concurrentCommitted && stored?.n === 0).toBe(false);
      // A holds the write lock across its whole read-modify-write, so B is
      // serialised out and fails loudly rather than losing its write.
      expect(concurrentCommitted).toBe(false);
      expect(String(concurrentError)).toMatch(/locked|busy/i);
      expect(stored).toEqual({ id: "x_9", n: 0, label: "a" });

      writerB.close();
      writerA.close();
    });
  });
});

describe("WAL checkpoint", () => {
  test("TRUNCATE drains the WAL and removes the sidecar on close", () => {
    const directory = mkdtempSync(join(tmpdir(), "docstore-wal-"));
    const databasePath = join(directory, "wal.sqlite");
    const walPath = `${databasePath}-wal`;

    const store = createStore({ path: databasePath });
    const users = store.collection("users", UserSchema);
    for (let index = 0; index < 200; index++) {
      users.insert({ id: `user_${index}`, name: `n${index}`.repeat(200) });
    }
    expect(existsSync(walPath)).toBe(true);

    const truncated = store.checkpoint("TRUNCATE");
    expect(truncated.busy).toBe(0);
    expect(truncated.log).toBe(0);
    expect(statSync(walPath).size).toBe(0);

    // A clean close checkpoints and deletes the sidecar outright.
    store.close();
    expect(existsSync(walPath)).toBe(false);

    rmSync(directory, { recursive: true, force: true });
  });

  test("defaults to PASSIVE and rejects an unknown mode", () => {
    // An in-memory database has no WAL, so SQLite answers with -1 frame counts
    // rather than failing — the call is still safe to make unconditionally.
    const store = createStore();
    expect(store.checkpoint()).toEqual({ busy: 0, log: -1, checkpointed: -1 });
    expect(() => store.checkpoint("VACUUM" as never)).toThrow(
      "Invalid checkpoint mode",
    );
    // Resolved through the same own-property guard as the store pragmas, so an
    // inherited key is a rejection rather than a statement of type function.
    expect(() => store.checkpoint("constructor" as never)).toThrow(
      "Invalid checkpoint mode",
    );
  });
});

// F035 — an application whose data lives in more than one SQLite file has
// operations that write to both of them. `store.transaction` covers the one
// connection it was called on, and no ordering of the two writes makes the pair
// atomic.
describe("a transaction that spans two stores (F035)", () => {
  const OrderSchema = z.object({
    id: ref("ord"),
    sku: z.string().default(""),
  });
  const StockLevelSchema = z.object({
    id: ref("stk"),
    onHand: z.number().default(0),
  });

  function readJournalMode(store: DocStore): unknown {
    const row = store.database.query("PRAGMA journal_mode").get() as Record<string, unknown> | null;
    return row === null ? null : Object.values(row)[0];
  }

  function withOrdersAndInventory<TResult>(
    journalMode: "WAL" | "DELETE",
    work: (
      orders: DocStore,
      inventory: DocStore,
      paths: { ordersPath: string; inventoryPath: string },
    ) => TResult,
  ): TResult {
    return inTemporaryDirectory((directory) => {
      const ordersPath = join(directory, "orders.sqlite");
      const inventoryPath = join(directory, "inventory.sqlite");
      const orders = createStore({ path: ordersPath, journalMode });
      const inventory = createStore({ path: inventoryPath, journalMode });
      try {
        return work(orders, inventory, { ordersPath, inventoryPath });
      } finally {
        orders.close();
        inventory.close();
      }
    });
  }

  // The Evidence block of the finding, as an assertion. It documents what
  // `store.transaction` does and does not cover, and it must keep holding: the
  // fix adds a primitive beside it rather than changing what it means.
  test("store.transaction leaves the other store's write behind when it rolls back", () => {
    withOrdersAndInventory("WAL", (orders, inventory) => {
      const orderRows = orders.collection("orders", OrderSchema);
      const stockRows = inventory.collection("stockLevels", StockLevelSchema);

      expect(() =>
        orders.transaction(() => {
          orderRows.insert({ id: "ord_1" });
          stockRows.insert({ id: "stk_1" }); // other connection — outside this transaction
          throw new Error("follow-up write failed");
        }),
      ).toThrow("follow-up write failed");

      // The half that was inside the transaction is gone; the half that was
      // never in it survives. Reversing the order only swaps which one survives.
      expect(orderRows.count()).toBe(0);
      expect(stockRows.count()).toBe(1);
    });
  });

  // Both journal modes, because the guarantee differs between them and only one
  // half of that difference is reachable from a test — see the DELETE-mode test
  // below.
  for (const journalMode of ["WAL", "DELETE"] as const) {
    test(`transactionAcross rolls both files back on a throw (journalMode: ${journalMode})`, () => {
      withOrdersAndInventory(journalMode, (orders, inventory) => {
        const orderRows = orders.collection("orders", OrderSchema);
        const stockRows = inventory.collection("stockLevels", StockLevelSchema);

        expect(() =>
          transactionAcross([orders, inventory], ([ordersTx, inventoryTx]) => {
            ordersTx.collection("orders", OrderSchema).insert({ id: "ord_1" });
            inventoryTx.collection("stockLevels", StockLevelSchema).insert({ id: "stk_1" });
            throw new Error("follow-up write failed");
          }),
        ).toThrow("follow-up write failed");

        expect(orderRows.count()).toBe(0);
        expect(stockRows.count()).toBe(0);
      });
    });

    test(`transactionAcross commits both files on return (journalMode: ${journalMode})`, () => {
      withOrdersAndInventory(journalMode, (orders, inventory) => {
        const orderRows = orders.collection("orders", OrderSchema);
        const stockRows = inventory.collection("stockLevels", StockLevelSchema);

        const orderId = transactionAcross(
          [orders, inventory],
          ([ordersTx, inventoryTx]) => {
            inventoryTx.collection("stockLevels", StockLevelSchema).insert({ id: "stk_1" });
            return ordersTx
              .collection("orders", OrderSchema)
              .insert({ id: "ord_1" }).id;
          },
        );

        expect(orderId).toBe("ord_1");
        // Read back through each store's *own* connection: the rows are in the
        // files, not merely in the transaction's connection.
        expect(orderRows.get("ord_1")).toEqual({ id: "ord_1", sku: "" });
        expect(stockRows.get("stk_1")).toEqual({
          id: "stk_1",
          onHand: 0,
        });
      });
    });
  }

  // The documented limit, pinned. SQLite commits attached databases atomically
  // only when the journal mode is not WAL, so the crash window the API doc names
  // is a property of WAL specifically — and a test cannot reach it either way,
  // because it would have to kill the process between two file commits. What a
  // test *can* pin is that the non-WAL path really is non-WAL: both files, and
  // the connection the cross-store transaction runs on, stay in DELETE mode
  // rather than being silently converted to WAL by the store defaults. Without
  // that the atomic-commit path above would never be the one under test, and the
  // caveat would be describing a mode nothing exercises.
  test("the non-WAL path really is non-WAL, so the caveat names the only gap left", () => {
    withOrdersAndInventory("DELETE", (orders, inventory, { ordersPath, inventoryPath }) => {
      expect(readJournalMode(orders)).toBe("delete");
      expect(readJournalMode(inventory)).toBe("delete");

      transactionAcross([orders, inventory], ([ordersTx, inventoryTx]) => {
        inventoryTx.collection("stockLevels", StockLevelSchema).insert({ id: "stk_1" });
        ordersTx.collection("orders", OrderSchema).insert({ id: "ord_1" });
      });

      expect(orders.collection("orders", OrderSchema).count()).toBe(1);
      expect(inventory.collection("stockLevels", StockLevelSchema).count()).toBe(1);
      // Still DELETE afterwards, and no -wal sidecar beside either file: nothing
      // in the attach path converted a database the caveat says is exempt.
      expect(readJournalMode(orders)).toBe("delete");
      expect(readJournalMode(inventory)).toBe("delete");
      expect(existsSync(`${ordersPath}-wal`)).toBe(false);
      expect(existsSync(`${inventoryPath}-wal`)).toBe(false);
    });
  });

  // The property schema-qualification exists for. Two stores, one connection: a
  // write through the orders handle must land in orders.sqlite and nowhere
  // else. Unqualified table names would put both collections in `main`.
  test("each handle writes into its own file, never the other's", () => {
    withOrdersAndInventory("WAL", (orders, inventory) => {
      transactionAcross([orders, inventory], ([ordersTx, inventoryTx]) => {
        ordersTx.collection("orders", OrderSchema).insert({ id: "ord_1" });
        inventoryTx.collection("stockLevels", StockLevelSchema).insert({ id: "stk_1" });
      });

      const tablesIn = (store: DocStore): string[] =>
        (
          store.database
            .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .all() as Array<{ name: string }>
        ).map((row) => row.name);

      expect(tablesIn(orders)).toEqual(["orders"]);
      expect(tablesIn(inventory)).toEqual(["stockLevels"]);
    });
  });

  // A collection with the same name in both files is the case a shared table
  // binding would confuse: one connection, two `events` tables, two identity
  // conventions.
  test("same-named collections on two stores stay separate tables", () => {
    withOrdersAndInventory("WAL", (orders, inventory) => {
      const FromOrders = z.object({ id: ref("row"), source: z.string().default("orders") });
      const FromInventory = z.object({ eventKey: ref("evt"), source: z.string().default("inventory") });

      transactionAcross([orders, inventory], ([ordersTx, inventoryTx]) => {
        ordersTx.collection("events", FromOrders).insert({ id: "row_1" });
        inventoryTx
          .collection("events", FromInventory, { idField: "eventKey" })
          .insert({ eventKey: "evt_1" });
      });

      expect(orders.collection("events", FromOrders).get("row_1")?.source).toBe("orders");
      expect(
        inventory.collection("events", FromInventory, { idField: "eventKey" }).get("evt_1")?.source,
      ).toBe("inventory");
    });
  });

  // Indexes are declared per collection and must be created in the right file
  // too — SQLite qualifies an index by its own name, not by its table's.
  test("an index declared on an attached handle lands in that store's file", () => {
    withOrdersAndInventory("WAL", (orders, inventory) => {
      transactionAcross([orders, inventory], ([ordersTx, inventoryTx]) => {
        ordersTx.collection("orders", OrderSchema, { indexes: ["sku"] });
        inventoryTx.collection("stockLevels", StockLevelSchema, { indexes: ["onHand"] });
      });

      const indexesIn = (store: DocStore): string[] =>
        (
          store.database
            .query("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL")
            .all() as Array<{ name: string }>
        ).map((row) => row.name);

      expect(indexesIn(orders)).toEqual(["idx_orders_sku"]);
      expect(indexesIn(inventory)).toEqual(["idx_stockLevels_onHand"]);
    });
  });

  // The handles are the transaction, and the callback's outer scope still holds
  // the stores. A write through one of those would commit past the transaction —
  // exactly the defect this closes — so what happens instead matters: BEGIN
  // IMMEDIATE has taken the write lock on every file in the transaction, so the
  // outer write waits out its busy timeout and then fails loudly. It cannot
  // quietly land beside the transaction.
  test("a write through the outer store is locked out, not committed past the transaction", () => {
    inTemporaryDirectory((directory) => {
      const busyTimeoutMs = 200;
      const orders = createStore({ path: join(directory, "orders.sqlite"), busyTimeoutMs });
      const inventory = createStore({ path: join(directory, "inventory.sqlite"), busyTimeoutMs });
      try {
        const outerStockRows = inventory.collection("stockLevels", StockLevelSchema);

        expect(() =>
          transactionAcross([orders, inventory], ([ordersTx]) => {
            ordersTx.collection("orders", OrderSchema).insert({ id: "ord_1" });
            outerStockRows.insert({ id: "stk_outside" }); // inventory's own connection
          }),
        ).toThrow(/locked|busy/i);

        // Neither half is there: the outer write never got the lock, and the
        // throw it raised rolled the transaction back.
        expect(orders.collection("orders", OrderSchema).count()).toBe(0);
        expect(outerStockRows.count()).toBe(0);
      } finally {
        orders.close();
        inventory.close();
      }
    });
  });

  test("a handle kept past the transaction fails loudly instead of writing outside one", () => {
    withOrdersAndInventory("WAL", (orders, inventory) => {
      let escaped: ReturnType<typeof orders.collection<typeof OrderSchema>> | null = null;
      transactionAcross([orders, inventory], ([ordersTx]) => {
        escaped = ordersTx.collection("orders", OrderSchema);
      });
      expect(escaped).not.toBeNull();
      expect(() => (escaped as unknown as { insert(input: unknown): unknown }).insert({ id: "ord_late" })).toThrow();
      expect(orders.collection("orders", OrderSchema).count()).toBe(0);
    });
  });

  // The guard's orders hangs off the `Database` object, and this connection is
  // opened per call — so without carrying the bindings across it would start
  // empty every time and the idField check would be structurally unreachable
  // here, not merely weakened. The end state it lets through is one table under
  // two identity conventions, where delete-by-id answers `false` while the row
  // stays readable through find().
  test("a handle is held to the idField the store already pinned", () => {
    withOrdersAndInventory("WAL", (orders, inventory) => {
      const ById = z.object({ id: z.string() });
      const ByEmail = z.object({ email: z.string() });
      orders.collection("users", ById, { enforceDefaults: false });

      expect(() =>
        transactionAcross([orders, inventory], ([ordersTx]) => {
          ordersTx
            .collection("users", ByEmail, { enforceDefaults: false, idField: "email" })
            .insert({ email: "two@example.org" });
        }),
      ).toThrow('already open with idField "id", cannot reopen with "email"');

      // Nothing was written under the second convention.
      expect(orders.database.query("SELECT id FROM users").all()).toEqual([]);
    });
  });

  // The mirror, so the carry-over is symmetric: a table first opened inside a
  // transaction has pinned its convention for the store as well.
  test("a table first opened inside a transaction pins its idField for the store too", () => {
    withOrdersAndInventory("WAL", (orders, inventory) => {
      const BySlug = z.object({ slug: z.string() });
      const ById = z.object({ id: z.string() });

      transactionAcross([orders, inventory], ([, inventoryTx]) => {
        inventoryTx.collection("posts", BySlug, { enforceDefaults: false, idField: "slug" });
      });

      expect(() => inventory.collection("posts", ById, { enforceDefaults: false })).toThrow(
        'already open with idField "slug", cannot reopen with "id"',
      );
    });
  });

  describe("what it refuses", () => {
    test("no stores at all", () => {
      expect(() => transactionAcross([], () => null)).toThrow("no stores given");
    });

    // The dangerous one. `ATTACH ':memory:'` opens a *second*, empty in-memory
    // database rather than reaching the store's — every write would land in it
    // and be dropped at close, silently.
    test("an in-memory store, in any position", () => {
      withOrdersAndInventory("WAL", (orders) => {
        const ephemeral = createStore();
        try {
          expect(() => transactionAcross([orders, ephemeral], () => null)).toThrow(
            "the store at index 1 is in-memory",
          );
          expect(() => transactionAcross([ephemeral, orders], () => null)).toThrow(
            "the store at index 0 is in-memory",
          );
        } finally {
          ephemeral.close();
        }
      });
    });

    test("the same file twice", () => {
      inTemporaryDirectory((directory) => {
        const databasePath = join(directory, "orders.sqlite");
        const first = createStore({ path: databasePath });
        const second = createStore({ path: databasePath });
        try {
          expect(() => transactionAcross([first, second], () => null)).toThrow(
            "index 0 and 1 are the same file",
          );
          expect(() => transactionAcross([first, first], () => null)).toThrow(
            "index 0 and 1 are the same file",
          );
        } finally {
          first.close();
          second.close();
        }
      });
    });

    test("a store createStore() did not open", () => {
      withOrdersAndInventory("WAL", (orders) => {
        const impostor = { ...orders };
        expect(() => transactionAcross([orders, impostor], () => null)).toThrow(
          "the store at index 1 was not opened by createStore()",
        );
      });
    });

    // The same file reached through a symlink is one file to SQLite, so the
    // lexical path comparison missed it and left the caller with a bare
    // `database is locked` after the busy timeout instead of the named refusal.
    test("the same file reached through a symlink", () => {
      inTemporaryDirectory((directory) => {
        const realPath = join(directory, "orders.sqlite");
        const linkPath = join(directory, "orders-link.sqlite");
        const direct = createStore({ path: realPath });
        symlinkSync(realPath, linkPath);
        const viaSymlink = createStore({ path: linkPath });
        try {
          expect(() => transactionAcross([direct, viaSymlink], () => null)).toThrow(
            "index 0 and 1 are the same file",
          );
        } finally {
          direct.close();
          viaSymlink.close();
        }
      });
    });

    // SQLITE_LIMIT_ATTACHED is 10, and one store is the connection's own `main`.
    // Past the ceiling SQLite throws from the middle of the attach loop, naming
    // neither this function nor where the number comes from.
    test("more stores than SQLite can attach", () => {
      inTemporaryDirectory((directory) => {
        const stores = Array.from({ length: 12 }, (_unused, index) =>
          createStore({ path: join(directory, `store-${index}.sqlite`) }),
        );
        try {
          expect(() => transactionAcross(stores, () => null)).toThrow(
            "12 stores given, but SQLite attaches at most 10 databases",
          );
          // The ceiling itself is legal, so the refusal is not off by one.
          expect(transactionAcross(stores.slice(0, 11), () => "committed")).toBe("committed");
        } finally {
          for (const store of stores) store.close();
        }
      });
    });

    // The documented escape hatch is "open the stores with a journalMode other
    // than WAL". An attached database keeps the mode its own header says and the
    // weakest member decides the commit, so a mixed set hands back WAL's
    // guarantee to a caller who believes they took the hatch.
    test("a set whose journal modes disagree", () => {
      inTemporaryDirectory((directory) => {
        const rollback = createStore({
          path: join(directory, "orders.sqlite"),
          journalMode: "DELETE",
        });
        const writeAhead = createStore({ path: join(directory, "inventory.sqlite") });
        try {
          expect(() => transactionAcross([rollback, writeAhead], () => null)).toThrow(
            'the store at index 1 is in journalMode "WAL" but the store at index 0 is in "DELETE"',
          );
        } finally {
          rollback.close();
          writeAhead.close();
        }
      });
    });
  });
});

describe("a Date operand compares against the stored form (F029)", () => {
  const EventSchema = z.object({
    id: ref("evt"),
    at: dateParser.default(() => new Date(0)),
    kind: z.string().default(""),
  });

  function freshEvents() {
    const store = createStore();
    const events = store.collection("events", EventSchema);
    events.insert({ id: "evt_early", at: new Date("2026-01-01T00:00:00.000Z"), kind: "early" });
    events.insert({ id: "evt_mid", at: new Date("2026-06-01T12:30:00.000Z"), kind: "mid" });
    events.insert({ id: "evt_late", at: new Date("2026-12-31T23:59:59.000Z"), kind: "late" });
    return events;
  }

  test("range operators take a Date and answer chronologically", () => {
    const events = freshEvents();
    const between = events.find({
      where: {
        at: {
          gt: new Date("2026-01-01T00:00:00.000Z"),
          lt: new Date("2026-12-01T00:00:00.000Z"),
        },
      },
    });
    expect(between.map((event) => event.id)).toEqual(["evt_mid"]);
    expect(events.count({ at: { gte: new Date("2026-06-01T12:30:00.000Z") } })).toBe(2);
  });

  test("shorthand equality, in, and findOne take Dates", () => {
    const events = freshEvents();
    expect(events.findOne({ where: { at: new Date("2026-06-01T12:30:00.000Z") } })?.id).toBe(
      "evt_mid",
    );
    const listed = events.find({
      where: {
        at: {
          in: [new Date("2026-01-01T00:00:00.000Z"), new Date("2026-12-31T23:59:59.000Z")],
        },
      },
      orderBy: { field: "at" },
    });
    expect(listed.map((event) => event.id)).toEqual(["evt_early", "evt_late"]);
  });

  test("orderBy over a dateParser field is chronological, and reads return Dates", () => {
    const events = freshEvents();
    const ordered = events.find({ orderBy: { field: "at", direction: "desc" } });
    expect(ordered.map((event) => event.id)).toEqual(["evt_late", "evt_mid", "evt_early"]);
    expect(ordered[0]?.at).toBeInstanceOf(Date);
  });

  test("deleteMany takes a Date bound", () => {
    const events = freshEvents();
    expect(events.deleteMany({ at: { lt: new Date("2026-06-01T00:00:00.000Z") } })).toBe(1);
    expect(events.count()).toBe(2);
  });

  test("an invalid Date is refused naming the operator or field at fault", () => {
    const events = freshEvents();
    expect(() => events.find({ where: { at: { gt: new Date("nonsense") } } })).toThrow(
      'Invalid Date operand for operator "gt"',
    );
    expect(() => events.find({ where: { at: new Date("nonsense") } })).toThrow(
      'Invalid Date operand for field "at"',
    );
  });

  // Outside years 0000–9999 toISOString() switches to the expanded form, whose
  // leading sign sorts before every digit — a stored "+275760-…" row silently
  // matched `lt` any in-range bound and was deleted by a retention filter it
  // should have survived. Refused on both sides, so the wrong delete cannot be
  // set up: the write gate never stores such a row, the compiler never binds one.
  test("a Date outside years 0000–9999 is refused on both sides", () => {
    const events = freshEvents();
    const farFuture = new Date(8.64e15); // year 275760
    expect(() => events.find({ where: { at: { lt: farFuture } } })).toThrow(
      "outside years 0000–9999",
    );
    expect(() => events.insert({ id: "evt_far", at: farFuture })).toThrow(
      "outside years 0000–9999",
    );
    expect(() => events.insert({ id: "evt_far", at: new Date(-8.64e15) })).toThrow(
      "outside years 0000–9999",
    );
  });

  // The premise the whole mapping rests on: whatever spelling comes in, the
  // stored form is the canonical toISOString(). dateParser's string branch is
  // the input that could disprove it — a non-canonical offset spelling must
  // store the form a Date operand matches, and keep doing so if the write path
  // ever stops re-serialising the parse output.
  test("a non-canonical string spelling stores the form a Date operand matches", () => {
    const store = createStore();
    const events = store.collection("events", EventSchema);
    events.insert({ id: "evt_offset", at: "2026-06-01T14:30:00+02:00" });
    expect(
      events.findOne({ where: { at: new Date("2026-06-01T12:30:00.000Z") } })?.id,
    ).toBe("evt_offset");
  });
});

// The confidentiality guard, and the licence it goes with.
//
// This repository is a candidate for publication, and the files listed below are
// the ones that would travel. Vocabulary that must stay behind — enumerated in
// the wordlist named below, never here — was scrubbed out of them once; this
// is what stops the scrub from being undone by the next comment somebody writes.
// It is the same shape as the injection guard above: an invariant about the tree
// itself, asserted by the suite rather than trusted to review.
//
// **It is a backstop, not the control.** A wordlist catches a name coming back;
// it cannot catch a system described accurately in English under different
// names — which is exactly how a design survives a scrub that only hunts names.
// Review is what catches that, and a few entries reach past vocabulary because
// those are the terms that carried a design, not because a regex can decide the
// general question.
//
// **The wordlist itself is not in this file, and must never be.** It lives in
// `confidentiality.local.json`, which is not in the travelling set. This file
// travels — it ships in the npm tarball — and a list of the exact terms a tree
// must never contain is itself the disclosure: it hands a reader the complete
// set, labelled and in one place. Spelling the terms in fragments does not fix
// that. Concatenating adjacent string literals is a one-line transform, and the
// prose around each entry names what it is without needing even that. So the
// guard travels and what it forbids stays behind.
describe("the confidentiality guard", () => {
  const repositoryRoot = join(import.meta.dir, "..");

  // Recursive: a file added at `src/internal/foo.ts` travels just as much as one
  // at `src/foo.ts`, and a guard that only reads the top level would never see it.
  const filesInDirectory = (directory: string): string[] =>
    readdirSync(join(repositoryRoot, directory), { recursive: true })
      .map((entry) => join(directory, entry as string))
      .filter((path) => statSync(join(repositoryRoot, path)).isFile());

  // Exactly the paths that are candidates to travel to a public repository.
  // `AGENTS.md`, `docs/` and `mise.local.toml` are private and stay private, so
  // they keep their citations and are deliberately not scanned.
  //
  // `.github/` and `.mise.toml` travel: the workflow runs `ci`, which is defined
  // in `.mise.toml` and is the whole of the gate downstream. The tasks that only
  // make sense beside the private register live in `mise.local.toml`, which mise
  // merges in here and which is not in this list — so a published checkout gets
  // a task set where every task works.
  const travellingPaths = [
    ...filesInDirectory("src"),
    ...filesInDirectory("test"),
    ...filesInDirectory(".github"),
    "README.md",
    "CHANGELOG.md",
    "LICENSE",
    "CONTRIBUTING.md",
    "CODE_OF_CONDUCT.md",
    "SECURITY.md",
    "package.json",
    "tsconfig.json",
    ".mise.toml",
    "bun.lock",
    "flake.nix",
    "flake.lock",
    ".gitignore",
    // `.npmignore` travels because the tarball is packed from the published
    // checkout, and the patterns that matter are about files that are never
    // committed — an environment file, a key, a database sidecar left by a test
    // run. A git scan is silent about all of them, and without this file npm
    // falls back to `.gitignore`, which carries none of those patterns.
    ".npmignore",
  ];

  type VocabularyEntry = { what: string; pattern: RegExp; exceptFor?: RegExp };

  // Structural patterns describe the shape a published tree must have rather
  // than anything that stays behind, so they are spelled here and run in every
  // checkout — including the published one, where the private list is absent.
  const structuralVocabulary: VocabularyEntry[] = [
    { what: "a link escaping the repository root", pattern: /\]\(\.\.\// },
  ];

  // The private half, read from a file outside the travelling set. Absent by
  // design in a published checkout; the test below is what stops that absence
  // from being silent.
  const privateVocabularyPath = join(repositoryRoot, "confidentiality.local.json");
  const readPrivateVocabulary = (): VocabularyEntry[] | undefined => {
    let raw: string;
    try {
      raw = readFileSync(privateVocabularyPath, "utf8");
    } catch {
      return undefined;
    }
    const parsed = JSON.parse(raw) as {
      entries: Array<{
        what: string;
        pattern: string;
        flags?: string;
        exceptFor?: string;
        exceptForFlags?: string;
      }>;
    };
    return parsed.entries.map((entry) => ({
      what: entry.what,
      pattern: new RegExp(entry.pattern, entry.flags ?? ""),
      exceptFor:
        entry.exceptFor === undefined
          ? undefined
          : new RegExp(entry.exceptFor, entry.exceptForFlags ?? "g"),
    }));
  };

  const privateVocabulary = readPrivateVocabulary();
  const forbiddenVocabulary: VocabularyEntry[] = [
    ...structuralVocabulary,
    ...(privateVocabulary ?? []),
  ];

  // Read at module scope and this whole `describe` disappears the moment one
  // travelling file is absent — `readFileSync` throws while the suite is being
  // collected, bun reports it as an error rather than a failure, and the run goes
  // green with every test below silently missing. That is the worst failure mode
  // this guard could have: it is the control that decides what may be published,
  // and a published tree missing a file is exactly when it would vanish.
  //
  // So: a missing file is data here, and the test right below turns it into a
  // named failure.
  const missing: string[] = [];
  const sources = travellingPaths.flatMap((path) => {
    try {
      return [{ path, lines: readFileSync(join(repositoryRoot, path), "utf8").split("\n") }];
    } catch {
      missing.push(path);
      return [];
    }
  });

  test("every file in the travelling set exists", () => {
    // Fails loudly in a checkout where one is absent, instead of taking the rest
    // of the guard down with it.
    expect(missing).toEqual([]);
  });

  test("the private wordlist is absent only where the whole private surface is", () => {
    // The list does not travel, so in a published checkout there is nothing to
    // load and the vocabulary tests below simply do not exist. That is correct
    // and it is also the shape of every guard that has ever quietly died: a
    // control that evaporates when its input goes missing passes forever.
    //
    // The distinguishing fact is the same one the AGENTS.md and .npmignore
    // guards use: a published tree is missing the *whole* private surface. This
    // file being gone on its own is a deletion, and fails here.
    if (privateVocabulary === undefined) {
      expect(existsSync(join(repositoryRoot, "docs"))).toBe(false);
      expect(existsSync(join(repositoryRoot, "AGENTS.md"))).toBe(false);
      return;
    }

    // And where it is loaded, it is loaded whole — a truncated or empty list
    // would otherwise read as a green guard.
    expect(privateVocabulary.length).toBeGreaterThanOrEqual(11);
    expect(privateVocabulary.every((entry) => entry.what !== "")).toBe(true);
  });

  test("the wordlist never travels, in either direction", () => {
    // The two halves of the fix for a guard that published its own blocklist:
    // the file is not in the travelling set, and this file — which is — carries
    // none of the terms. The second half is asserted by the vocabulary tests
    // below scanning `test/docstore.test.ts` along with everything else, so all
    // that is left to pin here is the first.
    expect(travellingPaths).not.toContain("confidentiality.local.json");
  });

  test("it scans every file that would travel", () => {
    // A guard that scanned nothing would pass forever. Pin the shape of the set
    // so a source file added outside src/ or test/ is a visible decision.
    expect(sources.length).toBeGreaterThanOrEqual(11);
    expect(travellingPaths).toContain("src/index.ts");
    expect(travellingPaths).toContain("test/docstore.test.ts");
    expect(travellingPaths).toContain("LICENSE");
  });

  test("the readiness surface a public repository needs is in the travelling set", () => {
    // Publication creates obligations — a contribution path, a conduct standard,
    // and somewhere to report a vulnerability that is not a public issue. These
    // are only published if they travel, so the list is the assertion.
    for (const path of [
      "CONTRIBUTING.md",
      "CODE_OF_CONDUCT.md",
      "SECURITY.md",
      ".github/PULL_REQUEST_TEMPLATE.md",
      ".github/ISSUE_TEMPLATE/bug_report.yml",
      ".github/ISSUE_TEMPLATE/feature_request.yml",
      ".github/workflows/check.yml",
    ]) {
      expect(travellingPaths).toContain(path);
    }
  });

  test("no travelling file links to a path that does not travel", () => {
    // The sibling of the "link escaping the repository root" pattern above, and
    // the case that one cannot see. A link to `docs/findings/` resolves *inside*
    // the repository, so it looks fine here and is a dead link in a published
    // checkout, where that directory does not exist. Both halves are needed: one
    // catches a link pointing out of the repository, this one catches a link
    // pointing at a part of it that stays behind.
    const travellingSet = new Set(travellingPaths);
    const isTravelling = (target: string): boolean =>
      travellingSet.has(target) ||
      // A link may name a directory (`src/`); it travels if anything in it does.
      travellingPaths.some((path) => path.startsWith(`${target.replace(/\/$/, "")}/`));

    const hits = sources.flatMap(({ path, lines }) => {
      if (!path.endsWith(".md")) return [];
      const directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      return lines.flatMap((line, index) =>
        [...line.matchAll(/\]\(([^)\s]+)\)/g)].flatMap((match) => {
          const target = match[1] as string;
          // External links, anchors and mail links are not this test's business.
          if (/^(https?:|mailto:|#)/.test(target)) return [];
          const withoutAnchor = target.split("#")[0] as string;
          if (withoutAnchor === "") return [];
          const resolved =
            directory === "" ? withoutAnchor : join(directory, withoutAnchor).replaceAll("\\", "/");
          return isTravelling(resolved) ? [] : [`${path}:${index + 1} → ${target}`];
        }),
      );
    });

    expect(hits).toEqual([]);
  });

  for (const { what, pattern, exceptFor } of forbiddenVocabulary) {
    test(`no travelling file names ${what}`, () => {
      const hits = sources.flatMap(({ path, lines }) =>
        lines.flatMap((line, index) => {
          // An exemption removes its own text from the line before the pattern
          // runs, so a second occurrence on the same line is still a hit — the
          // permitted string is subtracted, the line is not excused.
          const scanned = exceptFor === undefined ? line : line.replaceAll(exceptFor, "");
          return pattern.test(scanned) ? [`${path}:${index + 1}`] : [];
        }),
      );
      expect(hits).toEqual([]);
    });
  }

  test("LICENSE is the MIT text, attributed to the copyright holder", () => {
    const licence = readFileSync(join(repositoryRoot, "LICENSE"), "utf8");
    expect(licence.startsWith("MIT License\n")).toBe(true);
    expect(licence).toContain("Copyright (c) 2026 Enrico Scherlies");
    expect(licence).toContain("Permission is hereby granted, free of charge");
    expect(licence).not.toContain("All rights reserved");
    expect(licence.toLowerCase()).not.toContain("proprietary");
  });

  test("package.json is the publishable manifest a registry reads", () => {
    // A registry release is now part of the finish line, so the assertion flips:
    // `private: true` used to be the control that stopped an accidental
    // `npm publish`, and it is now the one field that would break the intended
    // one. It fails at exactly the wrong moment — `npm pack` succeeds with it
    // set and only `publish` refuses — so a green pack proves nothing and this
    // test carries the check instead.
    const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
      name: unknown;
      version: unknown;
      license: unknown;
      private: unknown;
      repository: { url?: unknown } | undefined;
    };
    expect(manifest.license).toBe("MIT");
    expect(manifest.private).toBeUndefined();
    // Scoped, and that is load-bearing rather than cosmetic: the registry
    // refused the bare name `zodstore` outright as too similar to an existing
    // `zod-store`, so an unscoped manifest here is one that cannot be published
    // at all. A scoped package is also restricted by default, which is why the
    // publish step passes `--access public`.
    expect(manifest.name).toBe("@binaryplease/zodstore");
    expect(manifest.repository?.url).toContain("/zodstore.git");

    // The published version is the one a reader of the changelog sees at the
    // top. These drift silently otherwise: nothing else compares them, and the
    // registry keeps whichever one was shipped forever.
    const changelog = readFileSync(join(repositoryRoot, "CHANGELOG.md"), "utf8");
    const newestHeading = /^## (\d+\.\d+\.\d+)/m.exec(changelog);
    expect(manifest.version).toBe(newestHeading?.[1]);
  });

  test("AGENTS.md names the licence that is actually in force", () => {
    // AGENTS.md does not travel, so no guard above reads it — and it spent three
    // commits after the relicensing still calling the project proprietary, which
    // is the entry-point file contradicting LICENSE, package.json and README at
    // once (F038). Both sides are read rather than hard-coded, so the next
    // relicensing cannot leave one of them behind either.
    //
    // This test also runs in the published checkout, where AGENTS.md is absent
    // by design — so absence has to be allowed without becoming the F036 hole,
    // where a guard evaporates the moment its input goes missing. The
    // distinguishing fact is that a published tree is missing the *whole*
    // private surface: AGENTS.md alone being gone is a deletion, and fails.
    const read = (path: string): string | undefined => {
      try {
        return readFileSync(join(repositoryRoot, path), "utf8");
      } catch {
        return undefined;
      }
    };
    const agents = read("AGENTS.md");
    if (agents === undefined) {
      expect(read("docs/Findings.md")).toBeUndefined();
      return;
    }

    const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
      license: string;
    };
    expect(agents).toContain(manifest.license);
    expect(agents.toLowerCase()).not.toContain("proprietary");
  });

  test("the npm tarball is an allowlist, so an unnamed hazard cannot ship", () => {
    // This is the primary pack control and `.npmignore` below is the second
    // layer, in that order deliberately.
    //
    // A denylist keyed to names and suffixes fails *open* on the case nobody
    // thought of, and the cost here does not reverse: a registry version is
    // spent forever. The patterns below reach `server.env` and `probe.sqlite-wal`
    // and do not reach `id_rsa` (no extension), `.envrc` (dot-prefixed but not
    // `.env` — and this tree ships a flake that invites direnv), `.netrc`,
    // `.git-credentials` or `.claude/`. A real `npm pack` shipped all of those.
    //
    // `files` inverts the question. npm treats it as an allowlist that outranks
    // `.npmignore` entirely, so it stops being "did we enumerate every hazard"
    // and becomes "did we enumerate the things that ship" — which is a list this
    // repository can actually hold.
    const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
      files?: string[];
    };
    expect(Array.isArray(manifest.files)).toBe(true);
    const declared = manifest.files ?? [];

    // npm packs these three whatever the allowlist says, so they are part of the
    // surface. Modelled explicitly: a guard that assumed the allowlist was the
    // whole of what ships would understate the tarball.
    const alwaysPacked = ["package.json", "README.md", "LICENSE"];
    const ships = (path: string): boolean =>
      alwaysPacked.includes(path) ||
      declared.some((entry) => {
        const root = entry.replace(/\/$/, "");
        return path === root || path.startsWith(`${root}/`);
      });

    // Derived from the travelling set rather than written out a second time, so
    // a file added outside `src/` moves this assertion instead of quietly
    // joining the tarball.
    expect(travellingPaths.filter(ships).sort()).toEqual(
      ["CHANGELOG.md", "LICENSE", "README.md", "package.json", ...filesInDirectory("src")].sort(),
    );

    // The confidentiality guard's own prose describes the shape of what is
    // withheld — that there is a private register, a wordlist, an extraction.
    // No consumer of the package needs it, and shipping it widened the audience
    // for that from "someone browsing the repository" to "everyone who installs".
    expect(ships("test/docstore.test.ts")).toBe(false);

    // The class a pattern list could not express, stated as the inputs that
    // defeated it. What makes these safe now is not that they are named here —
    // it is that they are outside every declared entry, which is a property the
    // next unnamed hazard shares.
    for (const path of [
      "id_rsa",
      "id_ed25519",
      ".git-credentials",
      ".netrc",
      ".envrc",
      "credentials.json",
      "server.env.bak",
      "db.dump",
      ".claude/settings.json",
      "OPEN_SOURCING_PROGRESS.md",
      "notes/scratch.md",
    ]) {
      expect({ path, ships: ships(path) }).toEqual({ path, ships: false });
    }
  });

  test("npm cannot pack a secret out of any checkout of this repository", () => {
    // The second layer. `files` above is what actually decides the tarball; this
    // file still travels because it costs nothing and because a `files` entry
    // that later grows to a directory containing junk is caught here.
    //
    // npm packs from the working tree, not from git, and with no `.npmignore` it
    // falls back to `.gitignore`. This guard used to allow the file to be absent
    // — reasoning that the published tree holds none of the private paths it
    // excluded, so a list over there would name only things that do not exist.
    //
    // That reasoning covered the tracked half and missed the half that matters.
    // The patterns worth having are about files that are **never committed**: an
    // environment file, a key, a `-wal` sidecar left by a test run. Those exist
    // in any working directory, in either repository, and no git scan can see
    // them. So the file travels now, and this test asserts what it *does* rather
    // than which lines it contains — a pattern list can be reworded, and the
    // failure it prevents cannot.
    //
    // Its input set is the whole of its coverage, which is exactly why it is not
    // the control any more.
    expect(travellingPaths).toContain(".npmignore");

    const patterns = readFileSync(join(repositoryRoot, ".npmignore"), "utf8")
      .split("\n")
      .map((line) => line.trim())
      // Negations are deliberately not modelled: this file carries none, and a
      // matcher that silently mishandled one would understate what ships.
      .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("!"));
    expect(patterns.some((pattern) => pattern.startsWith("!"))).toBe(false);

    // A deliberately small reading of the glob syntax npm honours: a pattern
    // with no slash matches a path segment at any depth, and a trailing slash
    // matches a directory segment only.
    const excludes = (path: string): boolean =>
      patterns.some((pattern) => {
        const directoryOnly = pattern.endsWith("/");
        const body = directoryOnly ? pattern.slice(0, -1) : pattern;
        const matcher = new RegExp(`^${body.replaceAll(".", "\\.").replaceAll("*", "[^/]*")}$`);
        const segments = path.split("/");
        return (directoryOnly ? segments.slice(0, -1) : segments).some((segment) =>
          matcher.test(segment),
        );
      });

    // The failure scenario stated as its inputs. Every one of these is a file
    // that exists in a working directory without ever being committed, so a
    // green history and a clean `git` scan say nothing about any of them.
    for (const path of [
      // Not dot-prefixed, which is the case a `.env`-only rule walks past.
      "server.env",
      "production.env",
      ".env",
      ".env.local",
      "secrets/deploy.key",
      "deploy.pem",
      "probe.sqlite",
      // Carries pages the .sqlite file itself does not.
      "probe.sqlite-wal",
      "probe.sqlite-shm",
      "node_modules/left/over.js",
      // The private surface, which is the half this guard already covered.
      "AGENTS.md",
      "docs/Findings.md",
      "mise.local.toml",
      "confidentiality.local.json",
    ]) {
      expect({ path, excluded: excludes(path) }).toEqual({ path, excluded: true });
    }

    // And it excludes nothing the package is for.
    for (const path of [
      "src/index.ts",
      "src/collection.ts",
      "test/docstore.test.ts",
      "README.md",
      "LICENSE",
      "package.json",
      ".mise.toml",
    ]) {
      expect({ path, excluded: excludes(path) }).toEqual({ path, excluded: false });
    }
  });

  test("both reporting policies survive the private form being unavailable", () => {
    // The Security tab's private-reporting form is a repository setting, not a
    // property of this tree: it is off until someone turns it on, and the window
    // between a repository going public and that switch being flipped is exactly
    // when a reporter arrives. Both files that route a report through it have to
    // say what to do when it is not there, and neither may end up telling a
    // reporter to describe the problem in public — a public issue naming an
    // unfixed flaw is a beacon on it.
    for (const path of ["SECURITY.md", "CODE_OF_CONDUCT.md"]) {
      const text = readFileSync(join(repositoryRoot, path), "utf8");
      expect({ path, routes: text.includes("Security") }).toEqual({ path, routes: true });
      expect({ path, fallback: text.toLowerCase().includes("private contact") }).toEqual({
        path,
        fallback: true,
      });
      // The claim that made the fallback unreachable in the first place.
      expect({ path, absolute: text.toLowerCase().includes("the only reporting path") }).toEqual({
        path,
        absolute: false,
      });
    }
  });

  test("the README's licence statement agrees with the licence file", () => {
    const readme = readFileSync(join(repositoryRoot, "README.md"), "utf8");
    expect(readme).toContain("MIT — see [`LICENSE`](LICENSE).");
    expect(readme.toLowerCase()).not.toContain("proprietary");
  });
});
