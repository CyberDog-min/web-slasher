import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..');
const fixtureRoot = join(root, 'test', 'manual');
const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean);
const chromePath = chromeCandidates.find((candidate) => existsSync(candidate));
const useHeadless = process.env.PAGE_SLASH_HEADLESS === '1';

if (!chromePath) {
  console.error('Chrome/Edge executable not found. Set CHROME_PATH to run the browser smoke test.');
  process.exit(1);
}

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8'
};

function createFixtureServer() {
  return createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
      const pathname = requestUrl.pathname === '/' ? '/fixture.html' : requestUrl.pathname;
      const relativePath = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, '');
      const filePath = resolve(fixtureRoot, relativePath);
      const fixturePrefix = `${resolve(fixtureRoot)}${sep}`;

      if (filePath !== resolve(fixtureRoot, 'fixture.html') && !filePath.startsWith(fixturePrefix)) {
        response.writeHead(403);
        response.end('Forbidden');
        return;
      }

      const body = readFileSync(filePath);
      response.writeHead(200, {
        'Content-Type': mimeTypes[extname(filePath)] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end('Not found');
    }
  });
}

function listen(server) {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolvePromise(server.address().port);
    });
  });
}

function waitFor(predicate, timeoutMs = 10000, intervalMs = 80, label = 'browser state') {
  const startedAt = Date.now();

  return new Promise((resolvePromise, reject) => {
    const poll = async () => {
      try {
        const value = await predicate();
        if (value) {
          resolvePromise(value);
          return;
        }

        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error(`Timed out waiting for ${label}.`));
          return;
        }

        setTimeout(poll, intervalMs);
      } catch (error) {
        if (Date.now() - startedAt >= timeoutMs) {
          reject(error);
          return;
        }
        setTimeout(poll, intervalMs);
      }
    };

    poll();
  });
}

