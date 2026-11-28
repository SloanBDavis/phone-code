/**
 * ACP form elicitation (`elicitation/create`, mode "form") <-> phone-code QuestionItem.
 *
 * Elicitation is not in the stable ACP v1 schema yet (it follows MCP's
 * elicitation: a flat JSON Schema `requestedSchema`, answered with
 * `{action: 'accept' | 'decline' | 'cancel', content}`). A client opts in with
 * `clientCapabilities.elicitation.form`. Antigravity CLI uses it for its
 * `ask_question` tool; without the capability it prints the question as text
 * and ends the turn. Captured from agy 1.5.13:
 *
 *   {"method":"elicitation/create","params":{"sessionId":"…","toolCallId":"…","mode":"form",
 *    "message":"The agent has a question.","requestedSchema":{"type":"object","properties":{
 *      "q1":{"type":"string","title":"Which color?","oneOf":[{"const":"1","title":"(Recommended) Blue"},
 *                                                          {"const":"2","title":"Red"}]},
 *      "q1_other":{"type":"string","title":"Other","description":"Optional free-form answer to: Which color?"}}}}}
 *   -> {"action":"accept","content":{"q1":"2"}}
 *
 * Mapping: every property is one question (title, else description, else the
 * key), its choices from `oneOf`/`anyOf` ({const,title}) or `enum`; an array
 * property is multi-select. A `<key>_other` string property next to `<key>`
 * becomes that question's free-text answer rather than a question of its own.
 * Answers come back as the chosen labels joined by ", " (or free text).
 */
import type { QuestionItem } from '@phone-code/protocol';
import { arr, isRec, num, oneLine, rec, str, type Rec } from '../shared/common.ts';

interface Choice {
  value: unknown;
  label: string;
}

export interface ElicitField {
  key: string;
  question: string;
  type: string;
  multi: boolean;
  choices: Choice[];
  otherKey?: string;
}

function choicesOf(s: Rec): Choice[] {
  const list = arr(s.oneOf).length > 0 ? arr(s.oneOf) : arr(s.anyOf);
  const out: Choice[] = [];
  for (const c of list.map(rec)) {
    if (c.const === undefined) continue;
    if (typeof c.const === 'string' && str(c.title) === undefined) {
      out.push({ value: c.const, label: c.const });
      continue;
    }
    out.push({ value: c.const, label: str(c.title) ?? JSON.stringify(c.const) });
  }
  if (out.length > 0) return out;
  const names = arr(s.enumNames);
  return arr(s.enum).map((v, i) => ({
    value: v,
    label: str(names[i]) ?? (typeof v === 'string' ? v : JSON.stringify(v)),
  }));
}

/** The form's fields, or undefined when there is nothing to ask. */
export function elicitFields(schema: unknown): ElicitField[] | undefined {
  const props = rec(rec(schema).properties);
  const keys = Object.keys(props);
  const fields: ElicitField[] = [];
  for (const key of keys) {
    const s = rec(props[key]);
    const base = key.endsWith('_other') ? key.slice(0, -'_other'.length) : undefined;
    if (base !== undefined && isRec(props[base])) continue; // folded into `base`
    const multi = str(s.type) === 'array';
    const choices = choicesOf(multi ? rec(s.items) : s);
    const question = oneLine(str(s.title) ?? str(s.description) ?? key, 300);
    const otherKey = isRec(props[`${key}_other`]) ? `${key}_other` : undefined;
    fields.push({
      key,
      question,
      type: str(s.type) ?? 'string',
      multi,
      choices,
      ...(otherKey ? { otherKey } : {}),
    });
  }
  return fields.length > 0 ? fields : undefined;
}

export function elicitQuestions(
  fields: ElicitField[],
  message: string | undefined,
): QuestionItem['questions'] {
  return fields.map((f, i) => ({
    question: f.question,
    ...(i === 0 && message && message !== f.question ? { header: oneLine(message, 80) } : {}),
    ...(f.multi ? { multiSelect: true } : {}),
    options: f.choices.map((c) => ({ label: c.label })),
  }));
}

function scalar(type: string, text: string): unknown {
  if (type === 'number' || type === 'integer') return num(Number(text)) ?? text;
  if (type === 'boolean') return /^(true|yes|y|1)$/i.test(text.trim());
  return text;
}

/** `content` for an `accept` reply, from the phone's answers (question text -> labels or free text). */
export function elicitContent(fields: ElicitField[], answers: Record<string, string>): Rec {
  const content: Rec = {};
  for (const f of fields) {
    const raw = (answers[f.question] ?? '').trim();
    if (raw === '') continue;
    if (f.choices.length === 0) {
      content[f.key] = scalar(f.type, raw);
      continue;
    }
    const exact = f.choices.find((c) => c.label === raw);
    const parts = exact ? [raw] : raw.split(', ');
    const picked = parts.map((p) => f.choices.find((c) => c.label === p));
    const values = picked.filter((c): c is Choice => c !== undefined).map((c) => c.value);
    const rest = parts.filter((_, i) => picked[i] === undefined).join(', ');
    if (f.multi) {
      if (values.length > 0) content[f.key] = values;
    } else if (values[0] !== undefined) content[f.key] = values[0];
    if (rest !== '') {
      if (f.otherKey !== undefined) content[f.otherKey] = rest;
      else if (!f.multi && values.length === 0) content[f.key] = rest;
    }
  }
  return content;
}
