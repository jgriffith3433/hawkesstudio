// Who a customer's Studio works for (docs/studio-customers.md section 4): its owner, by their own name, never "J". J's
// Studio keeps J. Prompts in a customer's Studio (talk.ts, pm.ts, agents' briefs, reviews) say ownerName() or "you", and
// forOwner() turns any "J" a shared sentence still has into the owner's name before it reaches Claude.

import { db } from './db.ts';
import { customerStudio, ownerWords } from './tenancy.ts';

/** The owner's first name (the first admin's), else "the owner". J in J's Studio. */
export function ownerName(): string {
  if (!customerStudio()) return 'J';
  try {
    const r = db.prepare(`SELECT name, email FROM users WHERE role = 'admin' AND disabled = 0 ORDER BY created LIMIT 1`).get() as { name: string | null; email: string } | undefined;
    const first = r?.name?.trim().split(/\s+/)[0];
    return first || 'the owner';
  } catch {
    return 'the owner';
  }
}

/** In a customer's Studio: "J" and "J's" in a sentence become the owner's name. J's Studio: the text as it is. */
export function forOwner(text: string): string {
  return customerStudio() ? ownerWords(text, ownerName()) : text;
}
