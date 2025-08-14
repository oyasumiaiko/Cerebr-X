import { migrateOldPromptSettings, loadAllPromptSettings, savePromptSettingsBulk } from './prompt_store.js';
import { replacePlaceholders as resolvePlaceholders, getMatchingUrlRule as resolveUrlRule } from './prompt_resolver.js';

/**
 * 规范化加载到的提示词项，确保包含 prompt 与 model 字段
 * @param {Object} loaded 加载到的条目
 * @param {Object} fallback 默认值
 * @returns {{prompt: string, model: string}}
 */
function normalizePromptItem(loaded, fallback) {
    const item = loaded && typeof loaded === 'object' ? loaded : {};
    const prompt = (typeof item.prompt === 'string') ? item.prompt : (fallback?.prompt || '');
    const model = (typeof item.model === 'string') ? item.model : (fallback?.model || 'follow_current');
    return { prompt, model };
}

// 默认提示词
const DEFAULT_PROMPTS = {
    system: {
        prompt: `数学公式请使用LaTeX表示，行间公式请使用\\[...\\]表示，行内公式请使用\\(...\\)表示，禁止使用$美元符号包裹数学公式。始终使用**中文**回答用户问题。`,
        model: 'follow_current'
    },
    screenshot: {
        prompt: `请分析这个截图的内容，包括：

1. 内容类型：
   - 这是什么类型的图片（图表、界面、流程图等）
   - 图片的主要用途和场景

2. 核心信息：
   - 图片传达的主要信息和观点
   - 重要的数据、指标或关键点
   - 图片中的特殊标记或重点强调部分

3. 上下文解释：
   - 这些信息在当前场景下的含义
   - 可能的应用场景或实际价值

请用清晰的结构和通俗的语言解释，确保内容准确、全面且易于理解。`,
        model: 'follow_current'
    },
    extract: {
        prompt: `请从页面内容中提取并整理以下关键信息：

1. 实体信息：
   - 人物：姓名、职位、角色
   - 组织：公司、机构、团体
   - 地点：地址、区域、场所

2. 数值信息：
   - 数字指标：具体数值、百分比、比率
   - 时间节点：日期、时间段、期限
   - 金额：价格、成本、预算

3. 技术参数：
   - 规格：尺寸、重量、容量
   - 性能：速度、效率、功耗
   - 标准：等级、评级、指标

4. 关键概念：
   - 专业术语及其定义
   - 重要观点和结论
   - 核心价值主张

请以结构化的方式呈现这些信息，并标注信息的出处或位置。如果某类信息不存在，可以略过对应部分。`,
        model: 'follow_current'
    },
    image: {
        prompt: `如果是图片，请解释图片内容，包括:
- 图片类型（照片、图表、截图等）
- 主要内容和主题
- 关键信息和重点

如果是图片主体是文本内容，首先提取原始文本，提取后翻译成中文。`,
        model: 'follow_current'
    },
    selection: {
        prompt: `请根据以下内容的复杂度，编写3-20条多方面、多层次、多角度的queries，使用google_search(queries)工具执行。
"<SELECTION>"

请全面、客观地总结以下搜索结果，既要突出核心要点，也要保留重要细节`,
        model: 'follow_current'
    },
    pdf: {
        prompt: `请对这个PDF文档进行分析：
1. 首先列出文档的详细大纲结构，包括各级标题和对应的主要内容；
2. 然后根据大纲结构，按照以下方面展开总结：
   - 文档的主要目的和核心论点
   - 每个主要部分的关键内容和要点
   - 重要的数据、图表或研究发现
   - 作者的结论和建议
3. 最后，总结文档的创新点、局限性和实际应用价值。

请用清晰的层级结构和要点形式展示以上内容。`,
        model: 'follow_current'
    },
    summary: {
        prompt: `请对这个页面进行全面分析和总结：

1. 页面主要内容：
   - 核心主题和目的
   - 关键信息点和论述
   - 重要数据和事实

2. 内容结构分析：
   - 主要章节和层次
   - 信息组织方式
   - 重点内容分布

3. 观点和论述：
   - 主要观点和论据
   - 不同视角和立场
   - 论述的逻辑性

4. 特色和价值：
   - 独特见解和创新点
   - 实用价值和应用
   - 局限性和不足

请用清晰的层次结构和要点形式展示以上内容，突出重点，便于理解和参考。`,
        model: 'follow_current'
    },
    query: {
        prompt: `请分析并解释以下内容：

"<SELECTION>"

1. 基本含义：
   - 概念解释和定义
   - 关键术语说明
   - 上下文背景

2. 深入分析：
   - 主要特点和属性
   - 相关概念和关系
   - 应用场景和例子

3. 扩展讨论：
   - 重要影响和意义
   - 常见问题和解决
   - 最新发展和趋势

请用清晰的结构和通俗的语言进行解释，确保内容准确、全面且易于理解。`,
        model: 'follow_current'
    },
    urlRules: {
        prompt: '[]',  // 存储为JSON字符串，格式为[{pattern: string, type: 'summary'|'system', prompt: string}]
        model: 'follow_current'
    }
};

