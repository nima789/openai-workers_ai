export default {
  async fetch(request, env, ctx) {
    // 处理 CORS 预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // 验证 API Key
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({
        error: { message: 'API key required', type: 'invalid_request_error', code: 'invalid_api_key' }
      }), { status: 401, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }

    const apiKey = authHeader.substring(7);
    const validApiKeys = env.VALID_API_KEYS ? env.VALID_API_KEYS.split(',') : ['your-api-key-here'];
    if (!validApiKeys.includes(apiKey)) {
      return new Response(JSON.stringify({
        error: { message: 'Invalid API key', type: 'invalid_request_error', code: 'invalid_api_key' }
      }), { status: 401, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }

    const url = new URL(request.url);

    // 模型映射
    const modelMap = {
      'deepseek-r1': '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
      'gpt-oss-120b': '@cf/openai/gpt-oss-120b',
      'gpt-oss-20b': '@cf/openai/gpt-oss-20b',
      'llama-4-scout': '@cf/meta/llama-4-scout-17b-16e-instruct',
      'qwen2.5-coder': '@cf/qwen/qwen2.5-coder-32b-instruct',
      'gemma-3': '@cf/google/gemma-3-12b-it'
    };

    // 聊天接口
    if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
      try {
        const body = await request.json();
        if (!body.messages || !Array.isArray(body.messages)) {
          return new Response(JSON.stringify({
            error: { message: 'Messages must be an array', type: 'invalid_request_error', code: 'invalid_parameter' }
          }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
        }

        const model = body.model || 'deepseek-r1';
        const cfModel = modelMap[model];
        if (!cfModel) {
          return new Response(JSON.stringify({
            error: { message: `Model '${model}' not supported`, type: 'invalid_request_error', code: 'model_not_found' }
          }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
        }

        // 构造 AI 请求参数
        let aiRequest = {};
        let useResponsesAPI = cfModel.startsWith('@cf/openai/gpt-oss');

        if (useResponsesAPI) {
          // Responses API 格式
          const systemMsg = body.messages.find(m => m.role === 'system')?.content || "You are a helpful assistant.";
          const userMsgs = body.messages.filter(m => m.role === 'user').map(m => m.content).join("\n");

          aiRequest = {
            input: userMsgs,
            instructions: systemMsg,
            temperature: body.temperature ?? 0.7,
            top_p: body.top_p ?? 0.9,
            max_tokens: body.max_tokens ?? 2048,
            reasoning: body.reasoning ?? { effort: "medium" }
          };
        } else {
          // 旧模型：拼接 prompt
          let prompt = '';
          for (const message of body.messages) {
            if (message.role === 'system') prompt += `System: ${message.content}\n\n`;
            if (message.role === 'user') prompt += `User: ${message.content}\n\n`;
            if (message.role === 'assistant') prompt += `Assistant: ${message.content}\n\n`;
          }
          prompt += 'Assistant: ';

          aiRequest = {
            prompt,
            temperature: body.temperature ?? 0.7,
            top_p: body.top_p ?? 0.9,
            max_tokens: body.max_tokens ?? 4096,
          };
        }

        // 调用 Cloudflare AI
        const response = await env.AI.run(cfModel, aiRequest);

        const completionId = 'chatcmpl-' + Math.random().toString(36).substring(2, 15);
        const timestamp = Math.floor(Date.now() / 1000);

        // 获取最终回答内容
        let assistantContent = "";
        if (useResponsesAPI) {
          if (response.output && Array.isArray(response.output)) {
            assistantContent = response.output
              .flatMap(msg => msg.content
                .filter(c => c.type === "output_text")
                .map(c => c.text)
              )
              .join("\n");
          }
        } else {
          assistantContent = response.response ?? "";
        }
        

        // 流式输出
        if (body.stream) {
          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            start(controller) {
              // 开始事件
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                id: completionId,
                object: 'chat.completion.chunk',
                created: timestamp,
                model,
                choices: [{ index: 0, delta: { role: 'assistant', content: "" }, finish_reason: null }]
              })}\n\n`));

              // 模拟逐块输出
              const chunkSize = 20;
              for (let i = 0; i < assistantContent.length; i += chunkSize) {
                const chunk = assistantContent.slice(i, i + chunkSize);
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created: timestamp,
                  model,
                  choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }]
                })}\n\n`));
              }

              // 结束事件
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
            headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' },
          });
        }

        // 非流式输出
        const chatCompletion = {
          id: completionId,
          object: 'chat.completion',
          created: timestamp,
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: assistantContent }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: Math.ceil(JSON.stringify(body.messages).length / 4),
            completion_tokens: Math.ceil(assistantContent.length / 4),
            total_tokens: Math.ceil((JSON.stringify(body.messages).length + assistantContent.length) / 4)
          }
        };
        return new Response(JSON.stringify(chatCompletion), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

      } catch (error) {
        console.error('Error:', error);
        return new Response(JSON.stringify({
          error: { message: 'Internal server error', type: 'server_error', code: 'internal_error' }
        }), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      }
    }

    // 模型列表
    if (url.pathname === '/v1/models' && request.method === 'GET') {
      const models = Object.keys(modelMap).map(id => ({
        id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'cloudflare',
        permission: [{ id: 'modelperm-' + id, object: 'model_permission', created: Math.floor(Date.now() / 1000), allow_create_engine: false, allow_sampling: true, allow_logprobs: false, allow_search_indices: false, allow_view: true, allow_fine_tuning: false, organization: '*', group: null, is_blocking: false }]
      }));
      return new Response(JSON.stringify({ object: 'list', data: models }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }

    // 健康检查
    if (url.pathname === '/health' && request.method === 'GET') {
      return new Response(JSON.stringify({ status: 'healthy', timestamp: new Date().toISOString(), models: Object.keys(modelMap) }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }

    // 404
    return new Response(JSON.stringify({
      error: { message: 'Not found', type: 'invalid_request_error', code: 'not_found' }
    }), { status: 404, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  },
};
