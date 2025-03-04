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
    // 添加消息折叠相关设置
    foldPattern: {
        prompt: `^([\\s\\S]*?)(?=\\n# )`,
        model: 'follow_current'
    },
    foldSummary: {
        prompt: `搜索过程`,
        model: 'follow_current'
    },
    urlRules: {
        prompt: '[]',  // 存储为JSON字符串，格式为[{pattern: string, type: 'summary'|'system', prompt: string}]
        model: 'follow_current'
    }
};

class PromptSettings {
    constructor() {
        // DOM 元素
        this.promptSettingsToggle = document.getElementById('prompt-settings-toggle');
        this.promptSettings = document.getElementById('prompt-settings');
        this.promptBackButton = this.promptSettings.querySelector('.back-button');
        this.resetPromptsButton = document.getElementById('reset-prompts');
        this.savePromptsButton = document.getElementById('save-prompts');
        this.selectionPrompt = document.getElementById('selection-prompt');
        this.systemPrompt = document.getElementById('system-prompt');
        this.pdfPrompt = document.getElementById('pdf-prompt');
        this.summaryPrompt = document.getElementById('summary-prompt');
        this.queryPrompt = document.getElementById('query-prompt');
        this.imagePrompt = document.getElementById('image-prompt');
        this.screenshotPrompt = document.getElementById('screenshot-prompt');
        this.extractPrompt = document.getElementById('extract-prompt');
        // 添加消息折叠相关元素
        this.foldPatternPrompt = document.getElementById('fold-pattern-prompt');
        this.foldSummaryPrompt = document.getElementById('fold-summary-prompt');
        this.urlRulesPrompt = document.getElementById('url-rules-prompt');

        // 模型选择下拉框
        this.modelSelects = {};
        this.initModelSelects();

        // 为每个提示词文本框添加重置按钮
        this.addResetButtons();
        
        // 绑定事件处理器
        this.bindEvents();
        
        // 初始化提示词设置
        this.loadPromptSettings();

        // URL规则相关元素
        this.urlRulesList = document.getElementById('url-rules-list');
        
        // 初始化URL规则列表
        this.renderUrlRules();
    }

