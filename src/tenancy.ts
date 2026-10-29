// Who this Studio is for (docs/studio-customers.md). Three switches, all from the environment:
//
//   STUDIO_PLATFORM_ADMINS   the platform admins: Hawkes Studio's owner (J), not any one Studio's admins. A verified
//                            Google sign-in with one of these emails (or J's owner key) is the only way to the features
//                            in lockdown.ts. Default piercehawkes3@gmail.com.
//   STUDIO_SIGNUP            what Continue with Google does for an email with no account here:
//                              invite    (default, J's Studio) refused unless an admin invited it
//                              waitlist  J's Studio taking sign-ups: the person is recorded (Google's sub, email,
//                                        name) for J to let in, and told so; no account, nothing to see
//                              owner     a customer's own Studio: the first verified Google account claims it and is
//                                        its admin; everyone after needs that admin's invite
//   STUDIO_CUSTOMER=1        this Studio is a customer's (also true in an org cell, STUDIO_ORG, and in owner mode).
//                            A customer's Studio: its admins run their own games, but never J's machinery, and Claude
//                            is only ever the customer's own (claude.ts).

import { cellOrg } from './platform.ts';

export const DEFAULT_PLATFORM_ADMIN = 'piercehawkes3@gmail.com';

/** The platform admins' emails (lower case). */
export const platformAdmins = () => String(process.env.STUDIO_PLATFORM_ADMINS ?? DEFAULT_PLATFORM_ADMIN).split(/[,\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);

export type SignupMode = 'invite' | 'waitlist' | 'owner';
export const signupMode = (): SignupMode => {
  const m = process.env.STUDIO_SIGNUP?.trim().toLowerCase();
  return m === 'waitlist' || m === 'owner' ? m : 'invite';
};

/** A customer's Studio (an org cell, a claimed Studio, or STUDIO_CUSTOMER=1), not J's. */
export const customerStudio = () => Boolean(cellOrg()) || signupMode() === 'owner' || process.env.STUDIO_CUSTOMER === '1';

/** J's GitHub account: a customer's Studio never takes a game from it. */
export const PLATFORM_GITHUB = 'jgriffith3433';
export const touchesPlatformRepo = (s: unknown) => String(s ?? '').toLowerCase().includes(PLATFORM_GITHUB);

/** "J" and "J's" in a sentence as `name` (the owner of a customer's Studio: owner.ts). Pure: no database. */
export function ownerWords(text: string, name: string): string {
  const poss = name === 'the owner' ? "the owner's" : `${name}'s`;
  return String(text ?? '')
    .replace(/\bJ['’]s\b/g, poss)
    .replace(/(^|[^\w.@/-])J\b(?![.\w-])/g, `$1${name}`);
}
