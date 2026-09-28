# Data files

- platforms.json — platform patterns and metadata for scans.
- prompt_profile.txt — LLM prompt template used by the profile search and analysis flow (Ollama/OpenAI modes).

## Editing prompt_profile.txt
- Update the text to change how summaries are generated. Keep it concise; the app appends username/email and profile hits automatically.
- Save with UTF-8 encoding. Avoid very long lines; under ~200 words is recommended.
- Restart the backend (uvicorn) after edits so the new prompt is loaded.

## Editing platforms.json
- Add or adjust platform entries carefully; keep JSON valid.
- Optionally back up before large changes. A malformed JSON will prevent the app from loading platform data.
