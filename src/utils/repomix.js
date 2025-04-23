// background.js - Chrome Extension Service Worker

const API_ENDPOINT = 'https://api.repomix.com/api/pack';

/*
 * 通过（非官方）Repomix API 打包远程仓库 (Chrome 扩展版本)。
 * 使用浏览器内置的 fetch 和 FormData。
 *
 * @param {string} repoUrl 要打包的仓库 URL 或 "user/repo" 格式。
 * @returns {Promise<string>} 返回打包后的仓库内容字符串。
 * @throws {Error} 如果 API 调用失败或返回错误。
 */
export async function packRemoteRepoViaApiExtension(repoUrl) {
  console.log(`[Repomix Ext] 开始打包: ${repoUrl}`);

  // --- 配置 ---
  const packOptions = {}; // 依赖服务器端默认值
  const format = 'xml'; // CLI 默认且对 AI 友好
  // --------------

  if (!repoUrl || typeof repoUrl !== 'string') {
    console.error('[Repomix Ext] 无效的仓库 URL:', repoUrl);
    throw new Error('无效的仓库 URL');
  }

  // 使用浏览器内置的 FormData
  const formData = new FormData();
  formData.append('url', repoUrl.trim());
  formData.append('format', format);
  formData.append('options', JSON.stringify(packOptions));

  try {
    // 使用浏览器内置的 fetch
    const response = await fetch(API_ENDPOINT, {
      method: 'POST',
      body: formData,
      // 浏览器会自动处理 Content-Type for FormData
      // 注意：如果服务器有严格的 CORS 策略，这里可能失败
      // 需要在 manifest.json 中声明 host_permissions
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
      return result.content; // 返回打包好的内容
    }
    console.error('[Repomix Ext] 从 API 收到了无效的响应格式:', result);
    throw new Error('从 API 收到了无效的响应格式');

  } catch (error) {
    console.error('[Repomix Ext] 调用 Repomix API 时出错:', error);
    // 重新抛出错误，以便消息发送方可以处理它
    throw error; // 保留原始错误类型
  }
}

// --- 示例: 监听来自扩展其他部分（如 popup.js）的消息 ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'packRepository') {
    const repoUrl = message.url;
    if (!repoUrl) {
      console.error("[Repomix Ext] 未在消息中提供 URL");
      sendResponse({ success: false, error: '未提供仓库 URL' });
      return true; // 表示异步处理 sendResponse
    }

    packRemoteRepoViaApiExtension(repoUrl)
      .then(content => {
        console.log("[Repomix Ext] 成功将内容发送回请求方");
        sendResponse({ success: true, data: content });
      })
      .catch(error => {
        console.error("[Repomix Ext] 打包或发送响应时出错:", error);
        sendResponse({ success: false, error: error.message || '打包仓库时发生未知错误' });
      });

    return true; // 返回 true 表示我们将异步发送响应
  }
  // 可以添加其他消息处理逻辑
});

console.log('[Repomix Ext] 后台脚本已加载并监听消息。');