// 注意：存储与分块逻辑已经抽离到 prompt_store.js

class PromptSettings {
    constructor(appContext) {
        this.appContext = appContext;
        const { dom } = appContext;

        // DOM 元素
        this.promptSettingsToggle = dom.promptSettingsToggle;
        this.promptSettings = dom.promptSettingsPanel;
        this.promptBackButton = this.promptSettings.querySelector('.back-button');
        this.resetPromptsButton = dom.resetPromptsButton;
        this.savePromptsButton = dom.savePromptsButton;
        this.selectionPrompt = dom.selectionPrompt;
        this.systemPrompt = dom.systemPrompt;
        this.pdfPrompt = dom.pdfPrompt;
        this.summaryPrompt = dom.summaryPrompt;
        this.queryPrompt = dom.queryPrompt;
        this.imagePrompt = dom.imagePrompt;
        this.screenshotPrompt = dom.screenshotPrompt;
        this.extractPrompt = dom.extractPrompt;
        this.urlRulesPrompt = dom.urlRulesPrompt;

        // 模型选择下拉框
        this.modelSelects = {};
        this.initModelSelects();

        // 为每个提示词文本框添加重置按钮
        this.addResetButtons();
        
        // 绑定事件处理器
        this.bindEvents();

        // 文本域变更自动保存（防抖）
        this._setupAutosaveForTextareas();
        
        // 初始化提示词设置
        this.loadPromptSettings();

        // URL规则相关元素
        this.urlRulesList = document.getElementById('url-rules-list');
        
        // 初始化URL规则列表
        this.renderUrlRules();
    }

    // 分块清理逻辑已迁移到 prompt_store.js，保留空壳占位以避免外部直接调用