async function getFreePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return port;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  const exceptions = [];
  const contexts = [];
  let nextId = 1;

  await new Promise((resolvePromise, reject) => {
    socket.addEventListener('open', resolvePromise, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));

    if (message.method === 'Runtime.exceptionThrown') {
      exceptions.push(message.params?.exceptionDetails || message.params);
      return;
    }

    if (message.method === 'Runtime.executionContextCreated') {
      contexts.push(message.params?.context);
      return;
    }

    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);

    if (message.error) {
      request.reject(new Error(`${message.error.code}: ${message.error.message}`));
    } else {
      request.resolve(message.result);
    }
  });

  function send(method, params = {}) {
    const id = nextId;
    nextId += 1;

    return new Promise((resolvePromise, reject) => {
      pending.set(id, { resolve: resolvePromise, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(expression, contextId = undefined) {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      ...(contextId ? { contextId } : {})
    });

    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Runtime evaluation failed.');
    }

    return result.result?.value;
  }

  return {
    send,
    evaluate,
    exceptions,
    contexts,
    close: () => socket.close()
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;

  const exited = new Promise((resolvePromise) => {
    child.once('exit', resolvePromise);
  });
  child.kill();
  await Promise.race([exited, delay(3000)]);
}

const fixtureServer = createFixtureServer();
const fixturePort = await listen(fixtureServer);
const debugPort = await getFreePort();
const profileDirectory = mkdtempSync(join(tmpdir(), 'page-slash-smoke-'));
let chromeProcess = null;
let browserCdp = null;
let cdp = null;

try {
  const chromeArguments = [
    ...(useHeadless
      ? ['--headless=new']
      : ['--window-position=-32000,-32000', '--window-size=800,600', '--start-minimized']),
    '--disable-gpu',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-features=Translate',
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profileDirectory}`,
    `--remote-debugging-port=${debugPort}`,
    `http://127.0.0.1:${fixturePort}/fixture.html`
  ];

  chromeProcess = spawn(chromePath, chromeArguments, {
    stdio: 'ignore',
    windowsHide: true
  });

  const browserVersion = await waitFor(async () => {
    try {
      return await fetchJson(`http://127.0.0.1:${debugPort}/json/version`);
    } catch {
      return null;
    }
  }, 15000, 80, 'Chrome DevTools endpoint');

  browserCdp = await connectCdp(browserVersion.webSocketDebuggerUrl);
  const loadedExtension = await browserCdp.send('Extensions.loadUnpacked', {
    path: root
  });
  assert(loadedExtension?.id, 'Chrome did not return an extension id.');

  const pageTarget = await waitFor(async () => {
    const targets = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`);
    return targets.find((target) => (
      target.type === 'page'
      && target.url.startsWith(`http://127.0.0.1:${fixturePort}/`)
    ));
  }, 15000, 80, 'fixture page target');

  cdp = await connectCdp(pageTarget.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  cdp.contexts.length = 0;
  await cdp.send('Page.reload', { ignoreCache: true });

  await waitFor(async () => (
    await cdp.evaluate(`document.readyState === 'complete'`)
  ), 10000, 80, 'fixture document completion');

  await waitFor(async () => (
    await cdp.evaluate(`Boolean(document.querySelector('#small'))`)
  ), 5000, 80, 'fixture target element');

  const initialOverlay = await cdp.evaluate(
    `Boolean(document.querySelector('#page-slash-overlay-host'))`
  );
  assert(initialOverlay === false, 'Overlay should not exist before entering mode.');

  await delay(250);
  const extensionContext = cdp.contexts.find((entry) => (
    String(entry.origin || '').startsWith('chrome-extension://')
  ));
  assert(
    extensionContext,
    `Content script context not found. Contexts: ${JSON.stringify(
      cdp.contexts.map((entry) => ({ name: entry.name, origin: entry.origin, auxData: entry.auxData }))
    )}`
  );
  const coreAvailable = await cdp.evaluate(
    `Boolean(globalThis.PageSlashCore && globalThis.PageSlashDom)`,
    extensionContext.id
  );
  assert(coreAvailable, 'Content script context exists but core globals are missing.');

  await cdp.evaluate(`
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 's',
      code: 'KeyS',
      altKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true
    }));
  `);

  await waitFor(async () => (
    await cdp.evaluate(`Boolean(document.querySelector('#page-slash-overlay-host'))`)
  ), 5000, 80, 'slash overlay after toggle');

  const cursorHidden = await cdp.evaluate(
    `document.documentElement.style.getPropertyValue('cursor') === 'none'`
  );
  assert(cursorHidden, 'Native cursor should be hidden in slash mode.');

  const smallTarget = await cdp.evaluate(`
    (() => {
      const target = document.querySelector('#small');
      const rect = target.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        area: rect.width * rect.height
      };
    })();
  `);
  assert(
    smallTarget.area > 0 && smallTarget.area <= 4000,
    `Fixture #small must be in the one-hit tier, received ${smallTarget.area}px².`
  );

  await cdp.evaluate(`
    (() => {
      const target = document.querySelector('#small');
      const rect = target.getBoundingClientRect();
      const center = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
      };

      window.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        pointerType: 'mouse',
        clientX: center.x - 24,
        clientY: center.y - 24
      }));
      window.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        pointerType: 'mouse',
        clientX: center.x,
        clientY: center.y
      }));
      target.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 1,
        pointerType: 'mouse',
        clientX: center.x,
        clientY: center.y
      }));
    })();
  `, extensionContext.id);

  await cdp.evaluate(`
    document.querySelector('#small').getAnimations().forEach((animation) => {
      animation.finish();
    });
  `, extensionContext.id);

  await waitFor(async () => (
    await cdp.evaluate(
      `document.querySelector('#small').style.visibility === 'hidden'`
    )
  ), 3000, 80, 'target hidden after slash');

  await cdp.evaluate(`
    window.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2
    }));
  `, extensionContext.id);

  await waitFor(async () => (
    await cdp.evaluate(
      `!document.querySelector('#page-slash-overlay-host')
       && !document.querySelector('#small').getAttribute('style')`
    )
  ), 3000, 80, 'target restoration after exit');

  assert(cdp.exceptions.length === 0, `Browser exceptions: ${JSON.stringify(cdp.exceptions)}`);
  console.log(
    `smoke-ok: extension ${loadedExtension.id} loaded, mode toggled, target hid, and target restored.`
  );
} finally {
  cdp?.close();
  browserCdp?.close();
  await stopProcess(chromeProcess);
  await new Promise((resolvePromise) => fixtureServer.close(resolvePromise));

  const tempRoot = `${resolve(tmpdir())}${sep}`;
  const resolvedProfile = resolve(profileDirectory);
  if (resolvedProfile.startsWith(tempRoot)) {
    try {
      rmSync(resolvedProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    } catch {
      // Chrome can briefly retain a file handle after the process exits on Windows.
    }
  }
}
