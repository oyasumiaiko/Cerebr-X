// background.js - Chrome Extension Service Worker

const API_ENDPOINT = 'https://api.repomix.com/api/pack';

/**
 * 从 GitHub 仓库 URL 中提取子路径。
 * 例如，对于 "https://github.com/USER/REPO/tree/BRANCH/PATH_A/PATH_B"，
 * 将返回 "PATH_A/PATH_B"。
 * 如果 URL 不是有效的 GitHub tree URL（例如，缺少 'tree' 部分或子路径），或者不是 GitHub URL，则返回 null。
 *
 * @param {string} repoUrl 要解析的仓库 URL。
 * @returns {string|null} 提取的子路径字符串，如果无法提取则为 null。
 * @example
 * getGitHubSubPath("https://github.com/user/repo/tree/main/src/components") // "src/components"
 * getGitHubSubPath("https://github.com/user/repo/tree/main") // null (没有明确的子目录路径)
 * getGitHubSubPath("https://github.com/user/repo") // null
 * getGitHubSubPath("https://gitlab.com/user/repo") // null
 */
function getGitHubSubPath(repoUrl) {
  try {
    const url = new URL(repoUrl);
    if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') {
      return null;
    }

    const pathSegments = url.pathname.split('/').filter(segment => segment.length > 0);
    const treeIndex = pathSegments.indexOf('tree');

    if (treeIndex === -1 || treeIndex + 2 >= pathSegments.length) {
      return null;
    }

    const subPath = pathSegments.slice(treeIndex + 2).join('/');
    return subPath.length > 0 ? subPath : null;

  } catch (e) {
    console.warn(`[Repomix Ext] 解析 GitHub 子路径时出错: ${repoUrl}`, e.message);
    return null;
  }
}

/**
 * 通过（非官方）Repomix API 打包远程仓库 (Chrome 扩展版本)。
 * 使用浏览器内置的 fetch 和 FormData。
 * 允许用户提供自定义打包选项，并能根据 GitHub URL 自动推断 includePatterns。
 *
 * @param {string} repoUrl 要打包的仓库 URL 或 "user/repo" 格式。
 * @param {object} [userSuppliedOptions={}] 用户提供的打包选项，将覆盖默认值或派生值。
 * @returns {Promise<string>} 返回打包后的仓库内容字符串。
 * @throws {Error} 如果 API 调用失败或返回错误。
 */
export async function packRemoteRepoViaApiExtension(repoUrl, userSuppliedOptions = {}) {
  console.log(`[Repomix Ext] 开始打包: ${repoUrl}`, "用户选项:", userSuppliedOptions);

  // --- 配置 ---
  let resolvedOptions = {
    removeComments: false,
    removeEmptyLines: true,
    showLineNumbers: false,
    fileSummary: true,
    directoryStructure: true,
    ignorePatterns: "**/*.asset,**/*.prefab,**/*.unity,**/*.meta,LICENSE",
    outputParsable: false,
    compress: false,
    // includePatterns 默认不设置，除非派生或用户提供
  };

  // 2. 如果用户未提供 includePatterns，则尝试从 URL 派生
  let derivedIncludePatterns = null;
  if (!userSuppliedOptions || !userSuppliedOptions.hasOwnProperty('includePatterns')) {
    const subPath = getGitHubSubPath(repoUrl);
    if (subPath) {
      derivedIncludePatterns = `${subPath}/**/*`; // 使用 '/**/*' 以递归包含子目录内容
      console.log(`[Repomix Ext] GitHub 子路径 '${subPath}' 已检测。准备自动包含: '${derivedIncludePatterns}'`);
    }
  }

  // 3. 如果派生了 includePatterns，则将其添加到 resolvedOptions
  //    用户提供的选项将在下一步覆盖它（如果存在）
  if (derivedIncludePatterns) {
    resolvedOptions.includePatterns = derivedIncludePatterns;
  }

  // 4. 将用户提供的选项覆盖到 resolvedOptions 上
  //    这确保了用户设置（包括空的 includePatterns/ignorePatterns）具有最高优先级
  if (userSuppliedOptions) {
    resolvedOptions = { ...resolvedOptions, ...userSuppliedOptions };
  }

  console.log('[Repomix Ext] 生效的 packOptions 将被发送:', resolvedOptions);

  if (!repoUrl || typeof repoUrl !== 'string') {
    console.error('[Repomix Ext] 无效的仓库 URL:', repoUrl);
    throw new Error('无效的仓库 URL');
  }

  // 使用浏览器内置的 FormData
  const formData = new FormData();
  formData.append('url', repoUrl.trim());
  formData.append('format', 'xml'); // format 固定为 xml
  formData.append('options', JSON.stringify(resolvedOptions));

  try {
    const response = await fetch(API_ENDPOINT, {
      method: 'POST',
      body: formData,
    });

    console.log(`[Repomix Ext] API 响应状态: ${response.status}`);

    if (!response.ok) {
      let errorData = { error: `请求失败，状态码: ${response.status}` };
      try {
        // 尝试解析错误信息
        const errorJson = await response.json();
        if (errorJson && errorJson.error) {
          errorData.error = `API 错误 (状态 ${response.status}): ${errorJson.error}`;
        }
      } catch (e) {
        console.warn('[Repomix Ext] 解析 API 错误响应失败:', e);
        errorData.error += ` - ${response.statusText}`;
      }
      console.error('[Repomix Ext] API 请求失败:', errorData.error);
      throw new Error(errorData.error);
    }

    // 解析成功的 JSON 响应
    const result = await response.json();

    if (result && typeof result.content === 'string') {
      console.log(`[Repomix Ext] 成功打包仓库: ${repoUrl}`);
      
      let infoHeader = `打包仓库: ${repoUrl.replace('https://github.com/', '')}\n`;
      if (resolvedOptions.includePatterns) {
        infoHeader += `指定包含路径: ${resolvedOptions.includePatterns}\n`;
      } else {
        infoHeader += `处理范围: 整个仓库 (根目录)\n`;
      }
      if (resolvedOptions.ignorePatterns) {
        infoHeader += `忽略规则: ${resolvedOptions.ignorePatterns}\n`;
      }
      infoHeader += '\n---\n\n';
      
      return infoHeader + result.content; // 返回打包好的内容，预置信息头
    }
    console.error('[Repomix Ext] 从 API 收到了无效的响应格式:', result);
    throw new Error('从 API 收到了无效的响应格式');

  } catch (error) {
    console.error('[Repomix Ext] 调用 Repomix API 时出错:', error);
    throw error;
  }
}

// --- 示例: 监听来自扩展其他部分（如 popup.js）的消息 ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'packRepository') {
    const repoUrl = message.url;
    const userOptions = message.options || {}; // 从消息中获取用户选项

    if (!repoUrl) {
      console.error("[Repomix Ext] 未在消息中提供 URL");
      sendResponse({ success: false, error: '未提供仓库 URL' });
      return true; // 表示异步处理 sendResponse
    }

    packRemoteRepoViaApiExtension(repoUrl, userOptions) // 传递用户选项
      .then(content => {
        console.log("[Repomix Ext] 成功将内容发送回请求方");
        sendResponse({ success: true, data: content });
      })
      .catch(error => {
        console.error("[Repomix Ext] 打包或发送响应时出错:", error);
        sendResponse({ success: false, error: error.message || '打包仓库时发生未知错误' });
      });

    return true;
  }
});

console.log('[Repomix Ext] 后台脚本已加载并监听消息。');