    // 初始化模型选择下拉框
    initModelSelects() {
        const promptTypes = ['selection', 'query', 'pdf', 'summary', 'image', 'urlRules']; 

        // 获取所有可用的模型
        const getAvailableModels = () => {
            // 返回“可选项值”的列表：优先使用 displayName，否则回退 modelName
            const values = new Set();
            const apiManager = this.appContext.services.apiManager;
            const apiConfigs = apiManager ? apiManager.getAllConfigs() : window.apiConfigs;
            if (apiConfigs && Array.isArray(apiConfigs)) {
                apiConfigs.forEach(config => {
                    const value = (config.displayName && String(config.displayName).trim()) || config.modelName;
                    if (value) values.add(value);
                });
            }
            return Array.from(values);
        };

        promptTypes.forEach(type => {
            const promptElement = document.querySelector(`#${type}-prompt`);
            if (!promptElement) {
                return;
            }
            
            const promptGroup = promptElement.closest('.prompt-group');
            if (!promptGroup) {
                return;
            }
            
            const modelSelectContainer = document.createElement('div');
            modelSelectContainer.className = 'model-select-container';
            
            const label = document.createElement('label');
            label.textContent = '偏好模型：';
            label.htmlFor = `${type}-model`;
            
            const select = document.createElement('select');
            select.id = `${type}-model`;
            select.className = 'model-select';
            select.setAttribute('data-prompt-type', type);

            // 动态更新模型选项的函数
            const updateModelOptions = (currentSelectedValue) => {
                const apiManager = this.appContext.services.apiManager;
                const configs = apiManager ? apiManager.getAllConfigs() : (window.apiConfigs || []);
                const valueToKeep = currentSelectedValue || select.value || 'follow_current';
                select.innerHTML = '';

                const followOption = document.createElement('option');
                followOption.value = 'follow_current';
                followOption.textContent = '跟随当前 API 设置';
                select.appendChild(followOption);

                const separator = document.createElement('option');
                separator.disabled = true;
                separator.textContent = '──────────';
                select.appendChild(separator);

                const availableConfigs = Array.isArray(configs) ? configs : [];
                availableConfigs.forEach(cfg => {
                    const option = document.createElement('option');
                    option.value = cfg.id || `${cfg.baseUrl}|${cfg.modelName}`; // 回退标识
                    option.textContent = (cfg.displayName && String(cfg.displayName).trim()) || cfg.modelName || cfg.baseUrl || option.value;
                    select.appendChild(option);
                });

                // 选择恢复逻辑：优先精确匹配 id；否则尝试名称映射；最后回退
                const hasExact = Array.from(select.options).some(o => o.value === valueToKeep);
                if (valueToKeep === 'follow_current' || hasExact) {
                    select.value = valueToKeep;
                } else {
                    // 旧数据迁移：尝试按 displayName/modelName 映射到 id
                    const mapped = availableConfigs.find(c => (c.displayName || '').trim() === valueToKeep) ||
                                   availableConfigs.find(c => (c.modelName || '').trim() === valueToKeep);
                    if (mapped) {
                        select.value = mapped.id || `${mapped.baseUrl}|${mapped.modelName}`;
                    } else {
                        select.value = 'follow_current';
                    }
                }
            };

            // 初始化模型选项
            updateModelOptions();

            // 监听 API 配置变化
            window.addEventListener('apiConfigsUpdated', () => {
                updateModelOptions(select.value);
            });

            modelSelectContainer.appendChild(label);
            modelSelectContainer.appendChild(select);
            promptGroup.appendChild(modelSelectContainer);
            
            this.modelSelects[type] = select;
            
            // 为选择添加变化监听器 - 自动保存
            select.addEventListener('change', () => {
                this.autoSavePromptSettings();
            });
        });
    }

    // 添加重置按钮
    addResetButtons() {
        const promptGroups = this.promptSettings.querySelectorAll('.prompt-group');
        promptGroups.forEach(group => {
            const label = group.querySelector('label');
            const textarea = group.querySelector('textarea');
            const promptType = textarea.id.replace('-prompt', '');

            // 创建一个包含标签和按钮的容器
            const headerContainer = document.createElement('div');
            headerContainer.className = 'prompt-header-container';

            // 创建一个单独的 span 来显示标签文本
            const labelText = document.createElement('span');
            labelText.className = 'prompt-label-text';
            labelText.textContent = label.textContent;

            // 创建重置按钮
            const resetButton = document.createElement('button');
            resetButton.className = 'reset-single-prompt';
            resetButton.title = '恢复默认';
            resetButton.innerHTML = `
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M13 3L3 13M3 3l10 10"/>
                </svg>
            `;

            // 添加点击事件
            resetButton.addEventListener('click', (e) => {
                e.stopPropagation(); // 阻止事件冒泡
                this.resetSinglePrompt(promptType);
            });

            // 将标签文本和重置按钮添加到容器中
            headerContainer.appendChild(labelText);
            headerContainer.appendChild(resetButton);

            // 替换原标签
            label.textContent = '';
            label.setAttribute('for', textarea.id); // 确保标签与文本框的关联
            
            // 将新容器插入到原标签之前
            group.insertBefore(headerContainer, label);
        });
    }

