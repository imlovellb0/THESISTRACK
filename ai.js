// Free AI for grammar suggestions and the chatbot. Nothing here costs money:
//   GEMINI_API_KEY  - a free key from https://aistudio.google.com/apikey (the free tier has daily limits)
//   GEMINI_MODEL    - optional, default gemini-3.8-flash. Change it if Google retires the model.
//   OLLAMA_MODEL    - optional alternative that runs on this computer (https://ollama.com), e.g. qwen2.5:3b
//   OLLAMA_URL      - optional, default http://localhost:11434
// Gemini is used when a key is set, otherwise Ollama when a model is set. With neither, the AI features say they are off.

const TIMEOUT_MS = 60_000;

function provider() {
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.OLLAMA_MODEL) return 'ollama';
  return null;
}

class AiError extends Error {}

async function post(url, body, headers = {}, attempt = 0) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new AiError(e.name === 'TimeoutError' ? 'The AI took too long to answer. Try again.' : 'Could not reach the AI service. Check the internet connection (or that Ollama is running).');
  }
  // 503 means the free model is busy for a moment, so wait briefly and try again (twice at most).
  if (res.status === 503 && attempt < 2) {
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    return post(url, body, headers, attempt + 1);
  }
  if (res.status === 503) throw new AiError('The free AI is very busy right now. Try again in a minute.');
  if (res.status === 429) throw new AiError('The free AI limit was reached for now. Wait a minute (or until tomorrow) and try again.');
  if (!res.ok) {
    console.error('AI error', res.status, (await res.text()).slice(0, 300));
    throw new AiError(res.status === 400 || res.status === 403 ? 'The AI key or model setting was refused. Check GEMINI_API_KEY and GEMINI_MODEL in .env.' : 'The AI service had a problem. Try again later.');
  }
  return res.json();
}

// messages: [{ role: 'user' | 'assistant', content }]. Returns the reply text. json: true asks for a JSON answer.
async function chat({ system, messages, json = false, maxTokens = 1500 }) {
  const p = provider();
  if (!p) throw new AiError('The AI features are not switched on yet. Ask the coordinator to add a free AI key (see AI-SETUP.md).');

  if (p === 'gemini') {
    const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
    const data = await post(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        systemInstruction: { parts: [{ text: system }] },
        contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        generationConfig: { temperature: json ? 0.2 : 0.5, maxOutputTokens: maxTokens, ...(json ? { responseMimeType: 'application/json' } : {}) },
      },
      { 'x-goog-api-key': process.env.GEMINI_API_KEY }
    );
    const text = data.candidates?.[0]?.content?.parts?.map((x) => x.text || '').join('').trim();
    if (!text) throw new AiError('The AI gave no answer. Try rephrasing, or try again.');
    return text;
  }

  const data = await post(`${process.env.OLLAMA_URL || 'http://localhost:11434'}/api/chat`, {
    model: process.env.OLLAMA_MODEL,
    stream: false,
    ...(json ? { format: 'json' } : {}),
    options: { temperature: json ? 0.2 : 0.5, num_predict: maxTokens },
    messages: [{ role: 'system', content: system }, ...messages],
  });
  const text = data.message?.content?.trim();
  if (!text) throw new AiError('The AI gave no answer. Try again.');
  return text;
}

module.exports = { chat, provider, AiError };
