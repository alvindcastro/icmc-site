// Starts the backend's conformance server for the run, unless CONFORMANCE_URL names one already running.
import {spawn} from 'node:child_process';
import path from 'node:path';
import type {TestProject} from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {conformanceUrl: string}
}

async function healthy(url: string): Promise<boolean> {
  try {return (await fetch(`${url}/__conformance__/health`)).ok;} catch {return false;}
}

export default async function setup(project: TestProject) {
  const given = process.env.CONFORMANCE_URL;
  const url = given ?? `http://127.0.0.1:${process.env.CONFORMANCE_PORT ?? 8010}`;
  project.provide('conformanceUrl', url);
  if (given) {
    if (!await healthy(url)) throw new Error(`No conformance server answers at ${url}.`);
    return;
  }
  const backend = path.resolve(import.meta.dirname, '../../../backend');
  const server = spawn('uv', ['run', 'python', '-m', 'tests.conformance_server', '--port', new URL(url).port], {cwd: backend, stdio: 'inherit', shell: process.platform === 'win32'});
  let failed: string | null = null;
  server.on('error', error => {failed = `The conformance server could not be started: ${error.message}`;});
  server.on('exit', code => {failed ??= `The conformance server stopped early with code ${code}.`;});
  for (let attempt = 0; attempt < 240 && !failed; attempt++) {
    if (await healthy(url)) return async () => {await fetch(`${url}/__conformance__/stop`, {method: 'POST'}).catch(() => undefined);};
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  server.kill();
  throw new Error(failed ?? `The conformance server did not answer at ${url} within a minute.`);
}