    // 重置单个提示词
    resetSinglePrompt(promptType) {
        if (confirm(`确定要恢复"${this.getPromptTypeName(promptType)}"的默认提示词和模型设置吗？`)) {
            const textarea = this[`${promptType}Prompt`];
            textarea.value = DEFAULT_PROMPTS[promptType].prompt;
            this.modelSelects[promptType].value = DEFAULT_PROMPTS[promptType].model;
            
            // 添加动画效果
            textarea.style.transition = 'background-color 0.3s ease';
            textarea.style.backgroundColor = 'rgba(52, 199, 89, 0.1)'; // 浅绿色
            setTimeout(() => {
                textarea.style.backgroundColor = '';
            }, 500);
        }
    }

    // 获取提示词类型的中文名称
    getPromptTypeName(promptType) {
        const nameMap = {
            'system': '系统提示词',
            'summary': '快速总结提示词',
            'query': '非联网模型划词提示词',
            'selection': '联网模型划词提示词',
            'pdf': 'PDF快速总结提示词',
            'image': '图片默认提示词',
            'urlRules': 'URL规则'
        };
        return nameMap[promptType] || promptType;
    }

    // 绑定事件处理器
    bindEvents() {
        // 返回按钮
        this.promptBackButton.addEventListener('click', () => {
            this.promptSettings.classList.remove('visible');
        });

        // 重置所有按钮
        this.resetPromptsButton.addEventListener('click', () => {
            if (confirm('确定要恢复所有默认提示词和模型设置吗？这将覆盖当前的所有自定义设置。')) {
                this.resetPrompts();
                // 自动保存重置后的设置
                this.autoSavePromptSettings();
            }
        });

        // 保存按钮
        this.savePromptsButton.addEventListener('click', () => this.savePromptSettings(true));
    }

    /**
     * 为提示词文本域设置统一的自动保存逻辑，使用防抖避免频繁写入。
     * 会在输入与变更时显示“正在保存…”，保存完成后显示“所有更改已保存”。
     * @private
     * @since 1.0.0
     */
    _setupAutosaveForTextareas() {
        const textareas = this.promptSettings.querySelectorAll('textarea');
        textareas.forEach((ta) => {
            ta.addEventListener('blur', async () => {
                const status = document.getElementById('save-status');
                if (status) status.textContent = '正在保存...';
                await this.autoSavePromptSettings();
                if (status) status.textContent = '所有更改已保存';
            });
        });
    }

    // 迁移逻辑委托至 prompt_store.js
    async migrateOldPromptSettings() { await migrateOldPromptSettings(); }

    // 加载提示词设置（委托存储模块）
    async loadPromptSettings() {
        try {
            await this.migrateOldPromptSettings();
            const types = Object.keys(DEFAULT_PROMPTS);
            const loaded = await loadAllPromptSettings(types);

            this.savedPrompts = {};
            types.forEach(type => {
                const merged = normalizePromptItem(loaded[type], DEFAULT_PROMPTS[type]);
                this.savedPrompts[type] = { prompt: merged.prompt, model: merged.model };

                const promptElement = this[`${type}Prompt`];
                if (promptElement) promptElement.value = merged.prompt;

                if (this.modelSelects[type]) {
                    const modelToSelect = merged.model || 'follow_current';
                    if (this.modelSelects[type].querySelector(`option[value="${modelToSelect}"]`)) {
                        this.modelSelects[type].value = modelToSelect;
                    } else {
                        const newOption = document.createElement('option');
                        newOption.value = modelToSelect;
                        newOption.textContent = modelToSelect;
                        this.modelSelects[type].appendChild(newOption);
                        this.modelSelects[type].value = modelToSelect;
                    }
                }
            });

            this.renderUrlRules();
        } catch (error) {
            console.error('加载提示词设置时出错:', error);
        }
    }

