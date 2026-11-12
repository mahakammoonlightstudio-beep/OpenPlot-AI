---
title: Ekspor
summary: Markdown, teks biasa, EPUB, dan library utuh yang portabel.
order: 12
---

# Ekspor

## Chat
- **Markdown** — seluruh percakapan dengan peran dan waktu.
- **JSON** — pesan plus metadata, untuk diolah di tempat lain.
- Keduanya tersedia dari palette (`Ctrl+K`) dan header chat.

## Bab dan proyek
Proyek diekspor sebagai satu file Markdown atau EPUB, bab berurutan, dengan story bible sebagai lampiran bila diminta.

## Library utuh
[[settings:data]] → **Ekspor salinan portabel** menulis satu `.db` berisi semua chat, proyek, entri story bible, bab, lampiran, prompt, gaya, skill, dan pengaturan. Di mesin lain, pakai **Impor .db** lalu tekan **Pakai** untuk membukanya.

Beberapa hal sengaja tidak ikut: kunci API provider dan kunci web-search (vault OS mengikatnya ke mesin ini, jadi masukkan ulang setelah impor), variabel lingkungan MCP (sering berisi token), dan approval eksekusi plugin/MCP yang tersimpan. Snapshot Time Machine juga bukan bagian dari file ini.

> Ini salinan, bukan sinkronisasi. Impor menambahkan library terpisah dan tidak pernah menggabung atau menimpa library yang sedang terbuka.

> Ekspor sebelum upgrade versi. Biayanya satu klik dan itu satu-satunya backup yang tidak dibuat aplikasi untukmu.
