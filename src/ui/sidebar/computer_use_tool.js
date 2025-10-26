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
let isAutoMode = true;
let pendingStateRestore = false;
let historyEntries = [];
let currentRoundId = null;
let chatInputDraft = { text: '', images: '' };
let computerUseDraft = { text: '', images: '' };
let originalPlaceholder = '';
let isComputerUseInputActive = false;

  function getPageInfo() {
    const info = appContext.state?.pageInfo;
    if (info && info.url) return info;
    const fallback = typeof window.cerebr === 'object' ? window.cerebr?.pageInfo : null;
    return fallback || {};
  }

  function getPageUrl() {
    const info = getPageInfo();
    if (info.url) return info.url;
    if (Array.isArray(historyEntries) && historyEntries.length) {
      const last = historyEntries[historyEntries.length - 1];
      if (last?.url) return last.url;
    }
    return '';
  }

  function getPageTitle() {
    return getPageInfo().title || document.title;
  }

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

  function getMainInputElement() {
    return dom.messageInput || null;
  }

  function getImageContainer() {
    return dom.imageContainer || null;
  }

  function dispatchInputUpdate() {
    const inputEl = getMainInputElement();
    if (!inputEl) return;
    const event = new Event('input', { bubbles: true });
    inputEl.dispatchEvent(event);
  }

  function getRawInputText() {
    const inputEl = getMainInputElement();
    if (!inputEl) return '';
    return inputEl.textContent || '';
  }

  function getInstructionTextFromInput() {
    if (services.inputController?.getInputText) {
      return services.inputController.getInputText() || '';
    }
    return getRawInputText().trim();
  }

  function setInstructionTextToInput(text) {
    if (services.inputController?.setInputText) {
      services.inputController.setInputText(text || '');
    } else {
      const inputEl = getMainInputElement();
      if (inputEl) inputEl.textContent = text || '';
    }
    dispatchInputUpdate();
    services.uiManager?.resetInputHeight?.();
  }

  function clearInputImages() {
    const imageContainer = getImageContainer();
    if (!imageContainer) return;
    imageContainer.innerHTML = '';
  }

  function setInputImages(html) {
    const imageContainer = getImageContainer();
    if (!imageContainer) return;
    imageContainer.innerHTML = html || '';
  }

  function captureInputDraft() {
    return {
      text: getRawInputText(),
      images: getImageContainer()?.innerHTML || ''
    };
  }

  function applyInputDraft(draft, { focus = false, allowImages = true } = {}) {
    const safeDraft = draft || { text: '', images: '' };
    setInstructionTextToInput(safeDraft.text || '');
    if (allowImages) {
      setInputImages(safeDraft.images || '');
    } else {
      clearInputImages();
    }
    if (focus) {
      focusInstructionInput();
    }
  }

  function focusInstructionInput() {
    if (services.inputController?.focusToEnd) {
      services.inputController.focusToEnd();
      return;
    }
    const inputEl = getMainInputElement();
    if (!inputEl) return;
    try {
      inputEl.focus();
      const selection = window.getSelection();
      if (!selection) return;
      const range = document.createRange();
      range.selectNodeContents(inputEl);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    } catch (error) {
      console.warn('聚焦电脑操作输入框失败:', error);
    }
  }

  function setComputerUsePlaceholder() {
    const inputEl = getMainInputElement();
    if (!inputEl) return;
    if (!originalPlaceholder) {
      originalPlaceholder = inputEl.getAttribute('placeholder') || '';
    }
    inputEl.setAttribute('placeholder', '输入电脑操作指令...');
    inputEl.dataset.inputMode = 'computer-use';
  }

  function restoreChatPlaceholder() {
    const inputEl = getMainInputElement();
    if (!inputEl) return;
    if (originalPlaceholder) {
      inputEl.setAttribute('placeholder', originalPlaceholder);
    } else {
      inputEl.setAttribute('placeholder', '输入消息...');
    }
    delete inputEl.dataset.inputMode;
  }

  function startInstructionRound(instruction) {
    currentRoundId = generateRequestId('round');
    appendHistoryEntry({
      type: 'instruction',
      title: '用户指令',
      role: 'user',
      content: instruction,
      roundId: currentRoundId
    });
  }

  function startFollowupRound(label) {
    currentRoundId = generateRequestId('round');
    if (label) {
      appendHistoryEntry({
        type: 'note',
        title: label,
        roundId: currentRoundId
      });
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
    if (reason && reason !== 'restart') {
      historyEntries = [];
      currentRoundId = null;
      renderHistory();
    } else {
      currentRoundId = null;
    }
  }

  function ensureSessionKey() {
    if (currentSession && !currentSession.sessionKey) {
      currentSession.sessionKey = generateRequestId('csess');
    }
  }

  function syncSessionState(overrides = {}) {
    const {
      status = 'active',
      finishReason = null,
      pendingResponses = undefined,
      note = undefined,
      awaitingRecovery = status === 'closing' || status === 'waiting-navigation'
    } = overrides;

    updateStatusBadge({ status, error: status === 'error' ? note : undefined });

    if (!currentSession) {
      postToParent('COMPUTER_USE_SYNC_STATE', {
        status,
        finishReason,
        pendingResponses,
        note,
        session: null,
        updatedAt: Date.now(),
        awaitingRecovery,
        history: cloneForTransport(historyEntries)
      });
      return;
    }

    ensureSessionKey();
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
      url: getPageUrl(),
      title: getPageTitle(),
      updatedAt: Date.now(),
      awaitingRecovery,
      history: cloneForTransport(historyEntries)
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
    renderHistory();
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
      computerUseToggleAuto,
      computerUseStatusBadge
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
          syncSessionState({ status: isAutoMode ? 'active' : 'paused', pendingResponses: [] });
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

    computerUseToggleAuto?.addEventListener('click', toggleAutoMode);
    updateStatusBadge();
    renderHistory();
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

    const mode = config.executionMode || (isAutoMode ? MODE_AUTO : MODE_MANUAL);
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
    isAutoMode = executionMode === MODE_AUTO;

    if (persist) {
      saveConfig({ executionMode });
    }

    updateStepButtonState();
    renderActionsList();
    if (updateUI) updateAutoUI();

    if (isAutoMode) {
      if (pendingActionQueue.length) {
        runActionsSequence();
      } else if (currentSession) {
        setStatus('等待模型返回新动作...', 'info');
      }
    } else {
      if (pendingActionQueue.length) {
        setStatus('已生成操作，请点击 >| 执行下一步。', 'info');
      } else if (currentSession) {
        setStatus('等待模型返回新动作，稍后点击 >|。', 'info');
      }
    }

    if (currentSession) {
      syncSessionState({ status: isAutoMode ? 'active' : 'paused', pendingResponses: [] });
    }
  }

  function openPanel() {
    if (!dom.computerUsePanel) return;
    const willActivateInput = !isComputerUseInputActive;
    if (willActivateInput) {
      chatInputDraft = captureInputDraft();
      applyInputDraft(computerUseDraft.text ? computerUseDraft : { text: currentInstruction || '', images: '' }, {
        focus: true,
        allowImages: false
      });
      clearInputImages();
      setComputerUsePlaceholder();
      isComputerUseInputActive = true;
      state.inputMode = 'computerUse';
    }
    dom.computerUsePanel.classList.add('visible');
    if (willActivateInput) focusInstructionInput();
  }

  function closePanel() {
    if (!dom.computerUsePanel) return;
    if (isComputerUseInputActive) {
      computerUseDraft = captureInputDraft();
      applyInputDraft(chatInputDraft, { focus: false, allowImages: true });
      restoreChatPlaceholder();
      isComputerUseInputActive = false;
      state.inputMode = 'chat';
      dispatchInputUpdate();
    }
    dom.computerUsePanel.classList.remove('visible');
  }

  function setStatus(text, type = 'info') {
    if (!dom.computerUseStatus) return;
    dom.computerUseStatus.textContent = text || '';
    dom.computerUseStatus.dataset.statusType = type;
    if (type === 'error') {
      updateStatusBadge({ status: 'error', error: text });
    }
  }

  function setLoading(next, message) {
    isLoading = next;
    if (dom.computerUseRunButton) dom.computerUseRunButton.disabled = next;
    if (dom.computerUseCaptureButton) dom.computerUseCaptureButton.disabled = next;
    updateStepButtonState();
    if (next && message) setStatus(message, 'info');
  }

  function updateStepButtonState() {
    if (dom.computerUseStepButton) {
      dom.computerUseStepButton.disabled = isAutoMode || isLoading || pendingActionQueue.length === 0;
    }
    if (dom.computerUseToggleAuto) {
      dom.computerUseToggleAuto.textContent = isAutoMode ? '暂停自动' : '恢复自动';
      dom.computerUseToggleAuto.disabled = isLoading && isAutoMode;
    }
    updateStatusBadge();
  }

  function updateStatusBadge(state = {}) {
    const badge = dom.computerUseStatusBadge;
    if (!badge) return;
    badge.classList.remove('badge-auto', 'badge-paused', 'badge-error');
    const status = state?.status;
    if (state?.error || status === 'error') {
      badge.classList.add('badge-error');
      badge.textContent = `错误：${state.error}`;
    } else if (!isAutoMode || status === 'paused') {
      badge.classList.add('badge-paused');
      badge.textContent = '已暂停';
    } else {
      badge.classList.add('badge-auto');
      badge.textContent = '自动执行';
    }
  }

  function updateAutoUI() {
    updateStepButtonState();
    if (!isAutoMode) {
      setStatus('已暂停自动执行，请手动单步完成操作。', 'info');
    }
  }

  function toggleAutoMode() {
    isAutoMode = !isAutoMode;
    setExecutionMode(isAutoMode ? MODE_AUTO : MODE_MANUAL, { persist: true, updateUI: true });
    syncSessionState({ status: isAutoMode ? 'active' : 'paused', pendingResponses: [] });
    if (isAutoMode && pendingActionQueue.length && currentSession) {
      runActionsSequence();
    }
  }

  function updatePendingActions(actions = []) {
    pendingActionQueue = Array.isArray(actions) ? actions.map((action) => JSON.parse(JSON.stringify(action))) : [];
    renderActionsList();
    updateStepButtonState();
  }

  function limitHistory() {
    const LIMIT = 100;
    if (historyEntries.length > LIMIT) {
      historyEntries = historyEntries.slice(historyEntries.length - LIMIT);
    }
  }

  function appendHistoryEntry(entry) {
    const enriched = {
      id: generateRequestId('hist'),
      timestamp: Date.now(),
      roundId: entry?.roundId || currentRoundId || generateRequestId('round'),
      ...entry
    };
    currentRoundId = enriched.roundId;
    historyEntries.push(enriched);
    limitHistory();
    renderHistory();
    if (entry?.type === 'model_response' || entry?.endRound) {
      currentRoundId = null;
    }
  }

  function renderHistory() {
    const list = dom.computerUseHistoryList;
    if (!list) return;
    list.innerHTML = '';
    if (!historyEntries.length) {
      const empty = document.createElement('div');
      empty.className = 'computer-use-history-entry';
      empty.textContent = '暂无历史记录';
      list.appendChild(empty);
      return;
    }

    historyEntries.forEach((item, index) => {
      const entry = document.createElement('div');
      entry.className = 'computer-use-history-entry';

      renderHistoryEntry(entry, item, index);
      list.appendChild(entry);
    });
    list.scrollTop = list.scrollHeight;
  }

  function renderHistoryEntry(entryEl, item, index) {
    entryEl.className = `computer-use-history-entry entry-${item.type || 'event'}`;

    if (item.type === 'instruction') {
      const bubble = createHistoryBubble({
        role: 'user',
        title: '指令',
        content: item.content,
        time: item.timestamp
      });
      entryEl.appendChild(bubble);
    } else if (item.type === 'model_response') {
      const bubble = createHistoryBubble({
        role: 'assistant',
        title: '模型响应',
        content: item.narration,
        time: item.timestamp
      });
      if (Array.isArray(item.actions) && item.actions.length) {
        const actionList = document.createElement('ul');
        actionList.className = 'history-entry-actions';
        item.actions.forEach((action, idx) => {
          const li = document.createElement('li');
          const argsText = action.args ? ` ${JSON.stringify(action.args)}` : '';
          li.textContent = `${idx + 1}. ${action.name}${argsText}`;
          actionList.appendChild(li);
        });
        bubble.appendChild(actionList);
      }
      if (item.screenshot) {
        const img = document.createElement('img');
        img.className = 'history-entry-screenshot';
        img.src = item.screenshot;
        img.alt = '最新截图';
        bubble.appendChild(img);
      }
      entryEl.appendChild(bubble);
    } else if (item.type === 'action_result') {
      const bubble = createHistoryBubble({
        role: 'system',
        title: `执行：${item.action?.name || '动作'}`,
        content: item.result ? JSON.stringify(item.result, null, 2) : '',
        time: item.timestamp
      });
      if (item.screenshot) {
        const img = document.createElement('img');
        img.className = 'history-entry-screenshot';
        img.src = item.screenshot;
        img.alt = '动作截图';
        bubble.appendChild(img);
      }
      entryEl.appendChild(bubble);
    } else if (item.type === 'screenshot') {
      const bubble = createHistoryBubble({
        role: 'system',
        title: item.title || '页面截图',
        content: item.url || '',
        time: item.timestamp
      });
      if (item.screenshot) {
        const img = document.createElement('img');
        img.className = 'history-entry-screenshot';
        img.src = item.screenshot;
        img.alt = item.title || '截图';
        bubble.appendChild(img);
      }
      entryEl.appendChild(bubble);
    } else {
      const bubble = createHistoryBubble({
        role: 'system',
        title: item.title || '事件',
        content: item.note || item.narration || item.content || '',
        time: item.timestamp
      });
      entryEl.appendChild(bubble);
    }

    const next = historyEntries[index + 1];
    if (!next || next.roundId !== item.roundId) {
      const divider = document.createElement('div');
      divider.className = 'history-entry-divider';
      entryEl.appendChild(divider);
    }
  }

  function createHistoryBubble({ role, title, content, time }) {
    const bubble = document.createElement('div');
    bubble.className = `history-entry-bubble bubble-${role || 'system'}`;

    const header = document.createElement('div');
    header.className = 'history-entry-header';
    const titleSpan = document.createElement('span');
    titleSpan.className = 'history-entry-title';
    titleSpan.textContent = title || '';
    header.appendChild(titleSpan);

    if (time) {
      const timeSpan = document.createElement('span');
      timeSpan.className = 'history-entry-meta';
      timeSpan.textContent = new Date(time).toLocaleTimeString();
      header.appendChild(timeSpan);
    }
    bubble.appendChild(header);

    if (content) {
      const body = document.createElement('div');
      body.className = 'history-entry-body';
      body.textContent = content;
      bubble.appendChild(body);
    }

    return bubble;
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
      empty.textContent = !isAutoMode
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

    computerUseDraft = captureInputDraft();
    const instruction = getInstructionTextFromInput().trim();
    if (!instruction) {
      setStatus('请先输入要执行的指令', 'warning');
      focusInstructionInput();
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
      computerUseDraft = { text: '', images: '' };
      setInstructionTextToInput('');
      clearInputImages();
      dispatchInputUpdate();
      startInstructionRound(instruction);

      setLoading(true, '正在更新截图...');
      await refreshScreenshot({ silent: true });
      const screenshot = latestScreenshot;
      if (!screenshot) throw new Error('截图失败，无法构建请求');
      appendHistoryEntry({
        type: 'screenshot',
        title: '页面截图',
        screenshot,
        url: getPageUrl(),
        roundId: currentRoundId
      });
      setLoading(true, '正在向 Gemini 请求操作...');
      const startResult = await computerUseApi.startSession({ instruction, screenshotDataUrl: screenshot });
      currentSession = startResult.session;
      latestNarration = startResult.narration || '';
      const initialActions = startResult.actions || [];
      updatePendingActions(initialActions);
      setLoading(false);
      appendHistoryEntry({
        type: 'model_response',
        title: '模型响应',
        narration: latestNarration,
        actions: initialActions,
        url: getPageUrl(),
        screenshot: latestScreenshot,
        roundId: currentRoundId
      });
      syncSessionState({ status: 'active', pendingResponses: [] });

      const hasActions = initialActions.length > 0;
      const shouldStop = !hasActions && startResult.finishReason === 'STOP';

      if (!currentSession || shouldStop) {
        currentSession = null;
        setStatus('电脑操作流程完成。', 'success');
        clearSessionState('completed');
        return;
      }

      if (isAutoMode) {
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
        url: result.url || getPageUrl()
      };
      if (result.navigation) responsePayload.navigation = true;
      if (result.selector) responsePayload.selector = result.selector;
      if (result.info) responsePayload.info = result.info;
      if (workingAction?.args?.safety_acknowledgement) {
        responsePayload.safety_acknowledgement = true;
      }

      currentRoundId = generateRequestId('round');
      appendHistoryEntry({
        type: 'action_result',
        title: `动作：${workingAction.name}`,
        action: workingAction,
        result: responsePayload,
        url: responsePayload.url,
        screenshot: latestScreenshot,
        roundId: currentRoundId
      });

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

    while (isAutoMode && pendingActionQueue.length > 0) {
      syncSessionState({ status: 'executing', pendingResponses: [], note: 'auto-sequence' });
      const action = pendingActionQueue.shift();
      renderActionsList();
      updateStepButtonState();
      const response = await executeAction(action);
      if (!response) return;
      await advanceSessionWithResponses([response], { triggerAuto: false });
      if (!isAutoMode) return;
    }

    if (isAutoMode && currentSession && pendingActionQueue.length === 0) {
      setStatus('等待模型返回新动作...', 'info');
    }

    if (currentSession) {
      syncSessionState({ status: 'active', pendingResponses: [] });
    }
  }

  async function advanceSessionWithResponses(responses, { triggerAuto = isAutoMode } = {}) {
    if (!currentSession) return;
    try {
      if (!currentRoundId) {
        startFollowupRound(triggerAuto ? '自动继续' : '手动继续');
      }
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
      appendHistoryEntry({
        type: 'model_response',
        title: '模型响应',
        narration: latestNarration,
        actions: newActions,
        url: getPageUrl(),
        screenshot: latestScreenshot,
        roundId: currentRoundId
      });
      syncSessionState({ status: 'active', pendingResponses: [] });

      const hasActions = newActions.length > 0;
      const shouldStop = !hasActions && next.finishReason === 'STOP';

      if (!currentSession || shouldStop) {
        currentSession = null;
        setStatus('电脑操作流程完成。', 'success');
        clearSessionState('completed');
        return;
      }

      if (triggerAuto && isAutoMode) {
        await runActionsSequence();
      } else if (!isAutoMode) {
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
    if (isAutoMode || isLoading) return;
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
    // 统一改用主输入框，快捷键逻辑在全局事件中处理，这里保持空实现以兼容旧接口。
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

    appContext.utils?.closeExclusivePanels?.();
    openPanel();

    currentSession = state.session;
    latestNarration = state.narration || '';
    currentInstruction = state.instruction || currentInstruction || '';
    actionSettleDelayMs = normalizeDelay(state.actionSettleDelayMs ?? actionSettleDelayMs);
    latestScreenshotAt = state.latestScreenshotAt || latestScreenshotAt;
    historyEntries = Array.isArray(state.history) ? state.history : [];
    renderHistory();
    currentRoundId = historyEntries.length ? historyEntries[historyEntries.length - 1].roundId : null;

    if (isComputerUseInputActive) {
      setInstructionTextToInput(currentInstruction || '');
      dispatchInputUpdate();
    } else {
      computerUseDraft = { text: currentInstruction || '', images: '' };
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
    updateStatusBadge({ status });

    if (status === 'active') {
      if (isAutoMode && pendingActionQueue.length > 0) {
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
      advanceSessionWithResponses(pendingResponses, { triggerAuto: isAutoMode }).catch((error) => {
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
    handleSessionState,
    submitInstruction: handleRunRequest,
    isInputActive: () => isComputerUseInputActive
  };
}
