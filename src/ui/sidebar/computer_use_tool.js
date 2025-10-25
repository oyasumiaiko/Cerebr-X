const MODE_AUTO = 'auto';
const MODE_MANUAL = 'manual';
const DEFAULT_ACTION_SETTLE_DELAY_MS = 1000; // 操作执行后等待页面稳定的默认延迟

function generateRequestId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createComputerUseTool(appContext) {
  const { dom, services, utils, state } = appContext;
  const computerUseApi = services.computerUseApi;
  const showNotification = utils.showNotification || (() => {});

  const pendingSnapshots = new Map();
  const pendingActions = new Map();

  let latestScreenshot = null;
  let latestScreenshotAt = 0;
  let latestNarration = '';
  let pendingActionQueue = [];
  let executionMode = MODE_AUTO;
  let currentSession = null;
  let isLoading = false;
  let unsubscribeConfig = null;
  let cachedConfig = computerUseApi?.getConfig?.() || {};
  let currentInstruction = '';
  let actionSettleDelayMs = normalizeDelay(
    typeof cachedConfig.actionSettleDelayMs === 'number'
      ? cachedConfig.actionSettleDelayMs
      : DEFAULT_ACTION_SETTLE_DELAY_MS
  );
  let pendingStateRestore = false;

  function normalizeDelay(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) return DEFAULT_ACTION_SETTLE_DELAY_MS;
    return Math.min(Math.round(num), 10000);
  }

  function formatDelayLabel(value) {
    const delay = Math.max(0, Number(value) || 0);
    if (delay >= 1000) {
      return `${(delay / 1000).toFixed(delay % 1000 === 0 ? 0 : 1)}s`;
    }
    return `${delay}ms`;
  }

  function updateDelayValue(value) {
    if (dom.computerUseDelayValue) {
      dom.computerUseDelayValue.textContent = formatDelayLabel(value);
    }
  }

  function cloneForTransport(value) {
    if (value === undefined) return undefined;
    if (typeof structuredClone === 'function') {
      try {
        return structuredClone(value);
      } catch (error) {
        console.warn('structuredClone 失败，回退 JSON 序列化', error);
      }
    }
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (error) {
      console.warn('克隆数据失败:', error);
      return null;
    }
  }

  function postToParent(type, payload) {
    try {
      window.parent.postMessage({ type, payload }, '*');
    } catch (error) {
      console.warn('发送电脑操作消息到父窗口失败:', error);
    }
  }

  function clearSessionState(reason = 'clear') {
    postToParent('COMPUTER_USE_CLEAR_STATE', { reason });
  }

  function syncSessionState(overrides = {}) {
    const {
      status = 'active',
      finishReason = null,
      pendingResponses = undefined,
      note = undefined,
      awaitingRecovery = status === 'closing'
    } = overrides;

    if (!currentSession) {
      postToParent('COMPUTER_USE_SYNC_STATE', {
        status,
        finishReason,
        pendingResponses,
        note,
        session: null,
        updatedAt: Date.now(),
        awaitingRecovery
      });
      return;
    }

    const payload = {
      status,
      finishReason,
      pendingResponses,
      note,
      session: cloneForTransport(currentSession),
      pendingActions: cloneForTransport(pendingActionQueue),
      narration: latestNarration,
      instruction: currentInstruction,
      executionMode,
      latestScreenshotAt,
      actionSettleDelayMs,
      url: window.location.href,
      title: document.title,
      updatedAt: Date.now(),
      awaitingRecovery
    };
    postToParent('COMPUTER_USE_SYNC_STATE', payload);
  }

  function requestSessionState() {
    if (pendingStateRestore) return;
    pendingStateRestore = true;
    postToParent('COMPUTER_USE_REQUEST_STATE');
  }

  function init() {
    if (!dom.computerUseMenuItem || !dom.computerUsePanel) return;

    if (typeof computerUseApi?.init === 'function') {
      computerUseApi
        .init()
        .catch((error) => console.warn('初始化电脑操作配置失败:', error))
        .finally(() => {
          bindConfigSubscription();
          setupConfigFields();
        });
    } else {
      bindConfigSubscription();
      setupConfigFields();
    }

    dom.computerUseMenuItem.addEventListener('click', () => {
      if (state.isStandalone) {
        showNotification({ message: '独立聊天页面暂不支持电脑操作工具', type: 'warning' });
        return;
      }
      utils.closeExclusivePanels?.();
      openPanel();
    });

    dom.computerUseBackButton?.addEventListener('click', closePanel);
    dom.computerUseRunButton?.addEventListener('click', handleRunRequest);
    dom.computerUseCaptureButton?.addEventListener('click', () => refreshScreenshot({ silent: false }));
    dom.computerUseStepButton?.addEventListener('click', handleStepExecution);
    setupInstructionShortcuts();
    setupSessionBridge();
    requestSessionState();

    executionMode = cachedConfig.executionMode || MODE_AUTO;
    setExecutionMode(executionMode, { persist: false, updateUI: true });
  }

  function bindConfigSubscription() {
    if (typeof computerUseApi?.subscribe !== 'function') return;
    if (unsubscribeConfig) unsubscribeConfig();
    unsubscribeConfig = computerUseApi.subscribe((config) => {
      cachedConfig = config || {};
      if (typeof cachedConfig.actionSettleDelayMs === 'number') {
        actionSettleDelayMs = normalizeDelay(cachedConfig.actionSettleDelayMs);
      }
      populateConfigFields(config || {});
    });
  }

  function setupConfigFields() {
    const {
      computerUseApiKey,
      computerUseToggleKey,
      computerUseModelInput,
      computerUseTempSlider,
      computerUseDelaySlider,
      computerUseModeAuto,
      computerUseModeManual
    } = dom;

    computerUseApiKey?.addEventListener('change', () => saveConfig({ apiKey: computerUseApiKey.value.trim() }));
    computerUseModelInput?.addEventListener('change', () => saveConfig({ modelName: computerUseModelInput.value.trim() }));

    if (computerUseTempSlider) {
      computerUseTempSlider.addEventListener('input', () => updateTempValue(Number(computerUseTempSlider.value)));
      computerUseTempSlider.addEventListener('change', () => saveConfig({ temperature: Number(computerUseTempSlider.value) }));
    }

    if (computerUseDelaySlider) {
      computerUseDelaySlider.addEventListener('input', () => updateDelayValue(Number(computerUseDelaySlider.value)));
      computerUseDelaySlider.addEventListener('change', () => {
        const nextDelay = normalizeDelay(Number(computerUseDelaySlider.value));
        actionSettleDelayMs = nextDelay;
        saveConfig({ actionSettleDelayMs: nextDelay });
        if (currentSession) {
          syncSessionState({ status: 'active', pendingResponses: [] });
        }
      });
    }

    computerUseToggleKey?.addEventListener('click', () => {
      if (!computerUseApiKey) return;
      const isPassword = computerUseApiKey.getAttribute('type') === 'password';
      computerUseApiKey.setAttribute('type', isPassword ? 'text' : 'password');
      const icon = computerUseToggleKey.querySelector('i');
      if (icon) {
        icon.classList.toggle('fa-eye', !isPassword);
        icon.classList.toggle('fa-eye-slash', isPassword);
      }
    });

    computerUseModeAuto?.addEventListener('change', () => {
      if (computerUseModeAuto.checked) setExecutionMode(MODE_AUTO);
    });
    computerUseModeManual?.addEventListener('change', () => {
      if (computerUseModeManual.checked) setExecutionMode(MODE_MANUAL);
    });
  }

  function populateConfigFields(config) {
    if (dom.computerUseApiKey && document.activeElement !== dom.computerUseApiKey) {
      dom.computerUseApiKey.value = config.apiKey || '';
    }
    if (dom.computerUseModelInput && document.activeElement !== dom.computerUseModelInput) {
      dom.computerUseModelInput.value = config.modelName || 'gemini-2.5-computer-use-preview-10-2025';
    }
    const temperature = typeof config.temperature === 'number' ? config.temperature : 0.2;
    updateTempValue(temperature);
    if (dom.computerUseTempSlider && document.activeElement !== dom.computerUseTempSlider) {
      dom.computerUseTempSlider.value = String(temperature);
    }

    if (dom.computerUseDelaySlider && document.activeElement !== dom.computerUseDelaySlider) {
      const delay = normalizeDelay(config.actionSettleDelayMs ?? actionSettleDelayMs);
      dom.computerUseDelaySlider.value = String(delay);
      actionSettleDelayMs = delay;
      updateDelayValue(delay);
    } else {
      updateDelayValue(actionSettleDelayMs);
    }

    const mode = config.executionMode || executionMode;
    setExecutionMode(mode, { persist: false, updateUI: true });
  }

  function updateTempValue(value) {
    if (dom.computerUseTempValue) {
      dom.computerUseTempValue.textContent = value.toFixed(2).replace(/\.00$/, '.0');
    }
  }

  function saveConfig(partial) {
    if (typeof computerUseApi?.saveConfig !== 'function') return;
    computerUseApi.saveConfig(partial).catch((error) => {
      console.error('保存电脑操作配置失败:', error);
      setStatus(error.message || '保存电脑操作配置失败', 'error');
    });
  }

  function setExecutionMode(mode, { persist = true, updateUI = false } = {}) {
    const normalized = mode === MODE_MANUAL ? MODE_MANUAL : MODE_AUTO;
    executionMode = normalized;

    if (updateUI) {
      if (dom.computerUseModeAuto) dom.computerUseModeAuto.checked = executionMode === MODE_AUTO;
      if (dom.computerUseModeManual) dom.computerUseModeManual.checked = executionMode === MODE_MANUAL;
    }

    if (persist) {
      saveConfig({ executionMode });
    }

    updateStepButtonState();
    renderActionsList();

    if (executionMode === MODE_AUTO) {
      if (pendingActionQueue.length) {
        runActionsSequence();
      } else if (currentSession) {
        setStatus('等待模型返回新动作...', 'info');
      }
    } else if (executionMode === MODE_MANUAL) {
      if (pendingActionQueue.length) {
        setStatus('已生成操作，请点击 >| 执行下一步。', 'info');
      } else if (currentSession) {
        setStatus('等待模型返回新动作，稍后点击 >|。', 'info');
      }
    }

    if (currentSession) {
      syncSessionState({ status: 'active', pendingResponses: [] });
    }
  }

  function openPanel() {
    dom.computerUsePanel.classList.add('visible');
  }

  function closePanel() {
    dom.computerUsePanel.classList.remove('visible');
  }

  function setStatus(text, type = 'info') {
    if (!dom.computerUseStatus) return;
    dom.computerUseStatus.textContent = text || '';
    dom.computerUseStatus.dataset.statusType = type;
  }

  function setLoading(next, message) {
    isLoading = next;
    if (dom.computerUseRunButton) dom.computerUseRunButton.disabled = next;
    if (dom.computerUseCaptureButton) dom.computerUseCaptureButton.disabled = next;
    updateStepButtonState();
    if (next && message) setStatus(message, 'info');
  }

  function updateStepButtonState() {
    if (!dom.computerUseStepButton) return;
    if (executionMode !== MODE_MANUAL) {
      dom.computerUseStepButton.style.display = 'none';
      return;
    }
    dom.computerUseStepButton.style.display = '';
    dom.computerUseStepButton.disabled = isLoading || pendingActionQueue.length === 0;
  }

  function updatePendingActions(actions = []) {
    pendingActionQueue = Array.isArray(actions) ? actions.map((action) => JSON.parse(JSON.stringify(action))) : [];
    renderActionsList();
    updateStepButtonState();
  }

  function renderActionsList() {
    if (dom.computerUseNarration) {
      dom.computerUseNarration.textContent = latestNarration || '尚无内容';
    }

    const list = dom.computerUseActionList;
    if (!list) return;
    list.innerHTML = '';

    if (!pendingActionQueue.length) {
      const empty = document.createElement('div');
      empty.className = 'computer-use-empty';
      empty.textContent = executionMode === MODE_MANUAL
        ? '暂无待执行动作，请等待模型返回。'
        : '暂无待执行动作。';
      list.appendChild(empty);
      return;
    }

    pendingActionQueue.forEach((action, idx) => {
      const card = document.createElement('div');
      card.className = 'computer-use-action-card';
      if (idx === 0) card.classList.add('next-action');

      const header = document.createElement('div');
      header.className = 'action-header';
      header.innerHTML = `<span class="action-index">#${idx + 1}</span><span class="action-name">${action.name}</span>`;
      card.appendChild(header);

      const argList = document.createElement('div');
      argList.className = 'action-args';
      const argsEntries = Object.entries(action.args || {});
      if (!argsEntries.length) {
        argList.textContent = '无参数';
      } else {
        argsEntries.forEach(([key, value]) => {
          const item = document.createElement('div');
          item.className = 'action-arg-item';
          item.textContent = `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`;
          argList.appendChild(item);
        });
      }
      card.appendChild(argList);

      list.appendChild(card);
    });
  }

  function requestScreenshot() {
    return new Promise((resolve, reject) => {
      const requestId = generateRequestId('snap');
      const timeout = setTimeout(() => {
        pendingSnapshots.delete(requestId);
        reject(new Error('截图请求超时'));
      }, 15000);
      pendingSnapshots.set(requestId, { resolve, reject, timeout });
      window.parent.postMessage({ type: 'REQUEST_COMPUTER_USE_SNAPSHOT', requestId }, '*');
    });
  }

  async function refreshScreenshot({ silent = false } = {}) {
    try {
      if (!silent) setLoading(true, '正在截取网页截图...');
      const dataUrl = await requestScreenshot();
      latestScreenshot = dataUrl;
      latestScreenshotAt = Date.now();
      updateSnapshotMeta();
      if (!silent) setStatus('截图更新完成，可以继续生成操作。', 'success');
      return latestScreenshot;
    } catch (error) {
      console.error('刷新截图失败:', error);
      if (!silent) setStatus(error.message || '截图失败', 'error');
      throw error;
    } finally {
      if (!silent) setLoading(false);
    }
  }

  function updateSnapshotMeta() {
    if (!dom.computerUseSnapshotLabel) return;
    if (!latestScreenshotAt) {
      dom.computerUseSnapshotLabel.textContent = '当前截图：尚未生成';
    } else {
      const diff = Math.round((Date.now() - latestScreenshotAt) / 1000);
      dom.computerUseSnapshotLabel.textContent = `当前截图：${diff}s 前获取`;
    }
  }

  async function handleRunRequest() {
    if (!computerUseApi) {
      setStatus('尚未初始化 Gemini API 配置', 'error');
      return;
    }

    const instruction = (dom.computerUseInstruction?.value || '').trim();
    if (!instruction) {
      setStatus('请先输入要执行的指令', 'warning');
      dom.computerUseInstruction?.focus();
      return;
    }

    if (isLoading) {
      setStatus('正在处理上一条指令，请稍候...', 'warning');
      return;
    }

    if (!cachedConfig?.apiKey) {
      setStatus('请先在上方填写电脑操作专用 API Key', 'warning');
      dom.computerUseApiKey?.focus();
      return;
    }

    try {
      pendingStateRestore = false;
      currentInstruction = instruction;
      currentSession = null;
      latestNarration = '';
      updatePendingActions([]);
      clearSessionState('restart');

      setLoading(true, '正在更新截图...');
      await refreshScreenshot({ silent: true });
      const screenshot = latestScreenshot;
      if (!screenshot) throw new Error('截图失败，无法构建请求');

      setLoading(true, '正在向 Gemini 请求操作...');
      const startResult = await computerUseApi.startSession({ instruction, screenshotDataUrl: screenshot });
      currentSession = startResult.session;
      latestNarration = startResult.narration || '';
      const initialActions = startResult.actions || [];
      updatePendingActions(initialActions);
      setLoading(false);
      syncSessionState({ status: 'active', pendingResponses: [] });

      const hasActions = initialActions.length > 0;
      const shouldStop = !hasActions && startResult.finishReason === 'STOP';

      if (!currentSession || shouldStop) {
        currentSession = null;
        setStatus('电脑操作流程完成。', 'success');
        clearSessionState('completed');
        return;
      }

      if (executionMode === MODE_AUTO) {
        await runActionsSequence();
      } else if (hasActions) {
        setStatus('已生成操作，请点击 >| 执行下一步。', 'info');
      } else {
        setStatus('等待模型返回新动作，稍后点击 >|。', 'info');
      }
    } catch (error) {
      console.error('调用 Gemini Computer Use 失败:', error);
      setStatus(error.message || '请求失败，请检查控制台日志', 'error');
      setLoading(false);
      clearSessionState('error');
    }
  }

  function requestAction(action) {
    return new Promise((resolve, reject) => {
      if (!action || typeof action !== 'object') {
        reject(new Error('缺少动作参数'));
        return;
      }
      const requestId = generateRequestId('act');
      const timeout = setTimeout(() => {
        pendingActions.delete(requestId);
        reject(new Error('执行动作超时'));
      }, 15000);
      pendingActions.set(requestId, { resolve, reject, timeout });
      window.parent.postMessage({ type: 'PERFORM_COMPUTER_USE_ACTION', requestId, action }, '*');
    });
  }

  function extractBase64(dataUrl) {
    if (!dataUrl) return '';
    const commaIndex = dataUrl.indexOf(',');
    return commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
  }

  async function executeAction(action) {
    if (!action || !action.name) {
      setStatus('无效的动作数据，无法执行。', 'error');
      syncSessionState({ status: 'error', note: 'invalid-action' });
      return null;
    }

    const workingAction = JSON.parse(JSON.stringify(action));
    const safetyDecision = workingAction?.args?.safety_decision;
    if (safetyDecision?.decision === 'require_confirmation') {
      const confirmed = await utils.showConfirm?.({
        message: '执行敏感操作确认',
        description: safetyDecision.explanation || '模型请求执行敏感操作，是否继续？',
        confirmText: '继续执行',
        cancelText: '取消',
        type: 'warning'
      });
      if (!confirmed) {
        setStatus('用户取消了敏感操作执行。', 'warning');
        return null;
      }
      workingAction.args.safety_acknowledgement = true;
    }

    try {
      setStatus(`正在执行动作：${workingAction.name}`, 'info');
      const result = await requestAction(workingAction);
      if (!result?.success) {
        setStatus(result?.error || `动作 ${workingAction.name} 执行失败`, 'error');
        syncSessionState({ status: 'error', note: 'action-execution-failed' });
        return null;
      }

      if (result.navigation) {
        setStatus('已触发页面导航，正在等待浏览器更新...', 'success');
      } else if (result.selector) {
        setStatus(`动作完成：${result.selector}`, 'success');
      } else {
        setStatus('动作执行完成', 'success');
      }

      try {
        const delayMs = Math.max(0, Number(actionSettleDelayMs) || 0);
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        await refreshScreenshot({ silent: true });
      } catch (_) {}

      const base64 = extractBase64(latestScreenshot);
      const responsePayload = {
        success: true,
        url: result.url || window.location.href
      };
      if (result.navigation) responsePayload.navigation = true;
      if (result.selector) responsePayload.selector = result.selector;
      if (result.info) responsePayload.info = result.info;
      if (workingAction?.args?.safety_acknowledgement) {
        responsePayload.safety_acknowledgement = true;
      }

      const functionResponse = {
        name: workingAction.name,
        id: workingAction.callId || workingAction.id || workingAction.call_id || null,
        response: responsePayload,
        parts: base64 ? [{ inline_data: { mime_type: 'image/png', data: base64 } }] : []
      };

      syncSessionState({
        status: result.navigation ? 'waiting-navigation' : 'pending-response',
        pendingResponses: [cloneForTransport(functionResponse)],
        note: result.navigation ? 'navigation' : undefined
      });

      return functionResponse;
    } catch (error) {
      console.error('执行电脑操作动作失败:', error);
      setStatus(error.message || `动作 ${workingAction.name} 执行失败`, 'error');
      syncSessionState({ status: 'error', note: error?.message || 'action-error' });
      return null;
    }
  }

  async function runActionsSequence(initialActions) {
    if (Array.isArray(initialActions)) {
      updatePendingActions(initialActions);
    }

    while (executionMode === MODE_AUTO && pendingActionQueue.length > 0) {
      syncSessionState({ status: 'executing', pendingResponses: [], note: 'auto-sequence' });
      const action = pendingActionQueue.shift();
      renderActionsList();
      updateStepButtonState();
      const response = await executeAction(action);
      if (!response) return;
      await advanceSessionWithResponses([response], { triggerAuto: false });
      if (executionMode !== MODE_AUTO) return;
    }

    if (executionMode === MODE_AUTO && currentSession && pendingActionQueue.length === 0) {
      setStatus('等待模型返回新动作...', 'info');
    }

    if (currentSession) {
      syncSessionState({ status: 'active', pendingResponses: [] });
    }
  }

  async function advanceSessionWithResponses(responses, { triggerAuto = executionMode === MODE_AUTO } = {}) {
    if (!currentSession) return;
    try {
      setLoading(true, '正在请求下一步动作...');
      const next = await computerUseApi.continueSession({
        session: currentSession,
        functionResponses: responses
      });
      currentSession = next.session;
      latestNarration = next.narration || '';
      const newActions = next.actions || [];
      updatePendingActions(newActions);
      setLoading(false);
      syncSessionState({ status: 'active', pendingResponses: [] });

      const hasActions = newActions.length > 0;
      const shouldStop = !hasActions && next.finishReason === 'STOP';

      if (!currentSession || shouldStop) {
        currentSession = null;
        setStatus('电脑操作流程完成。', 'success');
        clearSessionState('completed');
        return;
      }

      if (triggerAuto && executionMode === MODE_AUTO) {
        await runActionsSequence();
      } else if (executionMode === MODE_MANUAL) {
        if (hasActions) {
          setStatus('已生成新动作，请点击 >| 执行下一步。', 'info');
        } else {
          setStatus('等待模型返回新动作，稍后点击 >|。', 'info');
        }
      }
    } catch (error) {
      console.error('继续电脑操作流程失败:', error);
      setStatus(error.message || '继续执行失败', 'error');
      setLoading(false);
      syncSessionState({
        status: 'error',
        pendingResponses: cloneForTransport(responses),
        note: error?.message || 'continue-failed'
      });
    }
  }

  async function handleStepExecution() {
    if (executionMode !== MODE_MANUAL || isLoading) return;
    if (!currentSession) {
      setStatus('请先点击“生成操作”。', 'warning');
      return;
    }
    if (!pendingActionQueue.length) {
      setStatus('暂无可执行动作，等待模型响应。', 'info');
      return;
    }

    const action = pendingActionQueue.shift();
    renderActionsList();
    updateStepButtonState();
    syncSessionState({ status: 'executing', pendingResponses: [], note: 'manual-step' });
    const response = await executeAction(action);
    if (!response) return;
    await advanceSessionWithResponses([response], { triggerAuto: false });
  }

  function handleSnapshotResult(message) {
    if (!message.requestId) return;
    const entry = pendingSnapshots.get(message.requestId);
    if (!entry) return;
    clearTimeout(entry.timeout);
    pendingSnapshots.delete(message.requestId);
    if (message.success && message.dataURL) {
      entry.resolve(message.dataURL);
    } else {
      entry.reject(new Error(message.error || '截图失败'));
    }
  }

  function handleActionResult(message) {
    if (!message.requestId) return;
    const entry = pendingActions.get(message.requestId);
    if (!entry) return;
    clearTimeout(entry.timeout);
    pendingActions.delete(message.requestId);
    if (message.success) {
      entry.resolve(message);
    } else {
      entry.reject(new Error(message.error || '动作执行失败'));
    }
  }

  function setupInstructionShortcuts() {
    if (!dom.computerUseInstruction) return;
    dom.computerUseInstruction.addEventListener('keydown', (event) => {
      if (
        event.key === 'Enter' &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey
      ) {
        event.preventDefault();
        if (!isLoading) handleRunRequest();
      }
    });
  }

  function setupSessionBridge() {
    try {
      window.addEventListener('pageshow', () => {
        requestSessionState();
      });
      window.addEventListener('beforeunload', () => {
        if (currentSession) {
          syncSessionState({ status: 'closing' });
        }
      });
    } catch (error) {
      console.warn('注册 session bridge 失败:', error);
    }
  }

  function handleSessionState(message) {
    pendingStateRestore = false;
    if (!message?.ok) {
      setStatus(message?.error || '无法恢复电脑操作会话。', 'warning');
      return;
    }
    const state = message.payload;
    if (!state || !state.session) return;
    if (currentSession) return;

    currentSession = state.session;
    latestNarration = state.narration || '';
    currentInstruction = state.instruction || currentInstruction || '';
    actionSettleDelayMs = normalizeDelay(state.actionSettleDelayMs ?? actionSettleDelayMs);
    latestScreenshotAt = state.latestScreenshotAt || latestScreenshotAt;

    if (dom.computerUseInstruction && currentInstruction) {
      dom.computerUseInstruction.value = currentInstruction;
    }
    if (dom.computerUseDelaySlider) {
      dom.computerUseDelaySlider.value = String(actionSettleDelayMs);
    }
    updateDelayValue(actionSettleDelayMs);

    updatePendingActions(state.pendingActions || []);
    if (state.executionMode && state.executionMode !== executionMode) {
      setExecutionMode(state.executionMode, { persist: false, updateUI: true });
    } else {
      updateStepButtonState();
    }

    if (latestNarration && dom.computerUseNarration) {
      dom.computerUseNarration.textContent = latestNarration;
    }

    const status = state.status || 'active';
    const pendingResponses = Array.isArray(state.pendingResponses) ? state.pendingResponses : [];

    if (status === 'active') {
      if (executionMode === MODE_AUTO && pendingActionQueue.length > 0) {
        setStatus('导航完成，继续执行自动操作...', 'info');
        setTimeout(() => {
          runActionsSequence();
        }, 0);
      } else if (pendingActionQueue.length > 0) {
        setStatus('已恢复操作，请点击 >| 执行下一步。', 'info');
      } else {
        setStatus('已恢复会话，等待模型返回新动作。', 'info');
      }
    } else if (status === 'closing') {
      setStatus('页面正在重新加载，稍后将尝试恢复会话。', 'info');
    } else if (status === 'pending-response' || status === 'waiting-navigation') {
      setStatus('检测到待继续的操作，正在恢复...', 'info');
    } else if (status === 'continuing') {
      setStatus('正在恢复电脑操作流程...', 'info');
    } else if (status === 'executing') {
      setStatus('正在执行电脑操作...', 'info');
    }

    if (pendingResponses.length > 0 && currentSession) {
      // 去重：防止重复提交
      syncSessionState({ status: 'continuing', pendingResponses, note: 'restoring-responses' });
      advanceSessionWithResponses(pendingResponses, { triggerAuto: executionMode === MODE_AUTO }).catch((error) => {
        console.error('恢复电脑操作 pendingResponses 失败:', error);
        setStatus(error?.message || '恢复操作失败，请重新生成', 'error');
        syncSessionState({ status: 'error', note: 'restore-failed' });
      });
    } else if (status === 'closing') {
      // 等待下一次 pageshow 再处理
      setTimeout(() => {
        requestSessionState();
      }, 1200);
    } else {
      syncSessionState({ status: 'active', pendingResponses: [] });
    }
  }

  return {
    init,
    openPanel,
    closePanel,
    handleSnapshotResult,
    handleActionResult,
    handleSessionState
  };
}
