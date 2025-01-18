// 默认提示词
const DEFAULT_PROMPTS = {
    system: `数学公式请使用LaTeX表示，行间公式请使用\\[...\\]表示，行内公式请使用\\(...\\)表示，禁止使用$美元符号包裹数学公式。始终使用**中文**回答用户问题。`,

    selection: `请根据以下内容的复杂度，编写3-20条多方面、多层次、多角度的queries，使用google_search(queries)工具执行。
"<SELECTION>"

请全面、客观地总结以下搜索结果，既要突出核心要点，也要保留重要细节`,

    search: `\n\n---\n\n当需要获取最新或更准确的信息时，请使用google_search.search功能。搜索前请先思考：

1. 分析主题的关键概念和要素
2. 确定需要了解的具体方面
3. 考虑不同的视角和维度
4. 思考时间跨度和地域范围
5. 识别可能的专业术语

然后按以下原则设计queries：

1. 结合中英文，大部分使用英文，遵循以下模式：
   - [核心概念] + [具体方面/属性]
   - [主题] + [年份/时间范围] + [统计/研究/review]
   - [专业术语] + [definition/example/application]
   
2. 每个要点设计3-4个不同queries：
   - 使用同义词和相关词
   - 从一般到具体
   - 结合不同领域视角

3. 总共可以使用10-20个渐进式queries：
   - 先搜索基础概念和背景
   - 再搜索具体细节和案例
   - 最后搜索最新进展和争议

4. 搜索结果分析和整合：
   - 交叉验证不同来源
   - 对比不同观点
   - 提取关键数据和论据
   - 总结主流观点和新趋势

即使用户没有明确要求，也要主动搜索以确保信息：
1. 时效性 - 了解最新发展和变化
2. 全面性 - 覆盖不同角度和层面
3. 准确性 - 核实关键信息和数据
4. 权威性 - 参考可靠来源和专业观点
5. 客观性 - 平衡不同立场和论据`,

    pdf: `请对这个PDF文档进行分析：
1. 首先列出文档的详细大纲结构，包括各级标题和对应的主要内容；
2. 然后根据大纲结构，按照以下方面展开总结：
   - 文档的主要目的和核心论点
   - 每个主要部分的关键内容和要点
   - 重要的数据、图表或研究发现
   - 作者的结论和建议
3. 最后，总结文档的创新点、局限性和实际应用价值。

请用清晰的层级结构和要点形式展示以上内容。`,

    summary: `请对这个页面进行全面分析和总结：

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

    query: `请分析并解释以下内容：

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

请用清晰的结构和通俗的语言进行解释，确保内容准确、全面且易于理解。`
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
        this.searchPrompt = document.getElementById('search-prompt');
        this.systemPrompt = document.getElementById('system-prompt');
        this.pdfPrompt = document.getElementById('pdf-prompt');
        this.summaryPrompt = document.getElementById('summary-prompt');
        this.queryPrompt = document.getElementById('query-prompt');

        // 为每个提示词文本框添加重置按钮
        this.addResetButtons();
        
        // 绑定事件处理器
        this.bindEvents();
        
        // 初始化提示词设置
        this.loadPromptSettings();
    }

    // 添加重置按钮
    addResetButtons() {
        const promptGroups = this.promptSettings.querySelectorAll('.prompt-group');
        promptGroups.forEach(group => {
            const label = group.querySelector('label');
            const textarea = group.querySelector('textarea');
            const promptType = textarea.id.replace('-prompt', '');

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
            resetButton.addEventListener('click', () => this.resetSinglePrompt(promptType));

            // 创建标签容器来包含标签文本和重置按钮
            const labelContainer = document.createElement('div');
            labelContainer.className = 'prompt-label-container';
            
            // 将原标签内容和重置按钮移动到容器中
            labelContainer.appendChild(document.createTextNode(label.textContent));
            labelContainer.appendChild(resetButton);
            
            // 替换原标签
            label.textContent = '';
            label.appendChild(labelContainer);
        });
    }

    // 重置单个提示词
    resetSinglePrompt(promptType) {
        if (confirm(`确定要恢复"${this.getPromptTypeName(promptType)}"的默认提示词吗？`)) {
            const textarea = this[`${promptType}Prompt`];
            textarea.value = DEFAULT_PROMPTS[promptType];
            
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
            'selection': '划词搜索提示词',
            'search': '系统搜索提示词',
            'system': '系统提示词',
            'pdf': 'PDF提示词',
            'summary': '页面总结提示词',
            'query': '直接查询提示词'
        };
        return nameMap[promptType] || promptType;
    }

    // 绑定事件处理器
    bindEvents() {
        // 显示/隐藏提示词设置面板
        this.promptSettingsToggle.addEventListener('click', () => {
            this.promptSettings.classList.add('visible');
            // 调用外部函数关闭设置菜单
            window.toggleSettingsMenu(false);
        });

        // 返回按钮
        this.promptBackButton.addEventListener('click', () => {
            this.promptSettings.classList.remove('visible');
        });

        // 重置所有按钮
        this.resetPromptsButton.addEventListener('click', () => {
            if (confirm('确定要恢复所有默认提示词吗？这将覆盖当前的所有自定义提示词。')) {
                this.resetPrompts();
            }
        });

        // 保存按钮
        this.savePromptsButton.addEventListener('click', () => this.savePromptSettings());
    }

    // 加载提示词设置
    async loadPromptSettings() {
        try {
            const result = await chrome.storage.sync.get(['prompts']);
            if (result.prompts) {
                this.selectionPrompt.value = result.prompts.selection || DEFAULT_PROMPTS.selection;
                this.searchPrompt.value = result.prompts.search || DEFAULT_PROMPTS.search;
                this.systemPrompt.value = result.prompts.system || DEFAULT_PROMPTS.system;
                this.pdfPrompt.value = result.prompts.pdf || DEFAULT_PROMPTS.pdf;
                this.summaryPrompt.value = result.prompts.summary || DEFAULT_PROMPTS.summary;
                this.queryPrompt.value = result.prompts.query || DEFAULT_PROMPTS.query;
            } else {
                // 如果没有保存的设置，使用默认值
                this.resetPrompts();
            }
        } catch (error) {
            console.error('加载提示词设置失败:', error);
            // 如果加载失败，使用默认值
            this.resetPrompts();
        }
    }

    // 保存提示词设置
    async savePromptSettings() {
        try {
            await chrome.storage.sync.set({
                prompts: {
                    selection: this.selectionPrompt.value,
                    search: this.searchPrompt.value,
                    system: this.systemPrompt.value,
                    pdf: this.pdfPrompt.value,
                    summary: this.summaryPrompt.value,
                    query: this.queryPrompt.value
                }
            });
            // 立即关闭设置页面
            this.promptSettings.classList.remove('visible');
            
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
        }
    }

    // 重置提示词为默认值
    resetPrompts() {
        this.selectionPrompt.value = DEFAULT_PROMPTS.selection;
        this.searchPrompt.value = DEFAULT_PROMPTS.search;
        this.systemPrompt.value = DEFAULT_PROMPTS.system;
        this.pdfPrompt.value = DEFAULT_PROMPTS.pdf;
        this.summaryPrompt.value = DEFAULT_PROMPTS.summary;
        this.queryPrompt.value = DEFAULT_PROMPTS.query;
    }

    // 获取当前提示词
    getPrompts() {
        return {
            selection: this.selectionPrompt.value,
            search: this.searchPrompt.value,
            system: this.systemPrompt.value,
            pdf: this.pdfPrompt.value,
            summary: this.summaryPrompt.value,
            query: this.queryPrompt.value
        };
    }
}

// 导出 PromptSettings 类和默认提示词
export { PromptSettings, DEFAULT_PROMPTS }; 