    // 初始化模型选择下拉框
    initModelSelects() {
        const promptTypes = ['selection', 'query', 'pdf', 'summary', 'image', 'foldPattern', 'foldSummary', 'urlRules']; 

        // 获取所有可用的模型
        const getAvailableModels = () => {
            // 从 window.apiConfigs 获取所有唯一的模型名称
            const models = new Set();
            if (window.apiConfigs) {
                window.apiConfigs.forEach(config => {
                    if (config.modelName) {
                        models.add(config.modelName);
                    }
                });
            }
            return Array.from(models);
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
                const models = getAvailableModels();
                // 保存当前选中的值
                const valueToKeep = currentSelectedValue || select.value || 'follow_current';
                select.innerHTML = ''; // 清空现有选项

                // 添加"跟随当前 API 设置"选项
                const followOption = document.createElement('option');
                followOption.value = 'follow_current';
                followOption.textContent = '跟随当前 API 设置';
                select.appendChild(followOption);

                // 添加分隔线
                const separator = document.createElement('option');
                separator.disabled = true;
                separator.textContent = '──────────';
                select.appendChild(separator);
                
                // 添加已配置的模型
                models.forEach(model => {
                    const option = document.createElement('option');
                    option.value = model;
                    option.textContent = model;
                    select.appendChild(option);
                });

                // 尝试恢复选中的值
                if (valueToKeep === 'follow_current' || models.includes(valueToKeep)) {
                    select.value = valueToKeep;
                } else {
                    select.value = 'follow_current';
                }
            };

            // 初始化模型选项
            updateModelOptions();

            // 监听 API 配置变化
            window.addEventListener('apiConfigsUpdated', () => {
                // 保持当前选中的值
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
            'foldPattern': '消息折叠正则表达式',
            'foldSummary': '折叠消息摘要文本',
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

    // 迁移旧格式的提示词设置到新格式
    async migrateOldPromptSettings() {
        try {
            // 检查是否存在旧格式的数据
            const oldData = await new Promise(resolve => {
                chrome.storage.sync.get(['prompts'], result => resolve(result.prompts));
            });

            if (!oldData) {
                return; // 没有旧数据需要迁移
            }

            console.log('开始迁移旧格式提示词设置...');

            // 将旧数据按类型分别存储
            const migrationPromises = Object.entries(oldData).map(([type, settings]) => {
                return new Promise(resolve => {
                    chrome.storage.sync.set({
                        [`prompt_${type}`]: settings
                    }, resolve);
                });
            });

            // 等待所有迁移操作完成
            await Promise.all(migrationPromises);

            // 删除旧格式数据
            await new Promise(resolve => {
                chrome.storage.sync.remove(['prompts'], resolve);
            });

            console.log('提示词设置迁移完成');
        } catch (error) {
            console.error('迁移提示词设置时出错:', error);
        }
    }

    // 加载提示词设置
    async loadPromptSettings() {
        try {
            // 首先执行迁移
            await this.migrateOldPromptSettings();

            // 获取所有提示词类型的设置
            const types = Object.keys(DEFAULT_PROMPTS);
            const promises = types.map(type => {
                return new Promise(resolve => {
                    chrome.storage.sync.get([`prompt_${type}`], result => {
                        resolve([type, result[`prompt_${type}`]]);
                    });
                });
            });

            const results = await Promise.all(promises);

            // 更新UI
            results.forEach(([type, settings]) => {
                if (!settings) {
                    settings = DEFAULT_PROMPTS[type];
                }

                const promptElement = this[`${type}Prompt`];
                if (promptElement) {
                    promptElement.value = settings.prompt;
                }

                // 更新模型选择
                const modelSelect = document.querySelector(`#${type}-model`);
                if (modelSelect) {
                    modelSelect.value = settings.model || 'follow_current';
                }
            });

            // 重新渲染URL规则列表
            this.renderUrlRules();
        } catch (error) {
            console.error('加载提示词设置时出错:', error);
        }
    }

    // 自动保存提示词设置（不关闭面板）
    async autoSavePromptSettings() {
        try {
            const prompts = this.collectCurrentPromptSettings();
            
            // 分别存储每个提示词类型
            const savePromises = Object.entries(prompts).map(([type, value]) => {
                return chrome.storage.sync.set({ [`prompt_${type}`]: value });
            });
            
            // 等待所有存储操作完成
            await Promise.all(savePromises);
            
            // 触发提示词设置更新事件
            document.dispatchEvent(new CustomEvent('promptSettingsUpdated'));
            
            // 显示轻微的保存提示但不关闭面板
            const saveButton = this.savePromptsButton;
            const originalText = saveButton.textContent;
            const originalBackground = saveButton.style.background;
            
            saveButton.textContent = '已自动保存';
            saveButton.style.background = 'rgba(52, 199, 89, 0.4)';
            
            setTimeout(() => {
                saveButton.textContent = originalText;
                saveButton.style.background = originalBackground;
            }, 800);
        } catch (error) {
            console.error('自动保存提示词设置失败:', error);
        }
    }

    // 保存提示词设置
    async savePromptSettings(shouldClosePanel = true) {
        try {
            const prompts = this.collectCurrentPromptSettings();
            
            // 分别存储每个提示词类型
            const savePromises = Object.entries(prompts).map(([type, value]) => {
                return chrome.storage.sync.set({ [`prompt_${type}`]: value });
            });
            
            // 等待所有存储操作完成
            await Promise.all(savePromises);
            
            // 触发提示词设置更新事件
            document.dispatchEvent(new CustomEvent('promptSettingsUpdated'));
            
            // 只有在需要关闭面板时才关闭
            if (shouldClosePanel) {
                this.promptSettings.classList.remove('visible');
            }
            
            // 显示保存成功提示
            const saveButton = this.savePromptsButton;
            const originalText = saveButton.textContent;
            saveButton.textContent = '已保存';
            saveButton.style.background = '#34C759';
            setTimeout(() => {
                saveButton.textContent = originalText;
                saveButton.style.background = '';
            }, 2000);
        } catch (error) {
            console.error('保存提示词设置失败:', error);
            alert('保存设置失败，请重试');
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
        document.dispatchEvent(new CustomEvent('promptSettingsUpdated'));
    }

    /**
     * 获取当前提示词，自动处理URL规则匹配
     * @returns {Object} 提示词设置对象
     */
    getPrompts() {
        const prompts = {};
        Object.keys(DEFAULT_PROMPTS).forEach(type => {
            const textarea = this[`${type}Prompt`];
            if (!textarea) {
                console.error(`找不到提示词文本框: ${type}`);
                return;
            }

            let promptValue = textarea.value;
            
            // 从window.cerebr.pageInfo获取当前页面信息
            const pageInfo = window.cerebr?.pageInfo;
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

            prompts[type] = {
                prompt: promptValue,
                model: this.modelSelects[type]?.value || DEFAULT_PROMPTS[type].model
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
            // 按添加顺序反向遍历，使后添加的规则优先级更高
            for (let i = rules.length - 1; i >= 0; i--) {
                const rule = rules[i];
                if (rule.type !== type) continue;
                
                try {
                    // 将通配符转换为正则表达式
                    const pattern = rule.pattern
                        .replace(/\./g, '\\.')
                        .replace(/\*/g, '.*')
                        .replace(/\?/g, '.');
                    const regex = new RegExp('^' + pattern + '$');
                    
                    if (regex.test(url)) {
                        return rule.prompt;
                    }
                } catch (e) {
                    console.error(`规则 "${rule.pattern}" 转换为正则表达式失败:`, e);
                    continue;
                }
            }
        } catch (error) {
            console.error('解析URL规则失败:', error);
        }
        return null;
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