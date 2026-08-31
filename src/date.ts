import { z } from "zod";

/**
 * The length of `toISOString()` for every year in 0000–9999 — the canonical
 * form all stored timestamps share. Outside that range the expanded form
 * (`+275760-09-13T…`, `-271821-…`) is longer and leads with a sign that sorts
 * before every digit, so it does not order lexicographically against in-range
 * values. Both sides of the comparison hold the line: `dateParser` refuses to
 * store such a date, and the query compiler refuses one as an operand.
 */
export const CANONICAL_ISO_LENGTH = 24;

/**
 * Schema helper for a timestamp that survives storage. Documents are stored as
 * JSON, so a `z.date()` field is written as an ISO string and then rejected by
 * its own schema on the way back — the row is accepted at the write gate and
 * unreadable forever after. `dateParser` sits on both sides of that gate: a
 * `Date` passes through unchanged, an ISO string is rehydrated into a `Date`.
 *
 * Because both branches produce the same `Date`, parsing the stored form
 * returns exactly what was stored — the idempotence the write gate requires.
 *
 * Like every non-identity field, a timestamp declares its own default.
 *
 * @example
 *   const EventSchema = z.object({
 *     id: ref("evt"),
 *     at: dateParser.default(() => new Date()),
 *   });
 */
export const dateParser = z
  .date()
  .or(
    z.string().transform((value, context) => {
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) {
        context.addIssue({ code: "custom", message: "Invalid date format" });
        return z.NEVER;
      }
      return parsed;
    }),
  )
  // A date outside years 0000–9999 stores in the expanded ISO form, which does
  // not order against the canonical one — a stored row like that silently sorts
  // before every in-range operand, so it is refused at the write gate where the
  // failure is loud and attributable rather than a wrong query answer later.
  .refine((value) => value.toISOString().length === CANONICAL_ISO_LENGTH, {
    message:
      "Date lies outside years 0000–9999, whose expanded ISO form does not order against stored timestamps",
  });
