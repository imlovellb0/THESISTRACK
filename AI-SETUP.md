# Turning on the AI features (free)

ThesisTrack has one AI helper, the grammar suggestions. It needs a free AI key.

| Feature | Where | Needs a key? |
| --- | --- | --- |
| Grammar suggestions | "AI check" link next to every uploaded version (students, advisers, coordinator) | Yes |

## Option 1: Google Gemini free tier (easiest)
1. Sign in at https://aistudio.google.com/apikey with any Google account and press **Create API key**. No credit card is needed.
2. Open the `.env` file in this folder and add a line: `GEMINI_API_KEY=your-key-here`
3. Optional: `GEMINI_MODEL=gemini-3.8-flash`. If Google retires a model, pick another free one in AI Studio and put its name here.
4. Restart ThesisTrack.

The free tier has daily limits. When they are used up the app says so and works again later. Google may use free-tier prompts to improve its products, so do not use the AI checks on work that must stay private.

## Option 2: Ollama (runs on your own computer, nothing leaves it)
1. Install Ollama from https://ollama.com and run `ollama pull qwen2.5:3b` (a small model; bigger ones need more RAM).
2. In `.env` add: `OLLAMA_MODEL=qwen2.5:3b`
3. Restart ThesisTrack. If both are set, Gemini is used.