    /**
     * 自动保存提示词设置（不关闭面板），处理分块存储。
     * @returns {Promise<void>}
     */
    async autoSavePromptSettings() { await this._savePromptSettingsInternal(false); }

    /**
     * 保存提示词设置，处理分块存储。
     * @param {boolean} [shouldClosePanel=true] - 保存后是否关闭设置面板。
     * @returns {Promise<void>}
     */
    async savePromptSettings(shouldClosePanel = true) {
        await this._savePromptSettingsInternal(shouldClosePanel);
    }
    
    /**
     * 内部保存提示词设置的核心逻辑，处理分块。
     * @param {boolean} shouldClosePanel - 保存后是否关闭面板。
     * @returns {Promise<void>}
     * @private
     */
    async _savePromptSettingsInternal(shouldClosePanel) {
        try {
            const currentPromptsFromUI = this.collectCurrentPromptSettings();
            const newSavedPromptsState = await savePromptSettingsBulk(currentPromptsFromUI, this.savedPrompts || {});

            this.savedPrompts = newSavedPromptsState;
            this.appContext.dom.promptSettingsPanel.dispatchEvent(new CustomEvent('promptSettingsUpdated', { bubbles: true, composed: true }));

            if (shouldClosePanel) this.promptSettings.classList.remove('visible');

            const status = document.getElementById('save-status');
            if (status) {
                status.textContent = shouldClosePanel ? '已保存' : '所有更改已保存';
            }
        } catch (error) {
            console.error('保存提示词设置失败:', error);
            alert('保存部分或全部设置失败，可能已超出存储配额，请检查后重试。');
        }
    }

    // 收集当前的提示词设置
    collectCurrentPromptSettings() {
        const prompts = {};
        Object.keys(DEFAULT_PROMPTS).forEach(type => {
            const textarea = this[`${type}Prompt`];
            if (!textarea) {
                return;
            }

            // 获取模型值
            let modelValue = DEFAULT_PROMPTS[type].model;
            if (this.modelSelects[type]) {
                modelValue = this.modelSelects[type].value;
            }

            prompts[type] = {
                prompt: textarea.value,
                model: modelValue
            };
        });
        return prompts;
    }

    // 重置提示词为默认值
    resetPrompts() {
        Object.keys(DEFAULT_PROMPTS).forEach(type => {
            this[`${type}Prompt`].value = DEFAULT_PROMPTS[type].prompt;
            if (this.modelSelects[type]) {
                this.modelSelects[type].value = DEFAULT_PROMPTS[type].model;
            }
        });
        
        // 触发提示词设置更新事件
        this.appContext.dom.promptSettingsPanel.dispatchEvent(new CustomEvent('promptSettingsUpdated', { bubbles: true, composed: true }));
    }

    /**
     * 替换占位符为实际值
     * @param {string} text - 包含占位符的文本，如 {{datetime}}, {{date}}, {{time}}
     * @returns {string} 替换后的文本
     */
    replacePlaceholders(text) { return resolvePlaceholders(text); }
    
