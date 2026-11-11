// The critic section of a report as Markdown lines (report.ts): one bullet per dimension, no table, so it reads at 390 px.
import { fileUrl } from './gen.ts';

/** targetOf: a game's target per dimension (config.ts targetFor), so each score reads beside its target. */
export function criticLines(d: any, targetOf?: (dimension: string) => number): string[] {
  if (!d || d.verdict !== 'judged' || !Array.isArray(d.scores) || !d.scores.length) {
    return [`**Unjudged.** ${d?.summary ?? 'The critic did not run.'} No scores are given, and this is not a pass.`];
  }
  const L: string[] = [];
  const mean = Math.round((d.scores.reduce((n: number, x: any) => n + (x.score ?? 0), 0) / d.scores.length) * 10) / 10;
  L.push(`${d.summary ?? ''} **${mean}/10** on average, reviewing **${d.scenario ?? 'the run'}**${d.next?.length ? ` (not reviewed yet: ${d.next.join(', ')})` : ''}.`, '');
  for (const s of d.scores) {
    const evidence = [s.frame ? `[frame](${fileUrl(s.frame)})` : '', s.at].filter(Boolean).join(' ');
    L.push(`- **${s.dimension}: ${s.score}/10**${targetOf ? ` (target ${targetOf(s.dimension)})` : ''} vs ${s.reference}${evidence ? ` (${evidence})` : ''}. ${s.why} *Fix:* ${s.fix}`);
  }
  return L;
}
