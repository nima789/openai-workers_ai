// ===== 配置常量 =====
const CONFIG = {
  MAX_REQUEST_SIZE: 1024 * 1024, // 1MB
  STREAM_CHUNK_SIZE: 100, // 字符数
  DEFAULT_TEMPERATURE: 0.7,
  DEFAULT_TOP_P: 0.9,
  DEFAULT_MAX_TOKENS: 4096,
  CACHE_TTL: 300, // 5分钟缓存
};

const MODEL_MAP = {
  'deepseek-r1': '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
  'gpt-oss-120b': '@cf/openai/gpt-oss-120b',
  'gpt-oss-20b': '@cf/openai/gpt-oss-20b',
  'llama-4-scout': '@cf/meta/llama-4-scout-17b-16e-instruct',
  'qwen2.5-coder': '@cf/qwen/qwen2.5-coder-32b-instruct',
  'gemma-3': '@cf/google/gemma-3-12b-it'
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

// ===== 工具函数 =====
class APIError extends Error {
  constructor(message, statusCode = 400, code = 'invalid_request_error') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function createResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
      ...headers,
    },
  });
}

function createErrorResponse(error) {
  const statusCode = error.statusCode || 500;
  const errorData = {
    error: {
      message: error.message,
      type: error.code || 'server_error',
      code: error.code || 'internal_error',
    },
  };
  return createResponse(errorData, statusCode);
}

// 更准确的 token 估算 (使用 tiktoken 的简化版本)
function estimateTokens(text) {
  if (!text) return 0;
  // 英文约 4 字符/token,中文约 1.5-2 字符/token
  const avgCharsPerToken = /[\u4e00-\u9fa5]/.test(text) ? 1.8 : 4;
  return Math.ceil(text.length / avgCharsPerToken);
}

// ===== 认证中间件 =====
function validateAuth(request, env) {
  const authHeader = request.headers.get('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new APIError('API key required', 401, 'invalid_api_key');
  }

  const apiKey = authHeader.substring(7);
  const validApiKeys = env.VALID_API_KEYS ? env.VALID_API_KEYS.split(',') : [];
  
  if (validApiKeys.length === 0 || !validApiKeys.includes(apiKey)) {
    throw new APIError('Invalid API key', 401, 'invalid_api_key');
  }
  
  return apiKey;
}

// ===== AI 请求处理 =====
async function buildAIRequest(body, cfModel) {
  const useResponsesAPI = cfModel.startsWith('@cf/openai/gpt-oss');

  if (useResponsesAPI) {
    const systemMsg = body.messages.find(m => m.role === 'system')?.content || 
                      "You are a helpful assistant.";
    const userMsgs = body.messages
      .filter(m => m.role === 'user')
      .map(m => m.content)
      .join("\n");

    return {
      input: userMsgs,
      instructions: systemMsg,
      temperature: body.temperature ?? CONFIG.DEFAULT_TEMPERATURE,
      top_p: body.top_p ?? CONFIG.DEFAULT_TOP_P,
      max_tokens: body.max_tokens ?? 2048,
      reasoning: body.reasoning ?? { effort: "medium" }
    };
  }

  // 标准消息格式
  return {
    messages: body.messages.map(msg => ({
      role: msg.role,
      content: msg.content || ""
    })),
    temperature: body.temperature ?? CONFIG.DEFAULT_TEMPERATURE,
    top_p: body.top_p ?? CONFIG.DEFAULT_TOP_P,
    max_tokens: body.max_tokens ?? CONFIG.DEFAULT_MAX_TOKENS,
  };
}

async function callAI(env, cfModel, aiRequest, body, useResponsesAPI) {
  try {
    return await env.AI.run(cfModel, aiRequest);
  } catch (error) {
    // 仅对非 gpt-oss 模型尝试 fallback
    if (useResponsesAPI) throw error;

    console.warn('Falling back to prompt format:', error.message);

    const prompt = body.messages
      .map(m => {
        const roleMap = { system: 'System', user: 'User', assistant: 'Assistant' };
        return `${roleMap[m.role]}: ${m.content}`;
      })
      .join("\n\n") + "\n\nAssistant: ";

    return await env.AI.run(cfModel, {
      prompt,
      temperature: aiRequest.temperature,
      top_p: aiRequest.top_p,
      max_tokens: aiRequest.max_tokens,
    });
  }
}

