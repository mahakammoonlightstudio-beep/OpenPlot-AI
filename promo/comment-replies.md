# Template balasan komentar

Balasan siap pakai untuk pertanyaan yang paling sering muncul di X, YouTube,
Reddit dan LinkedIn. Aturan nada:

- Balas cepat di 24 jam pertama — itu jendela di mana algoritma mendorong post.
- Jawab pertanyaannya dulu, baru angkat fitur. Jangan tempel fitur ke orang yang
  cuma bilang "keren".
- Kritik teknis: akui yang benar, jelaskan trade-off-nya, tawarkan issue di GitHub.
- Jangan pernah berdebat soal "AI menulis itu bukan seni" — hormati pendapat,
  tawarkan bahwa app-nya juga jalan tanpa AI (story bible, chapter, stats).
- Bahasa: balas dengan bahasa yang dipakai komentator.

Daftar isi: [harga & gratis](#harga--gratis) · [privasi & data](#privasi--data) ·
["kenapa Electron?"](#kenapa-electron) · [model & provider](#model--provider) ·
[alat menulis](#alat-menulis) · [mac & instalasi](#mac--instalasi) ·
[b & bug request](#bug--feature-request) · [reaksi netral](#reaksi-netral) ·
[anti-AI](#anti-ai)

---

## Harga & gratis

**Q: "Free? What's the catch?" / "Gratis? Emangnya nggak ada tangkapan?"**

EN:

> No catch — it's MIT-licensed open source, so you can check exactly what the app does. There's no server to pay for: everything runs on your machine, and you bring your own AI key (or run a local model, which costs nothing at all). If you ever want to support development, there's a donate link in the README, but the app itself has no locked features.

ID:

> Nggak ada tangkapannya — open source lisensi MIT, jadi semua yang dilakukan app-nya bisa kamu audit sendiri. Nggak ada server yang harus saya bayar: semuanya jalan di komputermu, dan AI-nya pakai API key-mu sendiri (atau model lokal yang benar-benar nol biaya). Kalau mau dukung pengembangan ada link donate di README, tapi semua fitur terbuka tanpa bayar.

**Q: "How do you plan to make money?" / "Cara cari cuan-nya gimana?"**

EN:

> Honest answer: donations, and that's it for now. There's no subscription and no paid tier planned — the local-first design means there's no infrastructure bill that needs recouping. If the project grows, paid things would be optional extras (like hosted sync), never the core app.

ID:

> Jawaban jujur: donasi, dan untuk sekarang itu saja. Nggak ada rencana langganan atau tier berbayar — desain local-first artinya nggak ada tagihan server yang harus ditutup. Kalau proyeknya tumbuh, hal berbayar bakal berupa ekstra opsional (misalnya sync), bukan app intinya.

## Privasi & data

**Q: "Does it send my writing anywhere?" / "Naskah saya dikirim ke mana-mana nggak?"**

EN:

> Only to the AI provider you configure, and only the text you explicitly put in a prompt. The app itself has no telemetry, no analytics, and no cloud storage — the SQLite database lives in your OS user-data folder. If your provider is Ollama on localhost, nothing leaves your machine at all.

ID:

> Hanya ke provider AI yang kamu set sendiri, dan hanya teks yang kamu kirim lewat prompt. App-nya sendiri tanpa telemetry, tanpa analytics, tanpa cloud — database SQLite-nya ada di folder user-data OS-mu. Kalau provider-nya Ollama di localhost, tidak ada satu byte pun yang keluar dari komputermu.

**Q: "Where are API keys stored?" / "API key disimpan di mana?"**

EN:

> Encrypted at rest with your OS credential vault — DPAPI on Windows, Keychain on macOS, libsecret on Linux. They never touch the SQLite database in plaintext.

ID:

> Dienkripsi pakai credential vault OS — DPAPI di Windows, Keychain di macOS, libsecret di Linux. Key tidak pernah tersimpan sebagai teks biasa di database.

## Kenapa Electron?

**Q: "Why Electron? Why not Tauri/native?" / "Kenapa Electron? Bukannya Tauri lebih ringan?"**

EN:

> Fair question — the bundle is bigger and RAM usage is higher than a native app. I chose Electron because the whole UI is React (a stack I can iterate on fast as a solo dev), SQLite and the EPUB builder work reliably there, and one codebase ships to all three OSes. A Tauri port is possible later since the main-process logic is mostly plain TypeScript — but I'd rather ship features people ask for first.

ID:

> Pertanyaan wajar — ukuran bundle dan RAM memang lebih besar dibanding app native. Saya pilih Electron karena UI-nya React (stack yang bisa saya gerakkan cepat sebagai solo dev), SQLite dan builder EPUB jalan mulus di sana, dan satu codebase untuk tiga OS. Port ke Tauri mungkin nanti karena logika main-process-nya kebanyakan TypeScript polos — tapi sekarang prioritasku fitur yang diminta user.

**Q: "Another Electron app, sigh."**

EN:

> Fair. If it helps: the renderer bundle is ~500 kB (highlight.js is trimmed to 13 languages), streaming markdown renders on animation frames, and every feature works offline. Judge it by how it feels, not by the runtime.

ID:

> Wajar. Kalau membantu: bundle renderer ~500 kB (highlight.js dipangkas ke 13 bahasa), markdown streaming di-render per animation frame, dan semua fitur jalan offline. Nilai dari pengalamannya, bukan dari runtime-nya.

## Model & provider

**Q: "Do I need to pay for ChatGPT to use it?" / "Harus langganan ChatGPT?"**

EN:

> No subscription needed — you paste an API key from any provider (OpenAI, Anthropic, OpenRouter, Groq) and pay their per-token rates, which are usually far cheaper than a monthly subscription for light use. Or run Ollama/LM Studio locally and pay nothing.

ID:

> Nggak perlu langganan — kamu tempel API key dari provider mana pun (OpenAI, Anthropic, OpenRouter, Groq) dan bayar tarif per-token mereka, yang biasanya jauh lebih murah dari langganan bulanan untuk pemakaian ringan. Atau jalan pakai Ollama/LM Studio lokal dan bayar nol.

**Q: "Does it work with [insert model]?" / "Bisa pakai model [X]?"**

EN:

> If it has an OpenAI-compatible `/v1` endpoint or is one of the built-in providers, yes. That covers Ollama, LM Studio, llama.cpp server, vLLM, and most aggregators. If you find one that doesn't work, open an issue with the endpoint format and I'll take a look.

ID:

> Kalau endpoint-nya OpenAI-compatible `/v1` atau termasuk provider bawaan, bisa. Itu mencakup Ollama, LM Studio, llama.cpp server, vLLM, dan kebanyakan aggregator. Kalau ada yang tidak jalan, buka issue dengan format endpoint-nya, nanti saya cek.

## Alat menulis

**Q: "Can the AI see my whole story automatically?" / "AI-nya bisa baca seluruh cerita otomatis?"**

EN:

> Not automatically — you control the context. @-mention story-bible entries or chapters to pull them in, bind a chat to a project so memories apply, and a context guard trims oldest turns if you exceed the window. Nothing is silently uploaded behind your back.

ID:

> Tidak otomatis — kamu yang kontrol konteksnya. @-mention entri story bible atau chapter untuk memasukkannya, bind chat ke project supaya memori berlaku, dan context guard memangkas turn tertua kalau melebihi context window. Tidak ada yang diunggah diam-diam.

**Q: "What happens if I disagree with an AI edit to my chapter?" / "Kalau edit AI-nya jelek gimana?"**

EN:

> Every AI append is preceded by an automatic version snapshot — open the chapter's History, see the diff, restore in one click. The last 30 snapshots per chapter are kept.

ID:

> Setiap append AI didahului snapshot versi otomatis — buka History di chapter, lihat versinya, restore satu klik. 30 snapshot terakhir per chapter disimpan.

## Mac & instalasi

**Q: "'App is damaged' / Gatekeeper warning on macOS?"**

EN:

> The builds are unsigned (code signing certificates cost money the project doesn't have yet), so macOS flags them. Right-click the app → Open the first time, or run `xattr -cr /Applications/OpenPlot\ AI.app`. That's a one-time thing.

ID:

> Build-nya belum ditandatangani (sertifikat code signing mahal untuk proyek sebesar ini sekarang), jadi macOS menandainya. Klik kanan app → Open saat pertama, atau jalankan `xattr -cr /Applications/OpenPlot\ AI.app`. Cuma sekali saja.

**Q: "Is there a mobile version?" / "Ada versi HP?"**

EN:

> Not yet — it's a desktop app for Windows, macOS and Linux. Mobile would require rethinking the whole three-pane layout; not saying never, but it's not on the near roadmap.

ID:

> Belum — ini app desktop untuk Windows, macOS, dan Linux. Versi HP butuh redesign layout tiga panel dari nol; bukan bilang tidak akan pernah, tapi bukan peta jalan terdekat.

## Bug / feature request

**Q: "It crashes / X doesn't work."**

EN:

> Sorry about that — could you tell me your OS version and what you did right before it happened? Best is to open a GitHub issue (link in bio/repo) so it doesn't get lost in comments. I read all of them.

ID:

> Maaf soal itu — boleh tahu versi OS-mu dan apa yang dilakukan tepat sebelum terjadi? Paling bagus buka issue di GitHub (link di bio/repo) supaya laporannya tidak tenggelam di komentar. Semua saya baca.

**Q: "Can you add [feature]?"**

EN:

> Love concrete suggestions — drop it as a GitHub issue so it's trackable, and tell me the *problem* you're trying to solve, not just the feature. Some of the best parts (version history, the context guard) came from exactly these conversations.

ID:

> Saya suka saran konkret — tulis sebagai issue di GitHub supaya terlacak, dan ceritakan *masalah* yang mau kamu selesaikan, bukan cuma fiturnya. Beberapa fitur terbaik (version history, context guard) lahir dari percakapan seperti ini.

## Reaksi netral

**"Cool!" / "Keren!"**

EN:

> Thanks! If you try it, the story bible + @-mentions combo is the part most people don't realize they needed. Feedback welcome.

ID:

> Terima kasih! Kalau dicoba, kombinasi story bible + @-mentions itu bagian yang paling sering bikin orang baru sadar butuh. Feedback ditunggu.

**"Inspiring, I want to build something too." / "Keren, aku juga mau bikin app."**

EN:

> Do it — the best motivator is scratching your own itch. Happy to answer stack questions (Electron, React, SQLite, sql.js) if you ever get stuck.

ID:

> Gas — motivator terbaik adalah menggaruk gatal sendiri. Kalau nanti macet soal stack (Electron, React, SQLite, sql.js), happy untuk jawab.

## Anti-AI

**"AI writing is ruining creativity." / "AI nulis itu merusak kreativitas."**

EN:

> That's a fair position and I won't argue it. For what it's worth, the app works fine as a plain organizer too — story bible, chapters, version history and stats don't need any AI at all. The chat is optional, not the point.

ID:

> Posisi yang wajar dan saya tidak akan debat. Sekadar info, app-nya juga jalan sebagai organizer biasa — story bible, chapter, version history, dan stats tidak butuh AI sama sekali. Chat-nya opsional, bukan intinya.
