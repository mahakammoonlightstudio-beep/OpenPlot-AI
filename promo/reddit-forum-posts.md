# Reddit & forum posts

Reddit membenci iklan. Post yang berhasil di sana terdengar seperti orang
berbagi proyek, bukan menjual produk. Aturan singkat:

- **Jangan cross-post teks X/LinkedIn.** Tulis ulang dengan nada percakapan.
- **Ikut aturan subreddit.** Banyak subreddit (mis. r/writing) melarang promosi
  langsung — di sana pakai varian "feedback request" dan sebutkan link hanya
  saat ditanya atau di komentar, sesuai aturan masing-masing sub.
- **Berdiarkan di komentar.** 80% nilai post ada di thread komentar. Jawab
  semua pertanyaan teknis dengan jujur (termasuk "kenapa Electron?").
- Akun yang belum pernah berkontribusi di sub tersebut akan dianggap spam
  lebih cepat — bengkokkan dulu dengan komentar biasa sebelum posting proyek.

Target subreddit yang cocok:

| Subreddit | Nada | Angles yang cocok |
| --- | --- | --- |
| r/SideProject | santai, show & tell | "I built this" penuh, link bebas |
| r/opensource | teknis-ramah | rilis, lisensi MIT, local-first |
| r/LocalLLaMA | sangat teknis | Ollama/LM Studio, tanpa cloud |
| r/writing | komunitas, aturan ketat | varian feedback, cek rules dulu |
| r/InteractiveFiction / r/worldbuilding | niche | story bible & worldbuilding |
| r/electronjs | developer | stack, arsitektur, EPUB via zlib |

---

## Reddit (English) — r/SideProject style

**Judul:**

> I got tired of writing stories across five browser tabs and a notes app, so I spent months building my own free writing studio

**Isi post:**

> The title is the honest version of the story: I kept losing plot notes, my character sheets lived in a doc I could never find, and every AI tool wanted a subscription. So I built the thing I wanted, and made it free.
>
> **OpenPlot AI** is a desktop app (Windows, macOS, Linux) that puts the AI chat and the actual writing tools in one place:
>
> - Chat with any provider: OpenAI, Anthropic, OpenRouter, Groq, or fully local models via Ollama and LM Studio. You bring your own API key and it's encrypted with the OS credential vault.
> - A story bible: worlds, characters, items, lore — tagged, searchable, linked, and @-mentionable so entries get pulled into the AI's context.
> - Chapters with draft/revising/done statuses, focus mode, and version history (auto-snapshots before every AI edit, 30 kept).
> - A three-act Story Flow board, writing streaks, a 90-day heatmap, and export to Markdown/TXT/EPUB.
>
> Everything is stored in a local SQLite database — no account, no cloud, no telemetry. MIT licensed, source on GitHub.
>
> What tripped me up technically (for the curious): building a chapter history system that snapshots before AI edits, assembling EPUBs with nothing but zlib, and making keyboard focus survive 17 different confirm dialogs. Happy to go deeper on any of it.
>
> Free download + source: https://github.com/mahakammoonlightstudio-beep/OpenPlot-AI/releases
>
> Brutal feedback welcome — especially on the writing tools, since that's the part I use daily.

---

## Reddit (English) — r/LocalLLaMA style (technical)

**Judul:**

> I built a local-first AI story studio that works entirely with Ollama/LM Studio — no cloud, no telemetry, MIT

**Isi post:**

> Most "AI writing apps" assume your manuscript and API keys should live on someone else's server. I wanted the opposite, so I built one that assumes nothing leaves your machine.
>
> Technical notes that might be relevant here:
>
> - Any OpenAI-compatible `/v1` endpoint works: Ollama, LM Studio, llama.cpp server, vLLM, or hosted APIs if you want them.
> - Thinking/reasoning display handles Anthropic extended thinking, DeepSeek-style `reasoning` fields, and raw `<think>` tags.
> - The agent can create/update/search story entries and chapters through tools, with a context guard that trims oldest turns when you exceed the model's context window (transcript itself is never modified).
> - Storage is SQLite via sql.js in the OS user-data dir; API keys go through DPAPI/Keychain/libsecret when available.
> - Rendering keeps up with streaming tokens (throttled markdown via rAF) even on long responses.
>
> Everything else — story bible, chapters with version history, three-act board, stats — works fully offline.
>
> Source + free binaries (win/mac/linux): https://github.com/mahakammoonlightstudio-beep/OpenPlot-AI/releases
>
> Questions about the architecture welcome.

---

## Reddit (English) — r/writing style (feedback-first, ikuti aturan sub)

**Judul:**

> Writers who use AI for brainstorming: what would your ideal tool look like? (I built one and want feedback)

**Isi post:**

> I write fiction as a hobby and kept stitching together a chat window, a notes app, and a manuscript file. Eventually I built my own tool instead — but before I go further with it, I want to hear from actual writers what's missing.
>
> What I have so far: a story bible for characters/worlds/lore that the AI can actually reference when you mention it, chapters with version history, a three-act outline board, and stats like daily goals and streaks. The AI part works with any provider, including fully local models — there's no subscription and nothing is stored in the cloud.
>
> If you use AI while writing: what's the thing existing tools always get wrong for you? Structure? Memory of your story? Tone? I'm collecting real complaints, not validating my own assumptions.

*(Link tidak disertakan di post ini — taruh di komentar jika aturan sub mengizinkan, atau bagikan saat ada yang bertanya.)*

---

## Reddit (Bahasa Indonesia) — gaya umum (cocok untuk sub/ID dev community, forum Kaskus/FB group dev)

**Judul:**

> Saya bosan nulis cerita pake lima tab browser, jadi saya bikin sendiri studio menulisnya — gratis dan open source

**Isi post:**

> Cerita jujur: catatan plot ada di satu aplikasi, draf di aplikasi lain, lembar karakter di dokumen yang selalu hilang, dan semua tool AI minta langganan. Akhirnya saya putuskan bikin sendiri selama beberapa bulan. Hasilnya: OpenPlot AI.
>
> Ini aplikasi desktop (Windows, macOS, Linux) yang menggabungkan chat AI dengan alat menulis sungguhan:
>
> - Chat dengan provider apa saja: OpenAI, Anthropic, OpenRouter, Groq, atau model lokal lewat Ollama dan LM Studio. API key sendiri, dienkripsi di komputermu.
> - Story bible: dunia, karakter, item, lore — bisa diberi tag, dicari, dihubungkan, dan di-@-mention supaya masuk konteks AI.
> - Chapter dengan status draft/revising/done, focus mode, dan version history (snapshot otomatis sebelum setiap edit AI, disimpan 30).
> - Papan Story Flow tiga babak, streak menulis, heatmap 90 hari, dan ekspor ke Markdown/TXT/EPUB.
>
> Semua data di database SQLite lokal — tanpa akun, tanpa cloud, tanpa telemetry. Lisensi MIT, source ada di GitHub.
>
> Feedback kasar sangat ditunggu, apalagi soal alat menulisnya — itu bagian yang saya pakai setiap hari.
>
> Unduh gratis + source: https://github.com/mahakammoonlightstudio-beep/OpenPlot-AI/releases
