// 默认提示词
const DEFAULT_PROMPTS = {
    system: {
        prompt: `数学公式请使用LaTeX表示，行间公式请使用\\[...\\]表示，行内公式请使用\\(...\\)表示，禁止使用$美元符号包裹数学公式。始终使用**中文**回答用户问题。`,
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
        // 添加消息折叠相关元素
        this.foldPatternPrompt = document.getElementById('fold-pattern-prompt');
        this.foldSummaryPrompt = document.getElementById('fold-summary-prompt');

        // 模型选择下拉框
        this.modelSelects = {};
        this.initModelSelects();

        // 为每个提示词文本框添加重置按钮
        this.addResetButtons();
        
        // 绑定事件处理器
        this.bindEvents();
        
        // 初始化提示词设置
        this.loadPromptSettings();
    }

    // 初始化模型选择下拉框
    initModelSelects() {
        const promptTypes = ['selection', 'query', 'pdf', 'summary', 'image', 'foldPattern', 'foldSummary']; 

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
            'foldSummary': '折叠消息摘要文本'
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

    // 加载提示词设置
    async loadPromptSettings() {
        try {
            const result = await chrome.storage.sync.get(['prompts']);
            
            if (result.prompts) {
                // 先加载提示词文本，因为它不依赖模型选项
                Object.keys(DEFAULT_PROMPTS).forEach(type => {
                    const promptData = result.prompts[type] || DEFAULT_PROMPTS[type];
                    if (this[`${type}Prompt`]) {
                        const promptValue = (typeof promptData.prompt !== 'undefined') ? 
                            promptData.prompt : 
                            (typeof promptData === 'string' ? promptData : DEFAULT_PROMPTS[type].prompt);
                        this[`${type}Prompt`].value = promptValue;
                    }
                });
                
                // 当确保DOM已渲染后，设置模型选择
                // 使用requestAnimationFrame确保在下一帧渲染后执行
                requestAnimationFrame(() => {
                    Object.keys(DEFAULT_PROMPTS).forEach(type => {
                        if (this.modelSelects[type]) {
                            const promptData = result.prompts[type] || DEFAULT_PROMPTS[type];
                            const modelValue = promptData.model || DEFAULT_PROMPTS[type].model;
                            if (this.modelSelects[type].querySelector(`option[value="${modelValue}"]`)) {
                                this.modelSelects[type].value = modelValue;
                            }
                        }
                    });
                });
            } else {
                this.resetPrompts();
            }
        } catch (error) {
            console.error('加载提示词设置失败:', error);
            this.resetPrompts();
        }
    }

    // 自动保存提示词设置（不关闭面板）
    async autoSavePromptSettings() {
        try {
            const prompts = this.collectCurrentPromptSettings();
            await chrome.storage.sync.set({ prompts });
            
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
            await chrome.storage.sync.set({ prompts });
            
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

    // 获取当前提示词
    getPrompts() {
        const prompts = {};
        Object.keys(DEFAULT_PROMPTS).forEach(type => {
            const textarea = this[`${type}Prompt`];
            if (!textarea) {
                console.error(`找不到提示词文本框: ${type}`);
                return;
            }

            prompts[type] = {
                prompt: textarea.value,
                // 如果存在模型选择下拉框就使用其值，否则使用默认值
                model: this.modelSelects[type]?.value || DEFAULT_PROMPTS[type].model
            };
        });
        return prompts;
    }
}

// 导出 PromptSettings 类和默认提示词
export { PromptSettings, DEFAULT_PROMPTS }; 