---
title: Ekspor
summary: Markdown, teks biasa, backup JSON, dan EPUB.
order: 12
---

# Ekspor

## Chat
- **Markdown** — seluruh percakapan dengan peran dan waktu.
- **JSON** — pesan plus metadata, untuk diolah di tempat lain.
- Keduanya tersedia dari palette (`Ctrl+K`) dan header chat.

## Bab dan proyek
Proyek diekspor sebagai satu file Markdown atau EPUB, bab berurutan, dengan story bible sebagai lampiran bila diminta.

## Backup penuh
[[settings:data]] mengekspor semuanya sebagai JSON: chat, proyek, story bible, bab, prompt, gaya, skill, pengaturan. API key tidak disertakan.

Restore bersifat merge, bukan replace: baris dengan id sama diperbarui, baris baru ditambahkan, tidak ada yang dihapus.

> Ekspor sebelum upgrade versi. Biayanya satu klik dan itu satu-satunya backup yang tidak dibuat aplikasi untukmu.