    /**
     * 获取当前提示词，自动处理URL规则匹配
     * @returns {Object} 提示词设置对象
     */
    getPrompts() {
        const prompts = {};
        Object.keys(DEFAULT_PROMPTS).forEach(type => {
            const elementKey = `${type}Prompt`;
            const textarea = this[elementKey];

            // 更健壮的检查，确保textarea存在并且拥有value属性
            if (!textarea || typeof textarea.value === 'undefined') {
                console.error(`提示词元素 '${elementKey}' 未找到、无效或没有 'value' 属性. 当前值:`, textarea);
                // 对于无效的元素，不设置 prompts[type]
                return; // 继续处理下一个类型
            }

            let promptValue = textarea.value;
            
            // 从appContext.state.pageInfo获取当前页面信息
            const pageInfo = this.appContext.state.pageInfo;
            if (pageInfo?.url) {
                if (type === 'system') {
                    const urlRule = this.getMatchingUrlRule(pageInfo.url, 'system');
                    if (urlRule) {
                        promptValue = urlRule;
                    }
                } else if (type === 'summary') {
                    const urlRule = this.getMatchingUrlRule(pageInfo.url, 'summary');
                    if (urlRule) {
                        promptValue = urlRule;
                    }
                }
            }
            
            // 替换占位符（例如 {{datetime}}, {{date}}, {{time}}）
            promptValue = this.replacePlaceholders(promptValue);
            
            prompts[type] = {
                prompt: promptValue,
                // 将 model 字段存储为“选择值”（displayName 或 modelName），由 apiManager 在 getModelConfig 中解析
                model: this.modelSelects[type]?.value || this.savedPrompts?.[type]?.model || DEFAULT_PROMPTS[type].model
            };
        });
        return prompts;
    }

    /**
     * 根据URL获取匹配的规则提示词
     * @param {string} url - 要匹配的URL
     * @param {string} type - 提示词类型 ('summary'|'system')
     * @returns {string|null} 匹配的提示词或null
     */
    getMatchingUrlRule(url, type) {
        if (!this.urlRulesPrompt) return null;
        try {
            const rules = JSON.parse(this.urlRulesPrompt.value || '[]');
            return resolveUrlRule(url, type, rules);
        } catch (e) {
            console.error('解析URL规则失败:', e);
            return null;
        }
    }

    /**
     * 渲染URL规则列表
     */
    renderUrlRules() {
        if (!this.urlRulesList || !this.urlRulesPrompt) return;

        try {
            const rules = JSON.parse(this.urlRulesPrompt.value || '[]');
            this.urlRulesList.innerHTML = '';

            // 添加新规则的输入区域
            const newRuleElement = document.createElement('div');
            newRuleElement.className = 'url-rule-item new-rule';
            newRuleElement.innerHTML = `
                <div class="url-rule-header">
                    <input type="text" class="url-rule-pattern-input" placeholder="输入URL匹配模式 (支持*通配符)">
                    <div class="url-rule-actions">
                        <button class="url-rule-action-btn confirm-rule" title="确认">
                            <i class="far fa-check"></i>
                        </button>
                    </div>
                </div>
                <div class="url-rule-content">
                    <div class="url-rule-type">
                        <select>
                            <option value="system">系统提示词</option>
                            <option value="summary">快速总结提示词</option>
                        </select>
                    </div>
                    <textarea class="url-rule-prompt" placeholder="输入提示词内容..."></textarea>
                </div>
            `;

            // 绑定新规则的确认事件
            const confirmBtn = newRuleElement.querySelector('.confirm-rule');
            const patternInput = newRuleElement.querySelector('.url-rule-pattern-input');
            const typeSelect = newRuleElement.querySelector('select');
            const promptTextarea = newRuleElement.querySelector('.url-rule-prompt');

            confirmBtn.addEventListener('click', () => {
                const pattern = patternInput.value.trim();
                const type = typeSelect.value;
                const prompt = promptTextarea.value.trim();

                if (pattern && prompt) {
                    this.addUrlRule({
                        pattern,
                        type,
                        prompt
                    });
                    // 清空输入
                    patternInput.value = '';
                    promptTextarea.value = '';
                    typeSelect.value = 'system';
                }
            });

            // 添加新规则输入区域
            this.urlRulesList.appendChild(newRuleElement);

            // 渲染现有规则
            rules.forEach((rule, index) => {
                const ruleElement = this.createUrlRuleElement(rule, index);
                this.urlRulesList.appendChild(ruleElement);
            });
        } catch (error) {
            console.error('渲染URL规则失败:', error);
        }
    }

