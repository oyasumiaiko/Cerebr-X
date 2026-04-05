const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const [
  repoRoot,
  outputDir,
  chromePath,
  baseUrl,
  apiKey,
  modelName,
  scenario = 'single',
  useStreamingArg = 'true'
] = process.argv.slice(2);

if (!repoRoot || !outputDir || !chromePath || !baseUrl || !apiKey || !modelName) {
  throw new Error(
    'Usage: node tests/cdp_sidebar_smoke.cjs <repoRoot> <outputDir> <chromePath> <baseUrl> <apiKey> <modelName> [scenario=single|queue] [useStreaming=true|false]'
  );
}

const useStreaming = useStreamingArg !== 'false';

function loadPlaywright() {
  const candidateBases = [
    process.cwd(),
    repoRoot,
    path.join(repoRoot, 'node_modules'),
    path.join(os.tmpdir(), 'cerebr-playwright-cdp'),
    path.join(os.tmpdir(), 'cerebr-playwright-cdp', 'node_modules')
  ];
  for (const base of candidateBases) {
    try {
      const resolved = require.resolve('playwright', { paths: [base] });
      return require(resolved);
    } catch (_) {}
  }
  throw new Error(
    'Cannot resolve playwright. Tried repo-local paths and the known temp harness cache under %TEMP%\\\\cerebr-playwright-cdp.'
  );
}

const { chromium } = loadPlaywright();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
    server.on('error', reject);
  });
}

async function waitFor(condition, { timeoutMs = 30000, intervalMs = 200, label = 'condition' } = {}) {
  const startedAt = Date.now();
  while (true) {
    try {
      const value = await condition();
      if (value) return value;
    } catch (error) {
      if (Date.now() - startedAt >= timeoutMs) throw error;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await sleep(intervalMs);
  }
}

async function listCdpTargets(cdpPort) {
  const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
  if (!response.ok) throw new Error(`failed to list CDP targets: HTTP ${response.status}`);
  return await response.json();
}

async function createCdpTargetSession(webSocketDebuggerUrl) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', (event) => reject(event.error || new Error('cdp websocket error')));
  });

  ws.addEventListener('message', (event) => {
    const payload = JSON.parse(String(event.data));
    if (!payload || typeof payload !== 'object') return;
    if (!payload.id || !pending.has(payload.id)) return;
    const entry = pending.get(payload.id);
    pending.delete(payload.id);
    if (payload.error) {
      entry.reject(new Error(payload.error.message || JSON.stringify(payload.error)));
      return;
    }
    entry.resolve(payload.result || {});
  });

  const send = (method, params = {}) => {
    nextId += 1;
    const id = nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  await send('Runtime.enable');

  return {
    async evaluate(expression) {
      const evaluation = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true
      });
      if (evaluation.exceptionDetails) {
        throw new Error(evaluation.exceptionDetails.text || evaluation.result?.description || 'Runtime.evaluate failed');
      }
      return evaluation.result?.value;
    },
    close() {
      try { ws.close(); } catch (_) {}
    }
  };
}

function buildSendContentMessageExpression(messageLiteral) {
  return `(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || typeof tab.id !== 'number') throw new Error('active tab not found');
    const response = await chrome.tabs.sendMessage(tab.id, ${messageLiteral});
    return { tabId: tab.id, response };
  })()`;
}

function buildStorageSeed() {
  return {
    apiConfigs: [{
      id: 'cfg_real_responses_sidebar_smoke',
      displayName: 'Real Responses Sidebar Smoke',
      modelName,
      baseUrl,
      connectionType: 'openai_responses',
      apiKey,
      customParams: '',
      customSystemPrompt: '',
      temperature: 1,
      useStreaming,
      responsesApiSettings: {
        reasoning: {
          effort: 'medium',
          generate_summary: 'detailed',
          summary: 'detailed'
        },
        text: {
          verbosity: 'low'
        },
        parallel_tool_calls: true,
        store: false,
        builtin_tools: {
          web_search: {
            enabled: true,
            external_web_access: true,
            include_sources: true
          }
        }
      }
    }],
    selectedConfigIndex: 0,
    sendChatHistory: true,
    showThoughtProcess: true,
    queueCurrentConversationMessages: true
  };
}

