/**
 * Finding which long-lived feature a user's own words are about.
 *
 * A project holds tens of requirements at most, so every lookup scores the
 * whole ledger in memory: nothing is indexed, nothing goes stale, and no model
 * is asked. English is split into words and Chinese into overlapping
 * two-character pieces, with single characters worth half; each piece is
 * scored by BM25, so a piece most requirements share ("功能", "支持") counts
 * little. Title, description and aliases weigh fully, summary and history at 0.6.
 *
 * The result is a short candidate list and a verdict: one requirement is
 * likely, several look alike, or none fits. Main settles the last two from the
 * catalog, which lists every requirement.
 */
import type { RequirementKind, RequirementStatus } from "./project-ledger.js";

export interface LookupEntry {
  requirementId: string;
  kind: RequirementKind;
  status: RequirementStatus;
  title: string;
  description: string;
  aliases: string[];
  summary: string;
  history: string[];
}

export type LookupVerdict = "likely" | "several" | "none";

export interface LookupCandidate {
  requirementId: string;
  title: string;
  score: number;
  /** The words and two-character pieces of the request this requirement contains. */
  matched: string[];
}

export interface CatalogEntry {
  requirementId: string;
  kind: RequirementKind;
  status: RequirementStatus;
  title: string;
  aliases: string[];
  /** What the feature is: with the title, enough to tell features apart. */
  description: string;
}

export interface LookupResult {
  verdict: LookupVerdict;
  candidates: LookupCandidate[];
  /** Every requirement, when the verdict is not "likely" or the ledger is small. */
  catalog?: CatalogEntry[];
}

const K1 = 1.2;
const B = 0.75;
const MAIN_WEIGHT = 1;
const BODY_WEIGHT = 0.6;
const CHARACTER_WEIGHT = 0.5;
const CANDIDATES = 5;
/** Up to this many requirements, the catalog comes even with a likely match. */
const SMALL_LEDGER = 30;
/** The share of the request's known pieces the top candidate must hold to be likely. */
const LIKELY_COVERAGE = 0.5;
/** And how far ahead of the next one it must be. */
const LIKELY_LEAD = 2;
/** And how many of the request's words and pieces it must share: one shared word is a coincidence. */
const LIKELY_MATCHES = 2;
/** Below this share, nothing fits. */
const NONE_COVERAGE = 0.2;

const HAN = /\p{Script=Han}/u;
const PIECE = /[\p{Script=Han}]+|[\p{L}\p{N}]+/gu;

interface Term {
  text: string;
  /** A single Chinese character, worth half. */
  character: boolean;
}

/** Words, two-character pieces and single characters, in order and repeated as they occur. */
export function lookupTerms(text: string): Term[] {
  const terms: Term[] = [];
  for (const [run] of text.toLowerCase().matchAll(PIECE)) {
    if (!HAN.test(run)) {
      terms.push({ text: run, character: false });
      continue;
    }
    const characters = [...run];
    for (let index = 0; index < characters.length; index += 1) {
      terms.push({ text: characters[index], character: true });
      if (index + 1 < characters.length)
        terms.push({ text: characters[index] + characters[index + 1], character: false });
    }
  }
  return terms;
}

interface Document {
  entry: LookupEntry;
  /** Weighted occurrences of each term. */
  frequency: Map<string, number>;
  length: number;
}

function documentOf(entry: LookupEntry): Document {
  const frequency = new Map<string, number>();
  let length = 0;
  const add = (text: string, weight: number) => {
    for (const term of lookupTerms(text)) {
      frequency.set(term.text, (frequency.get(term.text) ?? 0) + weight);
      length += weight;
    }
  };
  for (const text of [entry.title, entry.description, ...entry.aliases]) add(text, MAIN_WEIGHT);
  for (const text of [entry.summary, ...entry.history]) add(text, BODY_WEIGHT);
  return { entry, frequency, length };
}

export function catalogOf(entries: LookupEntry[]): CatalogEntry[] {
  return entries.map((entry) => ({
    requirementId: entry.requirementId,
    kind: entry.kind,
    status: entry.status,
    title: entry.title,
    aliases: entry.aliases,
    description: entry.description
  }));
}

/**
 * Score every active requirement against the request.
 *
 * Retired requirements are not candidates, since no development may start on
 * one, but they stay in the catalog so Main can see a feature was dropped.
 */
export function lookupRequirements(entries: LookupEntry[], request: string): LookupResult {
  const documents = entries.filter((entry) => entry.status === "active").map(documentOf);
  const count = documents.length;
  const average = count ? documents.reduce((sum, document) => sum + document.length, 0) / count : 0;
  const query = new Map<string, Term>();
  for (const term of lookupTerms(request)) query.set(term.text, term);
  const idf = new Map<string, number>();
  for (const term of query.values()) {
    const frequency = documents.filter((document) => document.frequency.has(term.text)).length;
    if (frequency) idf.set(term.text, Math.log(1 + (count - frequency + 0.5) / (frequency + 0.5)));
  }
  // Coverage counts only pieces some requirement has: filler words the ledger
  // never uses ("帮我", "一下") say nothing about which feature is meant.
  const known = [...query.values()].filter((term) => !term.character && idf.has(term.text));
  const knownWeight = known.reduce((sum, term) => sum + idf.get(term.text)!, 0);

  const scored = documents
    .map((document) => {
      let score = 0;
      let covered = 0;
      const matched: string[] = [];
      for (const term of query.values()) {
        const frequency = document.frequency.get(term.text);
        if (!frequency) continue;
        const weight = idf.get(term.text)!;
        const normalized = 1 - B + (B * document.length) / (average || 1);
        score +=
          (weight * frequency * (K1 + 1) * (term.character ? CHARACTER_WEIGHT : 1)) /
          (frequency + K1 * normalized);
        if (term.character) continue;
        covered += weight;
        matched.push(term.text);
      }
      return { document, score, matched, coverage: knownWeight ? covered / knownWeight : 0 };
    })
    // A requirement sharing only single characters with the request is no candidate.
    .filter((item) => item.matched.length)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.document.entry.requirementId.localeCompare(right.document.entry.requirementId)
    );

  const top = scored.at(0);
  const next = scored.at(1);
  const verdict: LookupVerdict =
    !top || top.coverage < NONE_COVERAGE
      ? "none"
      : top.coverage >= LIKELY_COVERAGE &&
          top.matched.length >= LIKELY_MATCHES &&
          (!next || top.score >= next.score * LIKELY_LEAD)
        ? "likely"
        : "several";
  const candidates = scored.slice(0, CANDIDATES).map((item) => ({
    requirementId: item.document.entry.requirementId,
    title: item.document.entry.title,
    score: Math.round(item.score * 100) / 100,
    matched: item.matched
  }));
  return verdict !== "likely" || entries.length <= SMALL_LEDGER
    ? { verdict, candidates, catalog: catalogOf(entries) }
    : { verdict, candidates };
}
