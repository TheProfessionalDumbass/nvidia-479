
// server.js - STRICT OpenAI-Compatible Proxy for NVIDIA NIM API
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// NVIDIA NIM API configuration
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// Default fallback model (always available)
const DEFAULT_NIM_MODEL = 'meta/llama-3.1-70b-instruct';

// Model mapping - JanitorAI sends these exact model names
const MODEL_MAPPING = {
  'gpt-3.5-turbo': 'meta/llama-3.1-8b-instruct',
  'gpt-4': 'meta/llama-3.1-70b-instruct',
  'gpt-4-turbo': 'meta/llama-3.1-405b-instruct',
  'gpt-4o': 'meta/llama-3.1-405b-instruct',
  'gpt-4o-mini': 'meta/llama-3.1-8b-instruct',
  'claude-3-opus': 'meta/llama-3.1-405b-instruct',
  'claude-3-sonnet': 'meta/llama-3.1-70b-instruct',
  'claude-3-haiku': 'meta/llama-3.1-8b-instruct',
  'gemini-pro': 'meta/llama-3.1-70b-instruct'
};

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'OpenAI-Compatible NVIDIA NIM Proxy'
  });
});

// List models endpoint (OpenAI compatible)
app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(model => ({
    id: model,
    object: 'model',
    created: 1677610602,
    owned_by: 'openai'
  }));
  
  res.json({
    object: 'list',
    data: models
  });
});

// STRICT OpenAI-compatible chat completions endpoint
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;
    
    // ✅ FIX #1: Validate model parameter (CRITICAL for JanitorAI)
    if (!model || typeof model !== 'string') {
      return res.status(400).json({
        error: {
          message: 'you must provide a model parameter',
          type: 'invalid_request_error',
          param: 'model',
          code: null
        }
      });
    }
    
    // ✅ FIX #2: Validate messages parameter
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: {
          message: 'messages is required and must be a non-empty array',
          type: 'invalid_request_error',
          param: 'messages',
          code: null
        }
      });
    }
    
    // ✅ FIX #3: Graceful model mapping with guaranteed fallback
    let nimModel = MODEL_MAPPING[model] || DEFAULT_NIM_MODEL;
    
    // Build NIM request
    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature !== undefined ? temperature : 0.7,
      max_tokens: max_tokens || 2048,
      stream: stream || false
    };
    
    // Make request to NVIDIA NIM API
    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json'
    });
    
    if (stream) {
      // ✅ FIX #4: STRICT OpenAI SSE format (critical for JanitorAI)
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      let buffer = '';
      
      response.data.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        lines.forEach(line => {
          if (line.startsWith('data: ')) {
            if (line.includes('[DONE]')) {
              res.write('data: [DONE]\n\n');
              return;
            }
            
            try {
              const nimData = JSON.parse(line.slice(6));
              
              // Transform to STRICT OpenAI format (no extra fields!)
              const openaiChunk = {
                id: `chatcmpl-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: model,
                choices: [{
                  index: 0,
                  delta: {
                    role: nimData.choices?.[0]?.delta?.role,
                    content: nimData.choices?.[0]?.delta?.content || ''
                  },
                  finish_reason: nimData.choices?.[0]?.finish_reason || null
                }]
              };
              
              // Remove undefined fields (JanitorAI is strict about this)
              if (!openaiChunk.choices[0].delta.role) {
                delete openaiChunk.choices[0].delta.role;
              }
              
              res.write(`data: ${JSON.stringify(openaiChunk)}\n\n`);
            } catch (e) {
              console.error('Stream parse error:', e);
            }
          }
        });
      });
      
      response.data.on('end', () => {
        res.write('data: [DONE]\n\n');
        res.end();
      });
      
      response.data.on('error', (err) => {
        console.error('Stream error:', err);
        res.end();
      });
      
    } else {
      // ✅ FIX #5: STRICT OpenAI response format (non-streaming)
      const openaiResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: response.data.choices?.[0]?.message?.content || ''
          },
          finish_reason: response.data.choices?.[0]?.finish_reason || 'stop'
        }],
        usage: {
          prompt_tokens: response.data.usage?.prompt_tokens || 0,
          completion_tokens: response.data.usage?.completion_tokens || 0,
          total_tokens: response.data.usage?.total_tokens || 0
        }
      };
      
      res.json(openaiResponse);
    }
    
  } catch (error) {
    console.error('Proxy error:', error.response?.data || error.message);
    
    // ✅ FIX #6: STRICT OpenAI error format
    const statusCode = error.response?.status || 500;
    const errorMessage = error.response?.data?.error?.message || error.message || 'Internal server error';
    
    res.status(statusCode).json({
      error: {
        message: errorMessage,
        type: 'invalid_request_error',
        param: null,
        code: statusCode
      }
    });
  }
});

// Catch-all for unsupported endpoints
app.all('*', (req, res) => {
  res.status(404).json({
    error: {
      message: `Unknown request URL: ${req.method} ${req.path}`,
      type: 'invalid_request_error',
      param: null,
      code: null
    }
  });
});

app.listen(PORT, () => {
  console.log(`✅ Strict OpenAI-Compatible Proxy running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
  console.log(`🔑 NVIDIA API Key: ${NIM_API_KEY ? 'SET' : 'MISSING!'}`);
});