function extractContent(response, useResponsesAPI) {
  if (useResponsesAPI) {
    if (response.output && Array.isArray(response.output)) {
      return response.output
        .flatMap(msg => msg.content
          .filter(c => c.type === "output_text")
          .map(c => c.text)
        )
        .join("\n");
    }
  }

  // 按优先级尝试不同格式
  const content = response.response || 
                  response.generated_text || 
                  response.choices?.[0]?.message?.content ||
                  (typeof response === 'string' ? response : null);

  if (!content) {
    console.warn('Unexpected response format:', response);
    return JSON.stringify(response);
  }

  // 清理可能的提示重复
  return content.includes('Assistant: ') 
    ? content.split('Assistant: ').pop() 
    : content;
}

// ===== 流式响应生成 =====
function createStreamResponse(content, model, completionId, timestamp) {
  const encoder = new TextEncoder();
  
  const stream = new ReadableStream({
    start(controller) {
      // 开始块
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id: completionId,
        object: 'chat.completion.chunk',
        created: timestamp,
        model,
        choices: [{ index: 0, delta: { role: 'assistant', content: "" }, finish_reason: null }]
      })}\n\n`));

      // 内容块
      for (let i = 0; i < content.length; i += CONFIG.STREAM_CHUNK_SIZE) {
        const chunk = content.slice(i, i + CONFIG.STREAM_CHUNK_SIZE);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          id: completionId,
          object: 'chat.completion.chunk',
          created: timestamp,
          model,
          choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }]
        })}\n\n`));
      }

      // 结束块
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id: completionId,
        object: 'chat.completion.chunk',
        created: timestamp,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
      })}\n\n`));
      
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...CORS_HEADERS,
    },
  });
}

// ===== 路由处理 =====
async function handleChatCompletion(request, env) {
  const body = await request.json();

  // 验证请求体
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    throw new APIError('Messages must be a non-empty array', 400, 'invalid_parameter');
  }

  // 验证模型
  const model = body.model || 'deepseek-r1';
  const cfModel = MODEL_MAP[model];
  if (!cfModel) {
    throw new APIError(`Model '${model}' not supported`, 400, 'model_not_found');
  }

  // 构建请求
  const useResponsesAPI = cfModel.startsWith('@cf/openai/gpt-oss');
  const aiRequest = await buildAIRequest(body, cfModel);
  
  // 调用 AI
  const response = await callAI(env, cfModel, aiRequest, body, useResponsesAPI);
  const content = extractContent(response, useResponsesAPI);

  // 生成元数据
  const completionId = 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').substring(0, 24);
  const timestamp = Math.floor(Date.now() / 1000);

  // 流式返回
  if (body.stream) {
    return createStreamResponse(content, model, completionId, timestamp);
  }

  // 非流式返回
  const messagesText = JSON.stringify(body.messages);
  const promptTokens = estimateTokens(messagesText);
  const completionTokens = estimateTokens(content);

  return createResponse({
    id: completionId,
    object: 'chat.completion',
    created: timestamp,
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop'
    }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens
    }
  });
}

function handleModels() {
  const models = Object.keys(MODEL_MAP).map(id => ({
    id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'cloudflare',
  }));

  return createResponse({ object: 'list', data: models });
}

function handleHealth() {
  return createResponse({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    models: Object.keys(MODEL_MAP)
  });
}

// ===== 主入口 =====
export default {
  async fetch(request, env, ctx) {
    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      const url = new URL(request.url);

      // 公开端点
      if (url.pathname === '/health' && request.method === 'GET') {
        return handleHealth();
      }

      if (url.pathname === '/v1/models' && request.method === 'GET') {
        return handleModels();
      }

      // 需要认证的端点
      validateAuth(request, env);

      // 聊天完成
      if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
        // 检查请求体大小
        const contentLength = request.headers.get('content-length');
        if (contentLength && parseInt(contentLength) > CONFIG.MAX_REQUEST_SIZE) {
          throw new APIError('Request body too large', 413, 'payload_too_large');
        }

        return await handleChatCompletion(request, env);
      }

      // 404
      throw new APIError('Not found', 404, 'not_found');

    } catch (error) {
      console.error('Request error:', error);
      
      if (error instanceof APIError) {
        return createErrorResponse(error);
      }
      
      return createErrorResponse(
        new APIError('Internal server error', 500, 'internal_error')
      );
    }
  },
};