    /**
     * 添加新的URL规则
     * @param {Object} rule - 规则对象
     */
    addUrlRule(rule) {
        try {
            const rules = JSON.parse(this.urlRulesPrompt.value || '[]');
            rules.push(rule);
            this.urlRulesPrompt.value = JSON.stringify(rules);
            this.renderUrlRules();
            this.autoSavePromptSettings();
        } catch (error) {
            console.error('添加URL规则失败:', error);
        }
    }

    /**
     * 创建URL规则元素
     * @param {Object} rule - 规则对象
     * @param {number} index - 规则索引
     * @returns {HTMLElement} 规则元素
     */
    createUrlRuleElement(rule, index) {
        const ruleElement = document.createElement('div');
        ruleElement.className = 'url-rule-item';
        ruleElement.innerHTML = `
            <div class="url-rule-header">
                <div class="url-rule-pattern">${rule.pattern}</div>
                <div class="url-rule-actions">
                    <button class="url-rule-action-btn edit-rule" title="编辑">
                        <i class="far fa-edit"></i>
                    </button>
                    <button class="url-rule-action-btn delete-rule" title="删除">
                        <i class="far fa-trash-alt"></i>
                    </button>
                </div>
            </div>
            <div class="url-rule-content">
                <div class="url-rule-type">
                    <select>
                        <option value="system" ${rule.type === 'system' ? 'selected' : ''}>系统提示词</option>
                        <option value="summary" ${rule.type === 'summary' ? 'selected' : ''}>快速总结提示词</option>
                    </select>
                </div>
                <textarea class="url-rule-prompt">${rule.prompt}</textarea>
            </div>
        `;

        // 绑定事件
        const deleteBtn = ruleElement.querySelector('.delete-rule');
        const editBtn = ruleElement.querySelector('.edit-rule');
        const typeSelect = ruleElement.querySelector('select');
        const promptTextarea = ruleElement.querySelector('.url-rule-prompt');

        deleteBtn.addEventListener('click', () => {
            this.deleteUrlRule(index);
        });

        editBtn.addEventListener('click', () => {
            this.editUrlRule(index);
        });

        typeSelect.addEventListener('change', () => {
            this.updateUrlRule(index, {
                ...rule,
                type: typeSelect.value
            });
        });

        promptTextarea.addEventListener('change', () => {
            this.updateUrlRule(index, {
                ...rule,
                prompt: promptTextarea.value
            });
        });

        return ruleElement;
    }

    /**
     * 删除URL规则
     * @param {number} index - 规则索引
     */
    deleteUrlRule(index) {
        try {
            const rules = JSON.parse(this.urlRulesPrompt.value || '[]');
            rules.splice(index, 1);
            this.urlRulesPrompt.value = JSON.stringify(rules);
            this.renderUrlRules();
            this.autoSavePromptSettings();
        } catch (error) {
            console.error('删除URL规则失败:', error);
        }
    }

    /**
     * 编辑URL规则
     * @param {number} index - 规则索引
     */
    editUrlRule(index) {
        try {
            const rules = JSON.parse(this.urlRulesPrompt.value || '[]');
            const rule = rules[index];
            const newPattern = prompt('请输入新的URL匹配模式:', rule.pattern);
            if (!newPattern) return;

            rules[index] = {
                ...rule,
                pattern: newPattern
            };
            this.urlRulesPrompt.value = JSON.stringify(rules);
            this.renderUrlRules();
            this.autoSavePromptSettings();
        } catch (error) {
            console.error('编辑URL规则失败:', error);
        }
    }

    /**
     * 更新URL规则
     * @param {number} index - 规则索引
     * @param {Object} newRule - 新规则对象
     */
    updateUrlRule(index, newRule) {
        try {
            const rules = JSON.parse(this.urlRulesPrompt.value || '[]');
            rules[index] = newRule;
            this.urlRulesPrompt.value = JSON.stringify(rules);
            this.autoSavePromptSettings();
        } catch (error) {
            console.error('更新URL规则失败:', error);
        }
    }
}

// 导出 PromptSettings 类和默认提示词
export { PromptSettings, DEFAULT_PROMPTS }; 