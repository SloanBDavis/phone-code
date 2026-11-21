/**
 * `phonecode setup`: diagnose how a phone can reach this computer and print
 * one precise next step. Also used by the banner when the daemon found no
 * secure phone-reachable URL (setupHelp).
 */
import { bold, cyan, dim, green, yellow } from './banner.ts';
import { DEFAULT_PORT } from './config.ts';
import { diagnoseTailscale, otherRoutes, type Diagnosis } from './net/tailscale-diag.ts';

function render(d: Diagnosis, port: number): string {
  const ok = d.state === 'ready';
  const lines = [`  ${ok ? green('●') : yellow('!')} ${d.summary}`];
  if (d.cliNote !== undefined) lines.push(dim(`    ${d.cliNote}`));
  for (const step of d.next) lines.push(`    ${ok ? '' : '→ '}${step}`);
  if (!ok) lines.push('', ...otherRoutes(port).map((l) => `  ${l}`));
  return lines.join('\n');
}

/** Shown under the banner when phones cannot reach the daemon yet. */
export async function setupHelp(port: number): Promise<string> {
  const d = await diagnoseTailscale();
  return `${render(d, port)}\n\n  ${dim('Run')} ${bold('phonecode setup')} ${dim('to check again.')}`;
}

/**
 * Prints the diagnosis. Returns 'start' when Tailscale is ready and the user
 * (on a terminal) wants to start now; otherwise the exit code: 0 ready, 1 not.
 */
export async function runSetup(opts: { port?: number; json?: boolean } = {}): Promise<'start' | number> {
  const port = opts.port ?? DEFAULT_PORT;
  const d = await diagnoseTailscale();
  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify(d)}\n`);
    return d.state === 'ready' ? 0 : 1;
  }
  process.stdout.write(`\n  ${bold('phone-code setup')}\n\n${render(d, port)}\n\n`);
  if (d.state !== 'ready') return 1;
  if (!process.stdin.isTTY) return 0;
  process.stdout.write(`  Start phone-code now on ${cyan(`https://${d.domain ?? ''}`)}? [Y/n] `);
  const answer = await new Promise<string>((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (chunk) => resolve(String(chunk).trim().toLowerCase()));
  });
  process.stdin.pause();
  return answer === '' || answer.startsWith('y') ? 'start' : 0;
}