function buildPrompt(currentScenario) {
  if (currentScenario === 'queue') {
    return {
      first: 'Please directly call js_runtime_execute on the current page and briefly report document.title and location.href.',
      second: 'This is a second message that should enter the queue if the first one is still running.'
    };
  }
  return {
    first: 'Please directly call js_runtime_execute on the current page and read document.title, location.href, and document.readyState. Then reply briefly. Avoid web search unless absolutely necessary.'
  };
}

async function main() {
  await fsp.mkdir(outputDir, { recursive: true });

  const result = {
    startedAt: new Date().toISOString(),
    outputDir,
    baseUrl,
    modelName,
    useStreaming,
    scenario,
    console: [],
    backgroundConsole: [],
    steps: []
  };

  const cdpPort = await getFreePort();
  const profileDir = path.join(os.tmpdir(), `cerebr-cdp-sidebar-${Date.now()}`);
  await fsp.mkdir(profileDir, { recursive: true });

  const chromeArgs = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    `--disable-extensions-except=${repoRoot}`,
    `--load-extension=${repoRoot}`,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    'about:blank'
  ];
  const chrome = spawn(chromePath, chromeArgs, { stdio: 'ignore', windowsHide: false });

  let browser = null;
  let backgroundSession = null;
  try {
    await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
        return response.ok;
      } catch (_) {
        return false;
      }
    }, { timeoutMs: 30000, label: 'cdp endpoint' });
    result.steps.push('cdp_ready');

    const backgroundTarget = await waitFor(async () => {
      const targets = await listCdpTargets(cdpPort);
      return targets.find((target) => typeof target?.url === 'string' && target.url.endsWith('/src/extension/background.js')) || null;
    }, { timeoutMs: 30000, intervalMs: 500, label: 'background target' });
    const extensionId = new URL(backgroundTarget.url).host;
    backgroundSession = await createCdpTargetSession(backgroundTarget.webSocketDebuggerUrl);
    result.extensionId = extensionId;
    result.steps.push('background_ready');

    await backgroundSession.evaluate(`(async () => {
      await chrome.storage.sync.clear();
      await chrome.storage.sync.set(${JSON.stringify(buildStorageSeed())});
      return true;
    })()`);
    result.steps.push('storage_seeded');

    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    const context = await waitFor(async () => browser.contexts()[0] || null, { timeoutMs: 10000, label: 'browser context' });
    const page = await context.newPage();
    page.on('console', (msg) => {
      result.console.push({ type: msg.type(), text: msg.text() });
    });
    page.on('pageerror', (error) => {
      result.console.push({ type: 'pageerror', text: String(error && (error.stack || error.message || error)) });
    });

    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    result.steps.push('page_loaded');

    const preOpenSidebarState = await waitFor(async () => {
      const payload = await backgroundSession.evaluate(
        buildSendContentMessageExpression(JSON.stringify({ type: 'GET_SIDEBAR_DEBUG_STATE' }))
      );
      const debugState = payload?.response?.debugState || null;
      return debugState?.initialized ? payload : null;
    }, { timeoutMs: 15000, intervalMs: 250, label: 'sidebar initialized before open' });
    result.preOpenSidebarState = preOpenSidebarState;
    result.steps.push('sidebar_initialized');

    const openSidebarResponse = await backgroundSession.evaluate(
      buildSendContentMessageExpression(JSON.stringify({ type: 'OPEN_SIDEBAR' }))
    );
    result.openSidebarResponse = openSidebarResponse;
    if (!openSidebarResponse?.response?.success || openSidebarResponse?.response?.status !== true) {
      throw new Error(`OPEN_SIDEBAR did not report visible=true: ${JSON.stringify(openSidebarResponse)}`);
    }
    result.steps.push('sidebar_open_requested');

    const sidebarDebugState = await waitFor(async () => {
      const payload = await backgroundSession.evaluate(
        buildSendContentMessageExpression(JSON.stringify({ type: 'GET_SIDEBAR_DEBUG_STATE' }))
      );
      const state = payload?.response?.debugState || null;
      return state?.isActuallyVisible ? state : null;
    }, { timeoutMs: 15000, intervalMs: 250, label: 'sidebar actual visibility' });
    result.sidebarDebugState = sidebarDebugState;
    result.steps.push('sidebar_visible_confirmed');

    const sidebarFrame = await waitFor(async () => {
      return page.frames().find((frame) => frame.url().startsWith(`chrome-extension://${extensionId}/src/ui/sidebar/sidebar.html`)) || null;
    }, { timeoutMs: 30000, label: 'sidebar frame' });
    await sidebarFrame.locator('#message-input').waitFor({ state: 'visible', timeout: 30000 });
    await page.screenshot({ path: path.join(outputDir, '01-sidebar-visible.png'), fullPage: true });
    result.steps.push('sidebar_frame_ready');

    async function sendSidebarMessage(text) {
      const input = sidebarFrame.locator('#message-input');
      await input.focus();
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');
      await page.keyboard.type(text);
      await page.keyboard.press('Enter');
    }

    const prompts = buildPrompt(scenario);
    await sendSidebarMessage(prompts.first);
    result.steps.push('first_message_sent');

    if (scenario === 'queue') {
      await waitFor(async () => {
        return await sidebarFrame.evaluate(() => {
          const latestAi = Array.from(document.querySelectorAll('.message.ai-message')).slice(-1)[0] || null;
          return latestAi?.classList?.contains('updating') ? true : null;
        });
      }, { timeoutMs: 15000, intervalMs: 200, label: 'first message streaming' });

      await sendSidebarMessage(prompts.second);
      result.steps.push('second_message_sent');

      result.queueVisible = await waitFor(async () => {
        return await sidebarFrame.evaluate(() => {
          const panel = document.querySelector('.conversation-send-queue-preview');
          if (!panel) return null;
          const count = panel.querySelectorAll('.conversation-send-queue-preview__item').length;
          if (count <= 0) return null;
          return {
            count,
            text: (panel.innerText || '').trim()
          };
        });
      }, { timeoutMs: 20000, intervalMs: 250, label: 'queue preview visible' });
      result.steps.push('queue_visible');
    }

    const settled = await waitFor(async () => {
      return await sidebarFrame.evaluate((currentScenario) => {
        const aiMessages = Array.from(document.querySelectorAll('.message.ai-message'));
        const completed = aiMessages.filter((el) => !el.classList.contains('updating'));
        if (currentScenario === 'queue') {
          if (completed.length < 2) return null;
          return {
            completedCount: completed.length,
            latestText: (completed[completed.length - 1]?.innerText || '').trim()
          };
        }
        const latest = aiMessages[aiMessages.length - 1];
        if (!latest) return null;
        if (latest.classList.contains('updating')) return null;
        const text = (latest.innerText || '').trim();
        if (!text) return null;
        const timeline = latest.querySelector('.response-activity-timeline');
        return {
          text,
          hasTimeline: !!timeline,
          toolCount: timeline ? timeline.querySelectorAll('.response-activity-entry--tool').length : 0,
          panelExpanded: timeline ? timeline.classList.contains('is-expanded') : null,
          runtimeStatus: latest.dataset.responseRuntimeStatus || null
        };
      }, scenario);
    }, { timeoutMs: 180000, intervalMs: 500, label: 'assistant settled' });
    result.assistant = settled;
    result.highlightWarnings = result.console.filter((entry) => String(entry.text || '').includes('Element previously highlighted'));
    await page.screenshot({ path: path.join(outputDir, '02-final.png'), fullPage: true });
    result.steps.push('assistant_settled');

    result.finishedAt = new Date().toISOString();
    await fsp.writeFile(path.join(outputDir, 'cdp-sidebar-smoke-result.json'), JSON.stringify(result, null, 2), 'utf8');
  } finally {
    try { backgroundSession?.close?.(); } catch (_) {}
    try { await browser?.close(); } catch (_) {}
    try {
      if (chrome?.pid) {
        spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
      }
    } catch (_) {}
  }
}

main().catch(async (error) => {
  const payload = {
    error: String(error && (error.stack || error.message || error)),
    finishedAt: new Date().toISOString()
  };
  try {
    await fsp.mkdir(outputDir, { recursive: true });
    await fsp.writeFile(path.join(outputDir, 'cdp-sidebar-smoke-result.json'), JSON.stringify(payload, null, 2), 'utf8');
  } catch (_) {}
  process.exitCode = 1;
});
